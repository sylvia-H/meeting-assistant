/**
 * 把既有的錄音檔上傳到 Gemini Files API，轉成逐字稿。
 *
 *   node scripts/transcribe-file.ts "C:\path\to\recording.m4a" --meeting 2026-11-18-1400-xxx
 *   node scripts/transcribe-file.ts "C:\path\to\recording.m4a" --out transcript.md
 *
 * 選項：
 *   --meeting <id>   寫回既有會議（每 30 分鐘一個段落）
 *   --replace        會議已有逐字稿時覆蓋
 *   --model <id>     覆蓋設定的 Gemini 轉錄模型
 *   --chunk-min <n>  每段幾分鐘（預設 30，最少 5）
 *   --out <path>     沒有 --meeting 時，逐字稿要寫到哪
 *
 * 超過 --chunk-min 的錄音會先用 ffmpeg 真的切成獨立檔案再逐段轉錄。
 * 不要改成「上傳整場、用時間範圍請模型只轉某段」：實測模型會忽略範圍、每次都從頭開始。
 */
import { mkdirSync } from 'node:fs';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Segment } from '../src/core/protocol.ts';
import { formatDuration, formatDurationZh } from '../src/core/format.ts';
import { settings } from '../server/config.ts';
import { splitAudio, type Chunk } from '../server/ffmpeg.ts';
import {
  countFileTokens,
  findReusableFile,
  mediaDurationSec,
  modelLimits,
  transcribeUploadedFile,
  uploadLocalFile,
  waitUntilActive,
  type GeminiFile,
} from '../server/gemini-file.ts';
import { meetingDir, readMeeting, saveMeeting, writeNotes, writeTranscript } from '../server/store.ts';

interface Flags {
  meeting?: string;
  out?: string;
  model?: string;
  chunkMin?: number;
  replace?: boolean;
}

