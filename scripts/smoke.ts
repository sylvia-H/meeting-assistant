/**
 * 端到端煙霧測試：不需要真的 Typeless / Gemini / LLM key。
 * 用假的 Typeless WebSocket、假的 Gemini HTTP server 與 MOCK_LLM，跑完
 * 建立會議 → 送音訊 → 切段 → 筆記 → 結束 → 摘要 → 檢查檔案，兩條轉錄路徑都走一次。
 *
 *   npm run smoke
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const temp = mkdtempSync(path.join(os.tmpdir(), 'meeting-assistant-'));
const dataDir = path.join(temp, 'data');
const meetingsDir = path.join(temp, 'meetings');
const PORT = 8891;
const MOCK_PORT = 8899;
const GEMINI_PORT = 8898;
const BYTES_PER_FRAME = 3200; // 100 ms @ 16 kHz mono

mkdirSync(dataDir, { recursive: true });

process.env.MEETING_ASSISTANT_DATA_DIR = dataDir;
process.env.MOCK_LLM = '1';
process.env.TYPELESS_WS_URL = `ws://127.0.0.1:${MOCK_PORT}/stream`;
process.env.GEMINI_BASE_URL = `http://127.0.0.1:${GEMINI_PORT}`;
process.env.PORT = String(PORT);

writeFileSync(
  path.join(dataDir, 'settings.json'),
  `${JSON.stringify(
    {
      transcriber: 'typeless',
      typelessApiKey: 'tls_sk_smoke_test',
      typelessModel: 'typeless-1.0-pro',
      language: 'zh',
      llmProvider: 'anthropic',
      llmKeys: { anthropic: 'sk-ant-smoke' },
      llmModels: { anthropic: 'claude-sonnet-4-5' },
      meetingsDir,
      autoSegmentSeconds: 180,
      keepAudio: true,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function log(step: string): void {
  process.stdout.write(`  · ${step}\n`);
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`檢查失敗：${message}`);
  process.stdout.write(`  ✓ ${message}\n`);
}

// ── 假的 Typeless ─────────────────────────────────────────
let connectionSeq = 0;
const mock = new WebSocketServer({ port: MOCK_PORT });

mock.on('connection', (ws) => {
  connectionSeq += 1;
  const index = connectionSeq;
  let bytes = 0;
  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      bytes += (raw as Buffer).length;
      return;
    }
    const msg = JSON.parse(raw.toString()) as { type?: string };
    if (msg.type === 'close_stream') {
      const duration = bytes / 32000;
      ws.send(
        JSON.stringify({
          type: 'result',
          status: 'success',
          result: {
            transcript: `這是第 ${index} 段測試逐字稿。`,
            duration_seconds: duration,
            detected_language: 'zh',
          },
          usage: { billed_audio_seconds: Math.max(15, duration) },
          request_id: `req_${index}`,
        }),
      );
    }
  });
  ws.on('close', () => undefined);
});

// ── 假的 Gemini（generateContent） ────────────────────────
let geminiCalls = 0;
let geminiAudioCalls = 0;
const gemini = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    geminiCalls += 1;
    let audio = false;
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        contents?: { parts?: { inlineData?: { mimeType?: string } }[] }[];
      };
      audio = Boolean(
        body.contents?.[0]?.parts?.some((part) => part.inlineData?.mimeType?.startsWith('audio/')),
      );
    } catch {
      // 不是 JSON 就當成沒有音訊，讓測試自己失敗
    }
    if (audio) geminiAudioCalls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        candidates: [
          { content: { parts: [{ text: audio ? `這是第 ${geminiCalls} 段 Gemini 測試逐字稿。` : '沒有收到音訊。' }] } },
        ],
      }),
    );
  });
});
await new Promise<void>((resolve) => gemini.listen(GEMINI_PORT, '127.0.0.1', resolve));

// ── 啟動 app server（import 即監聽） ───────────────────────
await import('../server/index.ts');

const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 50; i += 1) {
  try {
    const res = await fetch(`${base}/api/settings`);
    if (res.ok) break;
  } catch {
    await sleep(100);
  }
}

async function request<T>(method: string, pathname: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${pathname} → ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

const post = <T>(pathname: string, body: unknown = {}): Promise<T> => request<T>('POST', pathname, body);
const put = <T>(pathname: string, body: unknown): Promise<T> => request<T>('PUT', pathname, body);

interface LiveEvent {
  type: string;
  [key: string]: unknown;
}

/** 一條 live WebSocket；每個會議各用一個，事件不會互相污染。 */
class LiveClient {
  readonly events: LiveEvent[] = [];
  private waiters: { test: (msg: LiveEvent) => boolean; resolve: (msg: LiveEvent) => void }[] = [];
  private ws: WebSocket;

