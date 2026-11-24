import WebSocket from 'ws';
import { closeSync, existsSync, mkdirSync, openSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { Meeting, NoteKind, Segment, ServerMessage } from '../src/core/protocol.ts';
import { settings } from './config.ts';
import { transcribePcm, geminiModelChain } from './gemini.ts';
import { transcribeLiveSegment } from './live-transcribe.ts';
import { pcmLevels, silenceReason } from './transcript-guard.ts';
import {
  emptySegment,
  imagesDir,
  isImageName,
  meetingDir,
  newNote,
  removeImage,
  saveMeeting,
  writeNotes,
  writeTranscript,
} from './store.ts';

const BYTES_PER_SEC = 32000; // 16000 Hz × 16-bit × 1ch
const MIN_SECTION_SECONDS = 20; // 太短的環節不切段，標籤併進當前段
const MAX_QUEUE_BYTES = 32000 * 300; // 每段最多緩衝 5 分鐘音訊
const MAX_EDIT_CHARS = 50_000; // 一段 280 秒的逐字稿約 1–2 千字，留足空間給補充

/** 邊錄邊寫的 wav；關檔時回頭補長度欄位，不需要整段放在記憶體。 */
class WavSink {
  private fd: number;
  private bytes = 0;

  private constructor(fd: number) {
    this.fd = fd;
  }

  static open(file: string): WavSink {
    mkdirSync(path.dirname(file), { recursive: true });
    const fd = openSync(file, 'w');
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(16000 * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    writeSync(fd, header);
    return new WavSink(fd);
  }

  write(chunk: Buffer): void {
    writeSync(this.fd, chunk);
    this.bytes += chunk.length;
  }

  close(): void {
    const patch = Buffer.alloc(4);
    // RIFF chunk size 在 offset 4，data chunk size 在 offset 40
    patch.writeUInt32LE(36 + this.bytes);
    writeSync(this.fd, patch, 0, 4, 4);
    patch.writeUInt32LE(this.bytes);
    writeSync(this.fd, patch, 0, 4, 40);
    closeSync(this.fd);
  }
}

/**
 * 一個錄音段 = 一條 Typeless WebSocket + 自己的待送佇列。
 * 佇列跟著段走，所以切段時舊連線還在握手也不會丟音訊。
 */
interface Channel {
  seg: Segment;
  ws: WebSocket | null;
  open: boolean;
  closing: boolean;
  queue: Buffer[];
  queueBytes: number;
  bytes: number;
}

interface Pending {
  promise: Promise<void>;
  resolve: () => void;
  timer: NodeJS.Timeout;
}

export class LiveSession {
  meeting: Meeting;
  private send: (msg: ServerMessage) => void;
  private channel: Channel | null = null;
  private nextLabel: string | null = null;
  private pausedAt: number | null = null;
  private pausedTotalMs = 0;
  private ticker: NodeJS.Timeout | null = null;
  private pending = new Map<Segment, Pending>();
  private closed = false;
  private lastEmit = 0;
  private sink: WavSink | null = null;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(meeting: Meeting, send: (msg: ServerMessage) => void) {
    this.meeting = meeting;
    this.send = send;
  }

  // ── 對外操作 ─────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.closed) throw new Error('這場會議已結束，請重新建立。');
    if (this.meeting.status === 'recording') return;

    const s = settings();
    // 還沒開始錄音的會議，跟著目前的設定走：使用者可能建立後才去填 key、換引擎。
    if (this.meeting.segments.length === 0) {
      this.meeting.engine = s.transcriber;
      this.meeting.transcribeModel = s.transcribeModel;
    }
    if (this.meeting.engine === 'typeless' && !s.typelessApiKey) {
      throw new Error('尚未設定 Typeless API key，請先到設定頁填入（或把轉錄引擎改成 Gemini）。');
    }
    if (this.meeting.engine === 'gemini' && !s.geminiApiKey) {
      throw new Error('尚未設定 Gemini API key，請先到設定頁填入（或把轉錄引擎改成 Typeless）。');
    }

    this.meeting.status = 'recording';
    this.pausedAt = null;
    this.startTicker();
    await saveMeeting(this.meeting);
    this.send({ type: 'meeting', meeting: this.meeting });
    this.emit();
  }

  async pause(): Promise<void> {
    if (this.meeting.status !== 'recording') return;
    this.detachCurrent();
    this.meeting.status = 'paused';
    this.pausedAt = Date.now();
    this.queuePersist();
    this.emit();
  }

  async resume(): Promise<void> {
    if (this.meeting.status !== 'paused') return;
    if (this.pausedAt) {
      this.pausedTotalMs += Date.now() - this.pausedAt;
      this.pausedAt = null;
    }
    this.meeting.status = 'recording';
    this.emit();
  }

  write(chunk: Buffer): void {
    if (this.closed || this.meeting.status !== 'recording') return;
    if (!this.channel) this.beginSegment(this.nextLabel);

    const ch = this.channel;
    if (!ch) return;

    ch.bytes += chunk.length;
    if (this.sink) this.sink.write(chunk);

    ch.queue.push(chunk);
    ch.queueBytes += chunk.length;
    while (ch.queueBytes > MAX_QUEUE_BYTES && ch.queue.length > 1) {
      const dropped = ch.queue.shift();
      ch.queueBytes -= dropped?.length ?? 0;
    }

    if (ch.open) this.flushChannel(ch);
    this.emitThrottled();
  }

  async addNote(kind: NoteKind, text: string, image?: string): Promise<void> {
    const cleaned = text.trim();
    let attached: string | undefined;
    if (image) {
      // 圖片要先經 POST /images 上傳；這裡只認我們產生的檔名、而且檔案真的在
      if (!isImageName(image) || !existsSync(path.join(imagesDir(this.meeting.id), image))) {
        throw new Error('找不到這張截圖，請重新貼一次');
      }
      if (this.meeting.notes.some((n) => n.image === image)) return; // 重送的同一則
      attached = image;
    }
    if (!cleaned && !attached) return;
    const note = newNote(kind, cleaned, this.elapsedSec(), this.channel?.seg.index ?? -1, attached);
    this.meeting.notes.push(note);
    this.send({ type: 'note', note });
    this.queuePersist();
    this.emit();
  }

  /** 刪一則筆記；有截圖就連檔案一起刪，才不會偷偷被送進摘要 */
  async deleteNote(id: string): Promise<void> {
    const note = this.meeting.notes.find((n) => n.id === id);
    if (!note) return;
    this.meeting.notes = this.meeting.notes.filter((n) => n.id !== id);
    if (note.image) await removeImage(this.meeting.id, note.image);
    this.send({ type: 'note-removed', id });
    this.queuePersist();
    this.emit();
  }

  async addSection(label: string): Promise<void> {
    const cleaned = label.trim();
    if (cleaned) await this.addNote('section', cleaned);
    await this.rotate('section', cleaned || undefined);
  }

  /**
   * 聽者在錄音頁直接校正逐字稿。只收「已經有結果」的段落：收音中／轉錄中的段落
   * 還沒有文字，改了也會被轉錄結果蓋掉。改完照常存檔，transcript.md 與摘要都會用改過的版本。
   */
  editTranscript(index: number, text: string): void {
    const seg = this.meeting.segments.find((s) => s.index === index);
    if (!seg) throw new Error(`找不到第 ${index + 1} 段`);
    if (seg.status !== 'done' && seg.status !== 'failed') {
      throw new Error(`第 ${index + 1} 段還在轉錄，等文字出來再改`);
    }
    const cleaned = text.replace(/\r\n?/g, '\n').replace(/\s+$/, '').slice(0, MAX_EDIT_CHARS);
    if (cleaned === seg.transcript) return;
    seg.transcript = cleaned;
    seg.edited = true;
    this.send({ type: 'segment', segment: seg });
    this.queuePersist();
  }

  /** 手動切段：不管這一段多短都切，讓使用者當下就能拿到逐字稿。 */
  async cut(): Promise<void> {
    await this.rotate('cut');
  }

  async end(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopTicker();
    if (this.pausedAt) {
      this.pausedTotalMs += Date.now() - this.pausedAt;
      this.pausedAt = null;
    }
    this.detachCurrent();
    // 一段最壞要重試＋換模型＋切半重送，留 3 分鐘給最後幾段收尾
    await this.waitAll(180_000);
    this.meeting.status = 'ended';
    this.meeting.endedAt = new Date().toISOString();
    this.closeSink();
    await saveMeeting(this.meeting);
    await writeTranscript(this.meeting);
    await writeNotes(this.meeting);
    this.send({ type: 'ended', meeting: this.meeting });
  }

  /**
   * 瀏覽器斷線（重新整理、關頁）時呼叫：把當前段收尾、存檔、停在 paused。
   * 重新連線後可以按「繼續收音」接著錄，不會丟掉整場會議。
   */
  async suspend(): Promise<void> {
    if (this.closed) return;
    this.stopTicker();
    this.detachCurrent();
    if (this.meeting.status === 'recording') this.meeting.status = 'paused';
    await this.waitAll(60_000);
    this.closeSink();
    await saveMeeting(this.meeting);
    await writeTranscript(this.meeting);
    await writeNotes(this.meeting);
    this.closed = true;
  }

  dispose(): void {
    this.stopTicker();
    this.closed = true;
  }

  state() {
    const seg = this.channel?.seg ?? null;
    return {
      status: this.meeting.status,
      recording: this.meeting.status === 'recording',
      elapsedSec: this.elapsedSec(),
      segmentIndex: seg?.index ?? -1,
      segmentLabel: seg?.label ?? this.nextLabel,
      segmentElapsedSec: this.channel ? Math.round(this.channel.bytes / BYTES_PER_SEC) : 0,
      billedSeconds: this.meeting.segments.reduce((sum, s) => sum + (s.billedSeconds ?? 0), 0),
      pendingSegments: this.pending.size,
      noteCount: this.meeting.notes.length,
    };
  }

  // ── 內部 ────────────────────────────────────────────────

  private elapsedSec(): number {
    const startMs = new Date(this.meeting.startedAt).getTime();
    const pausedNow = this.pausedAt ? Date.now() - this.pausedAt : 0;
    return Math.max(0, Math.round((Date.now() - startMs - this.pausedTotalMs - pausedNow) / 1000));
  }

  private startTicker(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      this.emit();
      const ch = this.channel;
      if (this.meeting.status !== 'recording' || !ch) return;
      const seconds = ch.bytes / BYTES_PER_SEC;
      if (seconds > 0 && seconds >= settings().autoSegmentSeconds) void this.rotate('auto');
    }, 1000);
  }

  private stopTicker(): void {
    if (!this.ticker) return;
    clearInterval(this.ticker);
    this.ticker = null;
  }

  private emit(): void {
    this.lastEmit = Date.now();
    this.send({ type: 'state', state: this.state() });
  }

  private emitThrottled(): void {
    if (Date.now() - this.lastEmit < 500) return;
    this.emit();
  }

  private async rotate(reason: 'auto' | 'section' | 'cut', label?: string): Promise<void> {
    if (this.meeting.status !== 'recording' && this.meeting.status !== 'paused') return;
    const ch = this.channel;

    if (!ch) {
      if (label) this.nextLabel = label;
      this.emit();
      return;
    }

    const seconds = ch.bytes / BYTES_PER_SEC;

    if (reason === 'section' && seconds < MIN_SECTION_SECONDS) {
      // 太短：不切，直接把標籤掛到當前段
      ch.seg.label = label ?? ch.seg.label;
      this.send({ type: 'segment', segment: ch.seg });
      this.queuePersist();
      this.emit();
      return;
    }
    if (reason === 'auto' && seconds < 30) return;

    this.detachCurrent();
    this.nextLabel = reason === 'section' ? (label ?? null) : null;
    this.emit();
    // 新的一段等下一批音訊到了才開，避免產生空的連線
  }

  private detachCurrent(): void {
    const ch = this.channel;
    if (!ch) return;
    this.channel = null;
    ch.closing = true;

    ch.seg.status = 'finalizing';
    ch.seg.endedAt = new Date().toISOString();
    this.track(ch.seg);
    this.send({ type: 'segment', segment: ch.seg });

    if (ch.bytes === 0) {
      ch.seg.status = 'done';
      this.settle(ch.seg);
      return;
    }

    if (this.meeting.engine === 'gemini') {
      // Gemini 沒有串流：音訊都在 ch.queue，切段時一次轉錄。
      void this.transcribeGemini(ch);
      return;
    }

    if (ch.ws && ch.open) {
      this.flushChannel(ch);
      this.sendClose(ch);
      return;
    }

    if (!ch.ws || ch.ws.readyState === WebSocket.CONNECTING) {
      // 還在握手：等 open 之後把佇列送完再 close_stream
      return;
    }

    this.settle(ch.seg);
  }

  private beginSegment(label: string | null): void {
    const seg = emptySegment(this.meeting.segments.length, label, this.elapsedSec());
    this.meeting.segments.push(seg);
    this.nextLabel = null;

    if (this.meeting.keepAudio && !this.sink) {
      try {
        this.sink = WavSink.open(path.join(meetingDir(this.meeting.id), 'audio', 'mic.wav'));
      } catch (err) {
        this.sink = null;
        this.send({
          type: 'error',
          message: `保留原始錄音失敗（不影響轉錄）：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    const ch: Channel = { seg, ws: null, open: false, closing: false, queue: [], queueBytes: 0, bytes: 0 };
    this.channel = ch;
    if (this.meeting.engine === 'typeless') this.connect(ch);
    this.send({ type: 'segment', segment: seg });
    this.emit();
  }

  private connect(ch: Channel): void {
    const s = settings();
    const url = new URL(s.typelessWsUrl);
    url.searchParams.set('token', s.typelessApiKey);
    url.searchParams.set('model', this.meeting.transcribeModel);
    url.searchParams.set('sample_rate', '16000');
    url.searchParams.set('channels', '1');
    url.searchParams.set('encoding', 'pcm16');
    if (this.meeting.language) url.searchParams.set('language', this.meeting.language);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url.toString());
    } catch (err) {
      ch.seg.status = 'failed';
      ch.seg.error = err instanceof Error ? err.message : '無法連上 Typeless';
      this.send({ type: 'error', message: ch.seg.error });
      this.settle(ch.seg);
      return;
    }

    ch.ws = ws;

    ws.on('open', () => {
      ch.open = true;
      this.flushChannel(ch);
      if (ch.closing) this.sendClose(ch);
    });

    ws.on('message', (raw) => {
      this.onMessage(ch.seg, raw.toString());
    });

    ws.on('error', (err) => {
      ch.seg.error = err.message;
      this.send({ type: 'error', message: `Typeless 連線錯誤：${err.message}` });
    });

    ws.on('close', () => {
      ch.open = false;
      if (ch.seg.status !== 'done' && ch.seg.status !== 'failed') {
        ch.seg.status = ch.seg.transcript ? 'done' : 'failed';
        ch.seg.endedAt = ch.seg.endedAt ?? new Date().toISOString();
        if (!ch.seg.transcript) ch.seg.error = ch.seg.error ?? '連線中斷，這一段沒有取得逐字稿';
      }
      this.settle(ch.seg);
    });
  }

  private onMessage(seg: Segment, raw: string): void {
    let event: {
      type?: string;
      result?: { transcript?: string; duration_seconds?: number };
      usage?: { billed_audio_seconds?: number };
      error?: { code?: string; message?: string };
      request_id?: string;
    };
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }

    if (event.type === 'result') {
      seg.transcript = (event.result?.transcript ?? '').trim();
      seg.durationSeconds =
        typeof event.result?.duration_seconds === 'number' ? Math.round(event.result.duration_seconds) : null;
      seg.billedSeconds =
        typeof event.usage?.billed_audio_seconds === 'number' ? Math.round(event.usage.billed_audio_seconds) : null;
      seg.requestId = event.request_id ?? null;
      seg.status = 'done';
      seg.endedAt = seg.endedAt ?? new Date().toISOString();
      this.settle(seg);
      this.afterSegment(seg);
      return;
    }

    if (event.type === 'error') {
      seg.status = 'failed';
      seg.error = `[${event.error?.code ?? 'ERROR'}] ${event.error?.message ?? '轉錄失敗'}`;
      seg.endedAt = seg.endedAt ?? new Date().toISOString();
      this.send({ type: 'error', message: `第 ${seg.index + 1} 段失敗：${seg.error}` });
      this.settle(seg);
      this.afterSegment(seg);
    }
  }

  private afterSegment(seg: Segment): void {
    this.send({ type: 'segment', segment: seg });
    this.queuePersist();
    this.emit();
  }

  /** Gemini 路徑：切段時把整段 PCM 送出去，回來就是這一段的逐字稿。 */
  private async transcribeGemini(ch: Channel): Promise<void> {
    const seg = ch.seg;
    const pcm = Buffer.concat(ch.queue);
    ch.queue = [];
    ch.queueBytes = 0;

    // 麥克風沒收到聲音時 PCM 幾乎全是 0。Gemini 碰到靜音不會回空字串，而是自己編一份
    // 煞有其事的會議逐字稿（實測 11 秒數位靜音 → 「大家早安，我們現在開始今天的週會…」），
    // 所以先量音量，太安靜就跳過，寧可留白也不要假內容。
    const levels = pcmLevels(pcm);
    seg.audioRms = Number(levels.rms.toFixed(4));
    seg.audioPeak = Number(levels.p95.toFixed(4));
    const silent = silenceReason(levels);
    if (silent) {
      seg.transcript = '';
      seg.durationSeconds = Math.round(pcm.length / BYTES_PER_SEC);
      seg.status = 'failed';
      seg.error = `這段${silent}（音量 ${levels.rms.toFixed(4)}、講話時峰值 ${levels.p95.toFixed(3)}），麥克風或分享的音訊可能沒收到。已跳過轉錄，避免 Gemini 自己編一份假逐字稿。`;
      seg.endedAt = seg.endedAt ?? new Date().toISOString();
      this.send({
        type: 'error',
        message: `第 ${seg.index + 1} 段${silent}（音量 ${levels.rms.toFixed(4)}）：確認麥克風有沒有選錯或靜音。`,
      });
      this.settle(seg);
      this.afterSegment(seg);
      return;
    }

    const s = settings();
    // 重試、換模型、鬼打牆切半重送都在 transcribeLiveSegment() 裡（見 server/live-transcribe.ts）
    const primary = this.meeting.transcribeModel || s.transcribeModel;
    const chain = geminiModelChain(primary);
    try {
      const result = await transcribeLiveSegment(pcm, chain, {
        transcribe: (audio, model) =>
          transcribePcm(audio, { apiKey: s.geminiApiKey, model, language: this.meeting.language }),
        onNotice: (message) => this.send({ type: 'notice', message: `第 ${seg.index + 1} 段：${message}` }),
      });
      seg.transcript = result.text;
      seg.durationSeconds = Math.round(pcm.length / BYTES_PER_SEC);
      seg.billedSeconds = null; // Gemini 免費額度不按秒計價
      seg.requestId = null;
      seg.status = 'done';
      seg.endedAt = seg.endedAt ?? new Date().toISOString();
      if (result.trimmed) {
        this.send({
          type: 'notice',
          message: `第 ${seg.index + 1} 段模型卡在重複同一句，已砍掉重複的部分；中間可能漏幾句，可以直接在逐字稿上補。`,
        });
      }

      // 只有「每日額度用完」才改會議的主模型；503 臨時換的備援只用在這一段
      if (result.quotaExhausted.includes(primary)) {
        const next = chain.find((model) => !result.quotaExhausted.includes(model));
        if (next && next !== primary) {
          this.meeting.transcribeModel = next;
          this.queuePersist();
          this.send({
            type: 'notice',
            message: `${primary} 今天的額度用完了，第 ${seg.index + 1} 段起改用 ${next}（同一段音訊直接重送，沒有漏掉）。`,
          });
        }
      }
    } catch (err) {
      seg.status = 'failed';
      seg.error = err instanceof Error ? err.message : String(err ?? '轉錄失敗');
      seg.endedAt = seg.endedAt ?? new Date().toISOString();
      this.send({ type: 'error', message: `第 ${seg.index + 1} 段轉錄失敗：${seg.error}` });
    }

    this.settle(seg);
    this.afterSegment(seg);
  }

  private flushChannel(ch: Channel): void {
    if (!ch.ws || !ch.open) return;
    const frames = ch.queue;
    ch.queue = [];
    ch.queueBytes = 0;
    for (const frame of frames) {
      try {
        ch.ws.send(frame, { binary: true });
      } catch {
        break;
      }
    }
  }

  private sendClose(ch: Channel): void {
    if (!ch.ws || !ch.open) return;
    try {
      ch.ws.send(JSON.stringify({ type: 'close_stream' }));
    } catch {
      this.settle(ch.seg);
    }
  }

  private closeSink(): void {
    if (!this.sink) return;
    try {
      this.sink.close();
    } catch {
      // 忽略關檔錯誤
    }
    this.sink = null;
  }

  private track(seg: Segment): void {
    const timer = setTimeout(() => this.settle(seg), 150_000);
    let resolveFn: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      resolveFn = resolve;
    });
    this.pending.set(seg, { promise, resolve: resolveFn, timer });
  }

  private settle(seg: Segment): void {
    const item = this.pending.get(seg);
    if (!item) return;
    clearTimeout(item.timer);
    this.pending.delete(seg);
    item.resolve();
  }

  private async waitAll(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.pending.size > 0 && Date.now() < deadline) {
      const promises = [...this.pending.values()].map((p) => p.promise);
      await Promise.race([Promise.allSettled(promises), new Promise((resolve) => setTimeout(resolve, 200))]);
    }
  }

  private queuePersist(): void {
    this.persistChain = this.persistChain
      .then(async () => {
        await saveMeeting(this.meeting);
        await writeTranscript(this.meeting);
        await writeNotes(this.meeting);
      })
      .catch(() => {
        // 寫檔失敗不要中斷錄音
      });
  }
}
