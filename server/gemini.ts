/**
 * Gemini 轉錄：把一段 16 kHz / 16-bit / 單聲道 PCM 包成 WAV，用 generateContent 的
 * inline audio 送回 Gemini，請它逐字轉成繁體中文。
 *
 * 這裡刻意不做摘要：逐字稿就是逐字稿，摘要交給 server/llm.ts。
 * GEMINI_BASE_URL 可以覆蓋 API 位址，smoke test 用它在本地跑假伺服器。
 */
import { DEFAULT_GEMINI_TRANSCRIBE_MODEL } from '../src/core/protocol.ts';

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BITS = 16;
const TIMEOUT_MS = 90_000;

export const SYSTEM_PROMPT = `你是專業的逐字稿聽打員。請把音訊中的說話內容逐字轉成文字。

規則：
- 使用繁體中文與台灣用語。
- 逐字保留說話內容，不要摘要、不要改寫、不要補充音訊裡沒說到的內容。
- 自動補上標點符號；沒有意義的語氣詞（嗯、呃、就是說）可以略過。
- 不要標註講者，也不要把內容整理成條列。
- 只輸出逐字稿本身，不要前言、標題、說明或 markdown 程式碼區塊。
- 如果音訊是靜音或完全聽不出內容，輸出空字串。
- 絕對不要重複同一句話、同一個詞或同一個片段；聽不清楚的地方直接跳過，繼續往下聽。`;

