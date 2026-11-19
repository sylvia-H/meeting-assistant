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
