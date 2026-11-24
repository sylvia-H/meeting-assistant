/**
 * 逐字稿的退化重複偵測。
 *
 * 實測：gemini-3.1-flash-lite 轉長音訊時，偶爾會卡在句子裡反覆輸出同一句
 * （例如「那個時候，」重複三千多次）直到撞到 MAX_TOKENS 上限。這種尾巴一定要砍掉，
 * 不然整份逐字稿會被幾萬字的鬼打牆蓋掉。
 *
 * 只在「尾端有超長、完全相同的重複區塊」時才判定，避免誤砍正常的口語重複。
 */

/** 重複單元最短 2 字、最長 80 字 */
const MIN_UNIT = 2;
const MAX_UNIT = 80;
/** 至少連續 10 次，而且整段重複超過 400 字，才算鬼打牆 */
const MIN_REPEAT_TIMES = 10;
const MIN_REPEAT_CHARS = 400;
/** 只看最後這麼多字，太長的重複區塊仍會被完整砍掉 */
const SCAN_TAIL = 20_000;

export interface RepeatCut {
  text: string;
  /** 有沒有砍掉東西 */
  cut: boolean;
  /** 重複了幾次（沒有重複就是 0） */
  times: number;
}

export function cutRunawayRepeat(text: string): RepeatCut {
  const len = text.length;
  if (len < MIN_REPEAT_CHARS) return { text, cut: false, times: 0 };

  const scanFrom = Math.max(0, len - SCAN_TAIL);

  for (let unit = MIN_UNIT; unit <= MAX_UNIT; unit += 1) {
    if (unit * MIN_REPEAT_TIMES > len) break;
    // 從尾端往回數連續相同的區塊
    const last = text.slice(len - unit, len);
    let start = len - unit;
    let times = 1;
    while (start - unit >= scanFrom && text.slice(start - unit, start) === last) {
      start -= unit;
      times += 1;
    }
    if (times < MIN_REPEAT_TIMES || times * unit < MIN_REPEAT_CHARS) continue;

    // 再往前延伸到重複區塊的起點，避免留下半段鬼打牆
    while (start - unit >= 0 && text.slice(start - unit, start) === last) {
      start -= unit;
      times += 1;
    }
    return { text: text.slice(0, start).trimEnd(), cut: true, times };
  }
  return { text, cut: false, times: 0 };
}

/**
 * 靜音／底噪判定。
 *
 * 實測：Gemini 碰到沒有說話的片段不會回空字串，而是自己編一份煞有其事的會議逐字稿
 * （11 秒數位靜音 → 「大家早安，我們現在開始今天的週會…」）。所以送出去之前先看音量。
 *
 * 只看整體 RMS 不夠：風扇、冷氣、藍牙耳機的底噪也會有 0.005–0.02 的音量，
 * 但它是「平的」；說話會有明顯起伏。所以同時看 10 百分位（停頓）與 95 百分位（講話）。
 */
export const SILENCE_PEAK = 0.01;
/** p95 / p10 低於這個倍率，代表只有持續底噪、沒有說話的抑揚頓挫 */
export const FLAT_RATIO = 1.8;
const SAMPLE_RATE = 16000;
const FRAME_MS = 100;

export interface PcmLevels {
  /** 整段的 RMS */
  rms: number;
  /** 100 ms 音框能量的 10 百分位（大概是停頓時的音量） */
  p10: number;
  /** 95 百分位（大概是講話時的音量） */
  p95: number;
  frames: number;
}

function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[index] ?? 0;
}

export function pcmLevels(pcm: Buffer): PcmLevels {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return { rms: 0, p10: 0, p95: 0, frames: 0 };

  const frameSamples = (SAMPLE_RATE * FRAME_MS) / 1000;
  const frames: number[] = [];
  let total = 0;

  for (let start = 0; start < samples; start += frameSamples) {
    const end = Math.min(samples, start + frameSamples);
    let sum = 0;
    for (let i = start; i < end; i += 1) {
      const value = pcm.readInt16LE(i * 2) / 32768;
      sum += value * value;
    }
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    frames.push(rms);
    total += sum;
  }

  const sorted = [...frames].sort((a, b) => a - b);
  return {
    rms: Math.sqrt(total / samples),
    p10: percentile(sorted, 0.1),
    p95: percentile(sorted, 0.95),
    frames: frames.length,
  };
}

/** 這段音訊「有沒有在說話」；沒有的話回傳原因，讓錯誤訊息講得出來。 */
export function silenceReason(levels: PcmLevels): string | null {
  if (levels.p95 < SILENCE_PEAK) return '幾乎沒有聲音';
  if (levels.p95 < levels.p10 * FLAT_RATIO) return '只有持續底噪、沒有說話的起伏';
  return null;
}
