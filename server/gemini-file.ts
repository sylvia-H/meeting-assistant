/**
 * Gemini Files API：給「既有的長錄音檔」用。
 *
 * 即時錄音的逐字稿走 inline audio（每段 ≤ 280 秒），但 100 MB 以上的錄音檔
 * 一定要先上傳到 Files API，再用 fileData 請模型轉錄。
 * Files API 的上傳免費、每檔上限 2 GB、保留 48 小時。
 *
 * GEMINI_BASE_URL 只給測試覆蓋用。
 */
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { DEFAULT_GEMINI_TRANSCRIBE_MODEL } from '../src/core/protocol.ts';
import { cleanText, friendly, isDailyQuota, SYSTEM_PROMPT } from './gemini.ts';

const UPLOAD_TIMEOUT_MS = 30 * 60_000;
/** 生成時的「連線閒置」上限；不是總時間上限，資料有在流就不會被砍 */
const GENERATE_TIMEOUT_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 2_000;
const POLL_MAX = 300; // 10 分鐘

const MIME: Record<string, string> = {
  '.mp3': 'audio/mp3',
  '.mpeg': 'audio/mpeg',
  '.mpga': 'audio/mpeg',
  '.m4a': 'audio/m4a',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
  // 影片也可以，但會連畫面一起算 token；能先抽音軌就抽。
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
};

export function mimeForFile(filePath: string): string | null {
  return MIME[path.extname(filePath).toLowerCase()] ?? null;
}

/**
 * 從 MP4/M4A 的 mvhd box 讀時長，不需要 ffmpeg。
 * 找不到或數值不合理就回 null。
 */
export function mediaDurationSec(buf: Buffer): number | null {
  let from = 0;
  for (let hit = 0; hit < 20; hit += 1) {
    const p = buf.indexOf('mvhd', from);
    if (p < 0) return null;
    from = p + 4;
    if (p < 4 || p + 32 > buf.length) continue;
    const version = buf[p + 4];
    let timescale = 0;
    let duration = 0;
    if (version === 0) {
      timescale = buf.readUInt32BE(p + 16);
      duration = buf.readUInt32BE(p + 20);
    } else if (version === 1) {
      timescale = buf.readUInt32BE(p + 24);
      duration = Number(buf.readBigUInt64BE(p + 28));
    } else {
      continue;
    }
    if (!timescale || !duration) continue;
    const sec = duration / timescale;
    if (sec > 0 && sec < 24 * 3600) return sec;
  }
  return null;
}

export interface GeminiFile {
  name: string;
  uri: string;
  mimeType: string;
  state: string;
  sizeBytes?: string;
  displayName?: string;
  expirationTime?: string;
}

export interface UploadOptions {
  apiKey: string;
  mimeType: string;
  displayName?: string;
  onState?: (state: string) => void;
}