/** 把 PCM（預設 16 kHz / 16-bit / mono）包成 44-byte 檔頭的 WAV。 */
export function pcmToWav(pcm: Buffer): Buffer {
  const wav = Buffer.alloc(44 + pcm.length);
  const byteRate = SAMPLE_RATE * CHANNELS * (BITS / 8);
  const blockAlign = CHANNELS * (BITS / 8);

  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(CHANNELS, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(BITS, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}

function baseUrl(): string {
  return (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
}

export function friendly(status: number, body: string): string {
  const snippet = body.slice(0, 400);
  if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(body)) {
    return `Gemini API key 無效（400）。請到設定頁重新貼上。\n${snippet}`;
  }
  if (status === 401 || status === 403) return `Gemini API key 無效或沒有權限（${status}）。請到設定頁確認。\n${snippet}`;
  if (status === 404) return `找不到這個 Gemini 模型（404）。請到設定頁換一個模型。\n${snippet}`;
  if (status === 413) return `音訊太長，Gemini 不接受這個大小（413）。請把自動切段秒數調短。\n${snippet}`;
  if (status === 429 && isDailyQuota(body)) {
    return (
      'Gemini 免費層「今天」的額度用完了（每個模型每天 20 次請求）。重試沒有用，' +
      '太平洋時間午夜（台灣時間下午 3–4 點）重置；急用請換付費 key 或換另一個模型。\n' +
      snippet
    );
  }
  if (status === 429) return `Gemini 免費額度用完或請求太頻繁（429）。等一會再試，或到 Google AI Studio 看額度。\n${snippet}`;
  if (status === 503) return `Gemini 目前負載過高（503）。等一兩分鐘再試一次即可。\n${snippet}`;
  return `Gemini 回應 ${status}：${snippet}`;
}

/**
 * 429 有兩種：一種是「每分鐘太快」，等一下就好；一種是「今天的額度沒了」，重試只會浪費時間。
 * 後者的 body 會帶 `PerDay` 或 `free_tier_requests ... limit: 20`。
 */
export function isDailyQuota(body: string): boolean {
  return /PerDay|per_day|per day/i.test(body) || (/free_tier_requests/i.test(body) && /limit/i.test(body));
}

/**
 * 「今天的免費額度用完」跟「這一分鐘送太多」不一樣：前者換一顆模型就有新額度，
 * 所以用獨立的錯誤型別，讓呼叫端知道可以換模型重送同一段音訊。
 */
export class DailyQuotaError extends Error {
  readonly model: string;

  constructor(model: string, message: string) {
    super(message);
    this.name = 'DailyQuotaError';
    this.model = model;
  }
}

/**
 * 現場錄音的備援順序：主模型當日額度用完時，同一段音訊換下一顆重送。
 * 只收「短音訊表現正常」的兩顆；gemini-3.1-flash-lite 長音檔會卡在重複同一句、
 * gemini-flash-latest 會先思考很久，都不適合當備援。
 */
export const GEMINI_LIVE_FALLBACKS = ['gemini-flash-lite-latest', 'gemini-3-flash-preview'] as const;

/** 回傳「先試這顆、再試備援」的模型順序，去重並保留原始順序。 */
export function geminiModelChain(primary: string): string[] {
  const chain = [primary, ...GEMINI_LIVE_FALLBACKS].filter((model) => model.trim() !== '');
  return chain.filter((model, index) => chain.indexOf(model) === index);
}

/**
 * 模型偶爾會自己加一句開場白再開始逐字稿。實測長這樣：
 *   好的，以下是該音訊的完整逐字稿：
 *   好的，以下是該段音訊的完整逐字稿：
 * 逐字稿不該有這種句子，所以只砍「開頭那一行」的固定說法，內文不動。
 */
const PREAMBLE = /^\s*(?:好的[，,、]?\s*)?以下是[^\n]{0,40}?逐字稿[：:]\s*/;

export function cleanText(raw: string): string {
  let text = raw.trim();
  // 有些模型會無視指示包一層 code fence
  text = text.replace(/^```(?:text|markdown|md)?\s*\n?/i, '').replace(/\n?```$/, '').trim();
  // 開場白可能出現在 code fence 裡面，所以放在去 fence 之後
  text = text.replace(PREAMBLE, '').trim();
  return text.replace(/\n{3,}/g, '\n\n');
}

export interface TranscribeOptions {
  apiKey: string;
  model?: string;
  language?: string;
}

/** 送一段 PCM 給 Gemini 逐字轉錄。回傳已經 trim 過的文字，可能是空字串。 */
export async function transcribePcm(pcm: Buffer, options: TranscribeOptions): Promise<string> {
  if (!options.apiKey) throw new Error('尚未設定 Gemini API key，請先到設定頁填入。');
  if (pcm.length < SAMPLE_RATE / 5) return ''; // 少於 0.2 秒，不值得送

  const model = options.model || DEFAULT_GEMINI_TRANSCRIBE_MODEL;
  const url = `${baseUrl()}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const language = options.language === 'en' ? '音訊可能是英文，請依實際語言轉錄。' : '';

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'audio/wav', data: pcmToWav(pcm).toString('base64') } },
            { text: `${language}\n請轉錄這段會議音訊。`.trim() },
          ],
        },
      ],
      generationConfig: { temperature: 0, maxOutputTokens: 8192 },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await res.text();
  if (!res.ok) {
    // 每日額度用完是可恢復的：換一顆模型就有新的 20 次，所以讓呼叫端認得出這個情況
    if (res.status === 429 && isDailyQuota(text)) throw new DailyQuotaError(model, friendly(res.status, text));
    throw new Error(friendly(res.status, text));
  }

  let data: {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    throw new Error(`Gemini 回應不是合法 JSON：${text.slice(0, 300)}`);
  }
  const candidate = data.candidates?.[0];
  const output = (candidate?.content?.parts ?? [])
    .map((part) => part.text ?? '')
    .join('')
    .trim();

  if (!output && data.promptFeedback?.blockReason) {
    throw new Error(`Gemini 拒絕處理這段音訊（${data.promptFeedback.blockReason}）。`);
  }
  if (!output && candidate?.finishReason && ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT'].includes(candidate.finishReason)) {
    throw new Error(`Gemini 因為內容政策沒有輸出逐字稿（${candidate.finishReason}）。`);
  }
  if (candidate?.finishReason === 'MAX_TOKENS') {
    throw new Error('這段逐字稿超過 Gemini 的輸出上限，請把自動切段秒數調短。');
  }
  return cleanText(output);
}

/** 設定頁「測試 Gemini key」用：只讀模型資訊，不會產生 token。 */
export async function pingGemini(apiKey: string, model = DEFAULT_GEMINI_TRANSCRIBE_MODEL): Promise<string> {
  if (!apiKey) throw new Error('尚未設定 Gemini API key');
  const url = `${baseUrl()}/v1beta/models/${encodeURIComponent(model)}`;
  const res = await fetch(url, {
    headers: { 'x-goog-api-key': apiKey },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(friendly(res.status, await res.text()));
  return `${model} 可用`;
}