  constructor(id: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/live/${id}`);
    this.ws.binaryType = 'arraybuffer';
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as LiveEvent;
      if (msg.type === 'error') process.stdout.write(`  ! 伺服器錯誤：${String(msg.message)}\n`);
      this.events.push(msg);
      for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
        const waiter = this.waiters[i];
        if (waiter && waiter.test(msg)) {
          this.waiters.splice(i, 1);
          waiter.resolve(msg);
        }
      }
    });
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', () => reject(new Error('連不上 live WebSocket')), { once: true });
    });
    await this.waitFor((m) => m.type === 'hello');
  }

  waitFor<T extends LiveEvent>(test: (msg: LiveEvent) => boolean, timeoutMs = 15000): Promise<T> {
    const found = this.events.find(test);
    if (found) return Promise.resolve(found as T);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待事件逾時')), timeoutMs);
      this.waiters.push({
        test,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg as T);
        },
      });
    });
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  async audio(frames: number): Promise<void> {
    const frame = new Uint8Array(BYTES_PER_FRAME);
    for (let i = 0; i < frames; i += 1) {
      this.ws.send(frame);
      if (i % 50 === 49) await sleep(5);
    }
  }

  close(): void {
    this.ws.close();
  }
}

process.stdout.write('\n會議助手 smoke test\n');

// ══ 第一場：Typeless ══════════════════════════════════════
const created = await post<{ meeting: { id: string; engine: string; transcribeModel: string } }>('/api/meetings', {
  title: '煙霧測試會議',
  startedAt: new Date().toISOString(),
  agenda: '驗證錄音 → 切段 → 筆記 → 摘要整條流程',
});
const id = created.meeting.id;
check(created.meeting.engine === 'typeless', '建立會議時記下轉錄引擎（Typeless）');
check(created.meeting.transcribeModel === 'typeless-1.0-pro', '建立會議時記下轉錄模型');
log(`建立會議 ${id}`);

const live = new LiveClient(id);
await live.connect();
log('WebSocket 已連線');

live.send({ type: 'start' });
await sleep(200);

await live.audio(250); // 25 秒，足夠觸發切段的 20 秒門檻
log('送出 25 秒音訊');

live.send({ type: 'section', label: '需求確認' });
await sleep(300);

await live.audio(200);
live.send({ type: 'note', kind: 'todo', text: '寄報價給 Amy' });
live.send({ type: 'note', kind: 'idea', text: '下次可以試著先寄 draft' });
log('送出環節標記與兩則筆記');

await live.audio(100);
live.send({ type: 'end' });

const ended = await live.waitFor<{
  type: string;
  meeting: { segments: unknown[]; notes: { kind: string; text: string }[] };
}>((m) => m.type === 'ended', 30000);
const noteKinds = ended.meeting.notes.map((n) => n.kind);
check(ended.meeting.notes.length === 3, `三次筆記事件都有存下來（實際 ${ended.meeting.notes.length}）`);
check(noteKinds.includes('section'), '環節標記存成 section 筆記');
check(noteKinds.includes('todo') && noteKinds.includes('idea'), '待辦與想法分類正確');
log(`會議結束，共 ${ended.meeting.segments.length} 段`);

const summarized = await post<{ markdown: string }>(`/api/meetings/${id}/summarize`);
check(summarized.markdown.includes('TL;DR'), '摘要含 TL;DR 段落');
check(summarized.markdown.includes('title: 煙霧測試會議'), '摘要含 YAML frontmatter');

const dir = path.join(meetingsDir, id);
for (const file of ['meeting.json', 'transcript.md', 'notes.md', 'minutes.md', 'audio/mic.wav']) {
  check(existsSync(path.join(dir, file)), `${file} 已產生`);
}

const transcript = readFileSync(path.join(dir, 'transcript.md'), 'utf8');
check(transcript.includes('第 1 段測試逐字稿'), '第一段逐字稿寫入 transcript.md');
check(transcript.includes('需求確認'), '環節名稱寫進逐字稿標題');

const wav = readFileSync(path.join(dir, 'audio', 'mic.wav'));
const totalAudioBytes = 550 * BYTES_PER_FRAME; // 250 + 200 + 100 框
check(wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE', 'wav 檔頭標籤正確');
check(wav.readUInt32LE(40) === totalAudioBytes, `wav data 長度正確（${wav.readUInt32LE(40)}）`);
check(wav.readUInt32LE(4) === 36 + totalAudioBytes, 'wav RIFF 長度正確');
check(wav.length === 44 + totalAudioBytes, 'wav 檔案大小 = 44 + 音訊');
check(wav.readUInt16LE(34) === 16 && wav.readUInt32LE(24) === 16000, 'wav 格式 16 kHz / 16-bit');

const notes = readFileSync(path.join(dir, 'notes.md'), 'utf8');
check(notes.includes('寄報價給 Amy'), '待辦寫進 notes.md');
live.close();

// ══ 第二場：Gemini（免費額度路徑） ═══════════════════════
const patched = await put<{
  transcriber: string;
  geminiKeySet: boolean;
  transcribeModel: string;
  ready: { transcriber: boolean; llm: boolean };
  geminiKeyHint: string;
}>('/api/settings', {
  transcriber: 'gemini',
  transcribeModel: 'gemini-2.5-flash',
  geminiApiKey: 'gemini-smoke-key',
  llmProvider: 'gemini',
  llmModel: { provider: 'gemini', value: 'gemini-2.5-flash' },
});
check(patched.transcriber === 'gemini', '設定可以切換成 Gemini');
check(patched.ready.transcriber, 'Gemini key 設定後轉錄就緒');
check(
  patched.geminiKeySet && patched.geminiKeyHint.startsWith('••••') && patched.geminiKeyHint !== 'gemini-smoke-key',
  '設定頁只回傳遮罩後的 key',
);
check(!JSON.stringify(patched).includes('gemini-smoke-key'), 'API 不會把完整 Gemini key 送到瀏覽器');

const created2 = await post<{ meeting: { id: string; engine: string; transcribeModel: string } }>('/api/meetings', {
  title: 'Gemini 轉錄測試',
  startedAt: new Date().toISOString(),
  agenda: '驗證 Gemini 音訊上傳 → 逐字稿落地',
});
const id2 = created2.meeting.id;
check(created2.meeting.engine === 'gemini', '建立會議時記下 Gemini 引擎');
check(created2.meeting.transcribeModel === 'gemini-2.5-flash', 'Gemini 會議記下轉錄模型');
log(`建立 Gemini 會議 ${id2}`);

const live2 = new LiveClient(id2);
await live2.connect();
live2.send({ type: 'start' });
await sleep(200);

await live2.audio(50); // 5 秒
live2.send({ type: 'cut' });
const seg1 = await live2.waitFor<{ type: string; segment: { status: string; transcript: string } }>(
  (m) => m.type === 'segment' && (m.segment as { status?: string }).status === 'done',
  20000,
);
check(seg1.segment.transcript.includes('Gemini 測試逐字稿'), 'Gemini 轉錄結果回填到 segments');

await live2.audio(50);
live2.send({ type: 'section', label: 'Gemini 環節' });
await sleep(200);
live2.send({ type: 'cut' });
const seg2 = await live2.waitFor<{ type: string; segment: { label: string; status: string } }>(
  (m) => m.type === 'segment' && (m.segment as { label?: string }).label === 'Gemini 環節' && (m.segment as { status?: string }).status === 'done',
  20000,
);
check(seg2.segment.label === 'Gemini 環節', 'Gemini 路徑的環節標籤正確');

live2.send({ type: 'end' });
const ended2 = await live2.waitFor<{
  type: string;
  meeting: { engine: string; segments: { transcript: string; billedSeconds: number | null }[] };
}>((m) => m.type === 'ended', 30000);
check(ended2.meeting.engine === 'gemini', '結束後的 meeting.json 仍是 Gemini 引擎');
check(ended2.meeting.segments.length === 2, `Gemini 會議切成 2 段（實際 ${ended2.meeting.segments.length}）`);
check(
  ended2.meeting.segments.every((s) => s.transcript.trim().length > 0),
  '兩段都有 Gemini 逐字稿',
);
check(
  ended2.meeting.segments.every((s) => s.billedSeconds === null),
  'Gemini 段落不記帳（billedSeconds 為 null）',
);
check(geminiAudioCalls === 2, `Gemini 收到 2 次音訊（實際 ${geminiAudioCalls}）`);

const dir2 = path.join(meetingsDir, id2);
const transcript2 = readFileSync(path.join(dir2, 'transcript.md'), 'utf8');
check(transcript2.includes('Gemini 測試逐字稿'), 'Gemini 逐字稿寫入 transcript.md');
check(transcript2.includes('轉錄模型：gemini-2.5-flash'), 'transcript.md 標明 Gemini 模型');
check(transcript2.includes('環節：Gemini 環節'), 'Gemini 逐字稿保留環節標題');
const meeting2 = JSON.parse(readFileSync(path.join(dir2, 'meeting.json'), 'utf8')) as {
  engine: string;
  transcribeModel: string;
};
check(meeting2.engine === 'gemini' && meeting2.transcribeModel === 'gemini-2.5-flash', 'meeting.json 存對引擎與模型');
live2.close();

process.stdout.write(`\n全部通過。測試資料在 ${temp}\n\n`);
mock.close();
gemini.close();
await sleep(200);
process.exit(0);
