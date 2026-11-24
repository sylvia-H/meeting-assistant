/**
 * 現場錄音一段音訊的轉錄流程：重試、換模型、防鬼打牆。
 *
 * 2026-11-24 盤點 5 場實際會議（180 秒一段）：失敗 22 段裡 9 段是 503、9 段是 MAX_TOKENS。
 * 以前兩種都直接把整段丟掉。現在：
 *
 * - 503／500／502／504／每分鐘 429／網路抖動：同一顆模型等 RETRY_WAITS_MS 各重送一次，
 *   還是不行就換備援模型（只對這一段，不改會議的主模型）。
 * - 每日額度用完：換下一顆模型，而且之後的段落都從新的那顆開始（呼叫端依 quotaExhausted 寫回）。
 * - MAX_TOKENS 或尾端鬼打牆：音訊夠長就切兩半各自重送（最多兩層）；太短就保留砍掉重複後的文字。
 *
 * 不直接 import Gemini，讓測試可以塞假的 transcribe 與 sleep。
 */
import { DailyQuotaError, MaxTokensError, TransientGeminiError } from './gemini.ts';
import { cutRunawayRepeat } from './transcript-guard.ts';

const BYTES_PER_SEC = 32000; // 16000 Hz × 16-bit × 1ch
/** 同一顆模型碰到暫時性錯誤時，各等多久再重送 */
export const RETRY_WAITS_MS = [10_000, 20_000] as const;
/** 鬼打牆時，音訊至少這麼長才切兩半重送；更短的切了也沒意義 */
export const MIN_SPLIT_SECONDS = 40;
/** 最多切幾層：180 秒 → 90 → 45 */
export const MAX_SPLIT_DEPTH = 2;

export interface LiveTranscribeDeps {
  transcribe: (pcm: Buffer, model: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  /** 給使用者看的進度提示（例如「503，10 秒後重試」） */
  onNotice?: (message: string) => void;
}

export interface LiveTranscribeResult {
  text: string;
  /** 最後成功的那顆模型 */
  model: string;
  /** 今天額度已經用完的模型，呼叫端用來決定之後的段落改用哪顆 */
  quotaExhausted: string[];
  /** 有沒有因為鬼打牆砍掉一部分（中間可能漏幾句） */
  trimmed: boolean;
  /** 切了幾次才轉完（0 = 一次就過） */
  splits: number;
}

interface RunState {
  chain: string[];
  quotaExhausted: string[];
  trimmed: boolean;
  splits: number;
  lastModel: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function transcribeLiveSegment(
  pcm: Buffer,
  chain: string[],
  deps: LiveTranscribeDeps,
): Promise<LiveTranscribeResult> {
  if (!chain.length) throw new Error('沒有可用的轉錄模型');
  const state: RunState = { chain, quotaExhausted: [], trimmed: false, splits: 0, lastModel: chain[0] as string };
  const text = await transcribePart(pcm, 0, state, deps);
  return {
    text,
    model: state.lastModel,
    quotaExhausted: state.quotaExhausted,
    trimmed: state.trimmed,
    splits: state.splits,
  };
}

async function transcribePart(pcm: Buffer, depth: number, state: RunState, deps: LiveTranscribeDeps): Promise<string> {
  const attempt = await tryModels(pcm, state, deps);
  if (attempt.kind === 'ok') return attempt.text;

  // 鬼打牆：夠長就切兩半各自重送；前後半段各自短很多，比較不會卡住
  const seconds = pcm.length / BYTES_PER_SEC;
  if (seconds >= MIN_SPLIT_SECONDS && depth < MAX_SPLIT_DEPTH) {
    state.splits += 1;
    deps.onNotice?.(`模型卡在重複同一句，這段切成兩半重新轉錄（約 ${Math.round(seconds / 2)} 秒一半）。`);
    const [first, second] = splitPcm(pcm);
    const a = await transcribePart(first, depth + 1, state, deps);
    const b = await transcribePart(second, depth + 1, state, deps);
    return [a, b].filter((part) => part.trim()).join('\n');
  }

  // 太短或已經切到底：保留砍掉重複之後的文字，總比整段空白好
  state.trimmed = true;
  return attempt.partial;
}

type Attempt = { kind: 'ok'; text: string } | { kind: 'runaway'; partial: string };

/** 依序試每顆模型；回傳成功的文字，或「鬼打牆」與砍完的部分文字。其他錯誤直接丟出。 */
async function tryModels(pcm: Buffer, state: RunState, deps: LiveTranscribeDeps): Promise<Attempt> {
  const sleep = deps.sleep ?? defaultSleep;
  let lastError: unknown = null;

  for (const model of state.chain) {
    if (state.quotaExhausted.includes(model)) continue;

    for (let retry = 0; ; retry += 1) {
      try {
        const raw = await deps.transcribe(pcm, model);
        state.lastModel = model;
        const guarded = cutRunawayRepeat(raw);
        if (guarded.cut) return { kind: 'runaway', partial: guarded.text };
        return { kind: 'ok', text: raw };
      } catch (err) {
        lastError = err;
        if (err instanceof MaxTokensError) {
          state.lastModel = model;
          return { kind: 'runaway', partial: cutRunawayRepeat(err.partial).text };
        }
        if (err instanceof DailyQuotaError) {
          state.quotaExhausted.push(model);
          break; // 換下一顆
        }
        if (err instanceof TransientGeminiError) {
          const wait = RETRY_WAITS_MS[retry];
          if (wait === undefined) {
            deps.onNotice?.(`${model} 一直回 ${err.status || '連線錯誤'}，這段改用下一顆模型。`);
            break; // 換下一顆
          }
          deps.onNotice?.(`Gemini 暫時忙線（${err.status || '連線錯誤'}），${wait / 1000} 秒後重送同一段。`);
          await sleep(wait);
          continue;
        }
        throw err; // key 錯、模型不存在、內容政策…重送也沒用
      }
    }
  }

  const available = state.chain.filter((model) => !state.quotaExhausted.includes(model));
  if (!available.length) {
    throw new Error(
      `Gemini 免費層今天所有轉錄模型都用完了（${state.quotaExhausted.join('、')}）。太平洋時間午夜（台灣下午 3–4 點）重置，或到設定頁換付費 key。`,
    );
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError ?? '轉錄失敗');
  throw new Error(`重試與換模型都失敗了：${reason}`);
}

/** 切成前後兩半，切點對齊 16-bit 樣本 */
export function splitPcm(pcm: Buffer): [Buffer, Buffer] {
  const mid = Math.floor(pcm.length / 4) * 2;
  return [pcm.subarray(0, mid), pcm.subarray(mid)];
}