function parseArgs(argv: string[]): { file: string; flags: Flags } {
  const flags: Flags = {};
  let file = '';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) {
      if (!file) file = arg;
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (key === 'replace') {
      flags.replace = true;
    } else if (key === 'meeting' || key === 'out' || key === 'model' || key === 'chunk-min') {
      if (next && !next.startsWith('--')) {
        if (key === 'chunk-min') flags.chunkMin = Number(next);
        else flags[key] = next;
        i += 1;
      }
    }
  }
  return { file, flags };
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function main(): Promise<void> {
  const { file, flags } = parseArgs(process.argv.slice(2));
  if (!file) {
    log(
      '用法：node scripts/transcribe-file.ts <音檔> [--meeting <id>] [--out <path>] [--model <id>] [--chunk-min 30] [--replace]',
    );
    process.exitCode = 2;
    return;
  }

  const s = settings();
  if (!s.geminiApiKey) {
    throw new Error('還沒有 Gemini API key。請在設定頁填，或把 GEMINI_API_KEY 放進 .env。');
  }
  const model = flags.model || s.transcribeModels.gemini;
  const info = await stat(file);
  log(`[1/5] 讀檔：${path.basename(file)}（${mb(info.size)}）`);

  const started = Date.now();
  const durationSec = mediaDurationSec(await readFile(file));
  const chunkSec = Math.max(300, Math.round((flags.chunkMin ?? 30) * 60));
  const needsSplit = durationSec !== null && durationSec > chunkSec;

  let tempDir: string | null = null;
  let chunks: Chunk[];
  if (needsSplit) {
    const count = Math.ceil((durationSec ?? 0) / chunkSec);
    log(`[2/5] 切成 ${count} 段（每段 ${Math.round(chunkSec / 60)} 分鐘）…`);
    tempDir = path.join(os.tmpdir(), 'opencode', `chunks-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    chunks = await splitAudio(file, { outDir: tempDir, chunkSec, durationSec });
    log(`      完成：${chunks.length} 個檔案，放在 ${tempDir}`);
  } else {
    log(`[2/5] 不用切段（長度 ${durationSec ? formatDurationZh(durationSec) : '未知'}）`);
    chunks = [{ path: file, startSec: 0, durationSec: durationSec ?? 0, displayName: path.basename(file) }];
  }

  const checkpoint = flags.meeting
    ? path.join(meetingDir(flags.meeting), 'transcript.partial.md')
    : flags.out
      ? `${flags.out}.partial`
      : `${file.replace(/\.[^.]+$/, '')}.transcript.partial.md`;

  const limits = await modelLimits(s.geminiApiKey, model);
  log(`[3/5] 逐段轉錄（${model}，${chunks.length} 段）…`);

  const done: { text: string; chunk: Chunk; requestId: string }[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i] as Chunk;
    const label = needsSplit
      ? `${formatDuration(chunk.startSec)}–${formatDuration(chunk.startSec + chunk.durationSec)}`
      : '整場';
    log(`      第 ${i + 1}/${chunks.length} 段（${label}）`);
    try {
      const size = (await stat(chunk.path)).size;
      const reused = await findReusableFile(chunk.displayName, size, s.geminiApiKey);
      let uploadedFile: GeminiFile;
      if (reused) {
        uploadedFile = reused;
        log('      沿用 48 小時內上傳過的檔案，跳過上傳');
      } else {
        log(`      上傳中（${mb(size)}）…`);
        const result = await uploadLocalFile(chunk.path, {
          apiKey: s.geminiApiKey,
          displayName: chunk.displayName,
          onState: (state) => log(`      Files API 狀態：${state}`),
        });
        uploadedFile = result.file;
        log(`      上傳完成：${mb(result.bytes)}`);
      }

      const ready = await waitUntilActive(uploadedFile, s.geminiApiKey, (state) => log(`      狀態：${state}`));
      const tokens = await countFileTokens(ready, s.geminiApiKey, model);
      if (tokens !== null) log(`      input token：${tokens.toLocaleString('en-US')}`);
      if (tokens !== null && limits.input !== null && tokens > limits.input) {
        throw new Error(`這一段超過模型的 context 上限（${limits.input.toLocaleString('en-US')} tokens），請把 --chunk-min 調小。`);
      }

      const text = await transcribeUploadedFile(ready, {
        apiKey: s.geminiApiKey,
        model,
        language: s.language,
        maxOutputTokens: limits.output ?? 65536,
        onRetry: (attempt, waitMs, message) =>
          log(`      ${message.split('\n')[0]}，${Math.round(waitMs / 1000)} 秒後重試（第 ${attempt} 次）`),
      });
      if (!text.trim()) {
        log('      這一段沒有辨識到內容（可能是靜音或空白段落），跳過');
      } else {
        done.push({ text, chunk, requestId: ready.name });
      }
      await writeFile(checkpoint, `${done.map((d) => d.text).join('\n\n')}\n`, 'utf8');
      const total = done.reduce((sum, d) => sum + d.text.length, 0);
      log(`      完成：${text.length.toLocaleString('en-US')} 字（累計 ${total.toLocaleString('en-US')} 字）`);
    } catch (err) {
      // 保留已完成的段落與切好的檔案，方便重跑時比對
      log(`      失敗，已完成的進度留在 ${checkpoint}`);
      if (tempDir) log(`      切好的段落留在 ${tempDir}`);
      throw err;
    }
  }

  const fullText = done.map((d) => d.text).join('\n\n').trim();
  if (!fullText) throw new Error('Gemini 回傳空逐字稿。可能是音訊太小聲或格式有問題。');
  log(`      全部完成：${fullText.length.toLocaleString('en-US')} 字`);

  if (flags.meeting) {
    const meeting = await readMeeting(flags.meeting);
    const hasTranscript = meeting.segments.some((seg) => seg.transcript.trim());
    if (hasTranscript && !flags.replace) {
      throw new Error('這場會議已經有逐字稿了。確定要覆蓋請加 --replace。');
    }
    const base = new Date(meeting.startedAt).getTime();
    const segments: Segment[] = done.map((item, index) => ({
      index,
      label: needsSplit ? null : '整場錄音',
      startedAt: new Date(base + item.chunk.startSec * 1000).toISOString(),
      endedAt: new Date(base + (item.chunk.startSec + item.chunk.durationSec) * 1000).toISOString(),
      offsetSec: item.chunk.startSec,
      transcript: item.text,
      status: 'done',
      durationSeconds: item.chunk.durationSec || null,
      billedSeconds: null,
      requestId: item.requestId,
      error: null,
    }));
    meeting.segments = segments;
    meeting.engine = 'gemini';
    meeting.transcribeModel = model;
    meeting.status = 'ended';
    const totalSec = durationSec ?? segments.reduce((sum, seg) => sum + (seg.durationSeconds ?? 0), 0);
    meeting.endedAt = new Date(base + totalSec * 1000).toISOString();
    await saveMeeting(meeting);
    await writeTranscript(meeting);
    await writeNotes(meeting);
    await rm(checkpoint, { force: true }).catch(() => undefined);
    log(`[4/5] 已寫回會議 ${meeting.id}（transcript.md，${segments.length} 段）`);
  } else {
    const out = flags.out || `${file.replace(/\.[^.]+$/, '')}.transcript.md`;
    const header = [
      `# 逐字稿 · ${path.basename(file)}`,
      '',
      `- 轉錄模型：${model}`,
      durationSec ? `- 長度：${formatDurationZh(durationSec)}` : '',
      `- 分段：${done.length}`,
      `- 字數：${fullText.length.toLocaleString('en-US')}`,
      '',
    ]
      .filter(Boolean)
      .join('\n');
    await writeFile(out, `${header}\n${fullText}\n`, 'utf8');
    await rm(checkpoint, { force: true }).catch(() => undefined);
    log(`[4/5] 已寫入 ${out}`);
  }

  log('[5/5] 清掉暫存的切段檔案');
  if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  log(`總共花了 ${Math.round((Date.now() - started) / 1000)} 秒。`);
}

main().catch((err: unknown) => {
  const cause = (err as { cause?: unknown }).cause;
  const detail = cause ? `（${cause instanceof Error ? cause.message : String(cause)}）` : '';
  log(`錯誤：${err instanceof Error ? err.message : String(err)}${detail}`);
  process.exitCode = 1;
});