function baseUrl(): string {
  return (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 送出 JSON 並等完整回應。長音訊的生成常常超過 5 分鐘，而 Node 內建的 fetch（undici）
 * 預設等 5 分鐘 header 就放棄（HTTP/2: headers timeout after 300000），所以這裡走 node:https，
 * 只設「連線閒置」上限。
 */
function postJson(
  url: string,
  headers: Record<string, string>,
  body: string,
  idleTimeoutMs: number,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = Buffer.from(body, 'utf8');
    const send = target.protocol === 'http:' ? httpRequest : httpsRequest;
    const req = send(
      {
        method: 'POST',
        hostname: target.hostname,
        port: target.port || (target.protocol === 'http:' ? 80 : 443),
        path: `${target.pathname}${target.search}`,
        headers: { ...headers, 'content-length': payload.length },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    req.setTimeout(idleTimeoutMs, () => {
      req.destroy(new Error(`Gemini 超過 ${Math.round(idleTimeoutMs / 60_000)} 分鐘沒有回應，請把 --chunk-min 調小。`));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function readFileJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Gemini 回應不是合法 JSON：${text.slice(0, 300)}`);
  }
}

/** 用 resumable upload 把整包 bytes 送上 Files API，回傳檔案（可能還在 PROCESSING）。 */
export async function uploadMediaFile(buf: Buffer, options: UploadOptions): Promise<GeminiFile> {
  if (!options.apiKey) throw new Error('尚未設定 Gemini API key，請先到設定頁填入。');
  if (!options.mimeType) throw new Error('不支援這個副檔名，請先轉成 mp3 / m4a / wav。');

  const start = await fetch(`${baseUrl()}/upload/v1beta/files?uploadType=resumable`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': options.apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(buf.length),
      'X-Goog-Upload-Header-Content-Type': options.mimeType,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: options.displayName ?? 'recording' } }),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!start.ok) throw new Error(friendly(start.status, await start.text()));

  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Gemini 沒有回傳 upload URL，請稍後再試。');

  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: new Uint8Array(buf),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!put.ok) throw new Error(friendly(put.status, await put.text()));

  const data = await readFileJson(put);
  const file = data.file as GeminiFile | undefined;
  if (!file?.name || !file.uri) throw new Error('Gemini 上傳成功，但回應缺少 file.name / file.uri。');
  options.onState?.(file.state);
  return file;
}

/** 等 Files API 把檔案標成 ACTIVE（Gemini 需要先處理過才能用）。 */
export async function waitUntilActive(
  file: GeminiFile,
  apiKey: string,
  onState?: (state: string) => void,
): Promise<GeminiFile> {
  let current = file;
  for (let i = 0; i < POLL_MAX; i += 1) {
    if (current.state === 'ACTIVE') return current;
    if (current.state === 'FAILED') throw new Error('Gemini 處理這個檔案失敗，請確認格式後再試。');
    await sleep(POLL_INTERVAL_MS);
    const res = await fetch(`${baseUrl()}/v1beta/${current.name}`, {
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(friendly(res.status, await res.text()));
    current = (await res.json()) as GeminiFile;
    onState?.(current.state);
  }
  throw new Error('Gemini 處理檔案超過 10 分鐘，請稍後再試。');
}

/** 找 48 小時內上傳過、檔名與大小都相同的檔案，避免重跑時再傳 100 MB。 */
export async function findReusableFile(
  displayName: string,
  sizeBytes: number,
  apiKey: string,
): Promise<GeminiFile | null> {
  try {
    const res = await fetch(`${baseUrl()}/v1beta/files?pageSize=100`, {
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { files?: GeminiFile[] };
    const now = Date.now();
    return (
      data.files?.find((file) => {
        const size = Number(file.sizeBytes);
        const expires = file.expirationTime ? new Date(file.expirationTime).getTime() : 0;
        return (
          file.displayName === displayName &&
          file.state === 'ACTIVE' &&
          (!Number.isFinite(size) || size === sizeBytes) &&
          expires > now
        );
      }) ?? null
    );
  } catch {
    return null;
  }
}

/** 算這份檔案會用掉多少 input token（不產生費用）。失敗回 null。 */
export async function countFileTokens(
  file: { uri: string; mimeType: string },
  apiKey: string,
  model = DEFAULT_GEMINI_TRANSCRIBE_MODEL,
): Promise<number | null> {
  try {
    const res = await fetch(
      `${baseUrl()}/v1beta/models/${encodeURIComponent(model)}:countTokens`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ fileData: { mimeType: file.mimeType, fileUri: file.uri } }] }],
        }),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { totalTokens?: number };
    return typeof data.totalTokens === 'number' ? data.totalTokens : null;
  } catch {
    return null;
  }
}

/** 讀模型資訊裡的 input/output 上限；失敗回 null。 */
export async function modelLimits(
  apiKey: string,
  model = DEFAULT_GEMINI_TRANSCRIBE_MODEL,
): Promise<{ input: number | null; output: number | null }> {
  try {
    const res = await fetch(`${baseUrl()}/v1beta/models/${encodeURIComponent(model)}`, {
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { input: null, output: null };
    const data = (await res.json()) as { inputTokenLimit?: number | string; outputTokenLimit?: number | string };
    const num = (value: number | string | undefined): number | null => {
      const n = typeof value === 'string' ? Number(value) : value;
      return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
    };
    return { input: num(data.inputTokenLimit), output: num(data.outputTokenLimit) };
  } catch {
    return { input: null, output: null };
  }
}

export class TranscriptTooLongError extends Error {
  partial: string;
  constructor(partial: string, message: string) {
    super(message);
    this.partial = partial;
  }
}

function timeLabel(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export async function transcribeUploadedFile(
  file: { uri: string; mimeType: string },
  options: {
    apiKey: string;
    model?: string;
    language?: string;
    maxOutputTokens?: number;
    startSec?: number;
    endSec?: number;
    temperature?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    onRetry?: (attempt: number, waitMs: number, message: string) => void;
  },
): Promise<string> {
  const model = options.model || DEFAULT_GEMINI_TRANSCRIBE_MODEL;
  const language = options.language === 'en' ? '音訊可能是英文，請依實際語言轉錄。' : '';
  const url = `${baseUrl()}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const range =
    options.startSec !== undefined && options.endSec !== undefined
      ? `只轉錄音訊中 ${timeLabel(options.startSec)} 到 ${timeLabel(options.endSec)} 的內容。範圍外的內容不要輸出，也不要摘要。`
      : '請逐字轉錄整段會議音訊。這是完整的一場會議，請從頭到尾全部輸出，不要摘要、不要省略、不要跳過任何段落；內容很長也一樣。';
  const thinking =
    model.startsWith('gemini-3') || model.startsWith('gemini-4')
      ? { thinkingConfig: { thinkingLevel: 'minimal' } }
      : {};

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [
      {
        role: 'user',
        parts: [
          { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
          { text: `${language}\n${range}`.trim() },
        ],
      },
    ],
    generationConfig: {
      temperature: options.temperature ?? 0,
      maxOutputTokens: options.maxOutputTokens ?? 65536,
      ...(options.frequencyPenalty !== undefined ? { frequencyPenalty: options.frequencyPenalty } : {}),
      ...(options.presencePenalty !== undefined ? { presencePenalty: options.presencePenalty } : {}),
      ...thinking,
    },
  });
  const headers = { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey };

  let text = '';
  let status = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await postJson(url, headers, body, GENERATE_TIMEOUT_MS);
    text = res.text;
    status = res.status;
    if (status >= 200 && status < 300) break;
    if ((status === 503 || status === 429) && attempt < 2) {
      // 今天的額度用完就別再等，等到明天也不會在中途變回來
      if (status === 429 && isDailyQuota(text)) throw new Error(friendly(status, text));
      const waitMs = status === 429 ? 60_000 : 15_000 * (attempt + 1);
      options.onRetry?.(attempt + 1, waitMs, friendly(status, text));
      await sleep(waitMs);
      continue;
    }
    throw new Error(friendly(status, text));
  }
  if (status < 200 || status >= 300) throw new Error(friendly(status, text));

  let data: {
    candidates?: {
      content?: { parts?: { text?: string; thought?: boolean }[] };
      finishReason?: string;
    }[];
    promptFeedback?: { blockReason?: string };
  };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    throw new Error(`Gemini 回應不是合法 JSON：${text.slice(0, 300)}`);
  }

  const candidate = data.candidates?.[0];
  const output = (candidate?.content?.parts ?? [])
    .filter((part) => !part.thought)
    .map((part) => part.text ?? '')
    .join('')
    .trim();

  if (!output && data.promptFeedback?.blockReason) {
    throw new Error(`Gemini 拒絕處理這段音訊（${data.promptFeedback.blockReason}）。`);
  }
  if (candidate?.finishReason && ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT'].includes(candidate.finishReason)) {
    throw new Error(`Gemini 因為內容政策沒有輸出逐字稿（${candidate.finishReason}）。`);
  }
  if (candidate?.finishReason === 'MAX_TOKENS') {
    const partial = cleanText(output);
    throw new TranscriptTooLongError(
      partial,
      `逐字稿超過 Gemini 的輸出上限（已產生 ${partial.length.toLocaleString('en-US')} 字）。如果這是單一段，請把段落切短一點。`,
    );
  }
  return cleanText(output);
}

/** 讀檔並上傳。檔案會整包進記憶體；112 MB 左右沒問題，2 GB 就不建議這樣做。 */
export async function uploadLocalFile(
  filePath: string,
  options: Omit<UploadOptions, 'mimeType'> & { mimeType?: string },
): Promise<{ file: GeminiFile; bytes: number; durationSec: number | null }> {
  const buf = await readFile(filePath);
  const mimeType = options.mimeType ?? mimeForFile(filePath);
  if (!mimeType) throw new Error(`不支援的副檔名：${path.extname(filePath) || '（沒有副檔名）'}`);
  const durationSec = mediaDurationSec(buf);
  const file = await uploadMediaFile(buf, {
    ...options,
    mimeType,
    displayName: options.displayName ?? path.basename(filePath),
  });
  return { file, bytes: buf.length, durationSec };
}
