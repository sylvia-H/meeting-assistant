import type { Meeting, MeetingNote } from '../src/core/protocol.ts';
import { NOTE_KINDS } from '../src/core/notes.ts';
import { formatClock, formatDate, formatDurationZh } from '../src/core/format.ts';

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Claude',
  openai: 'OpenAI',
  gemini: 'Gemini',
};

export function providerLabel(provider: string | undefined): string {
  if (!provider) return 'LLM';
  return PROVIDER_LABEL[provider] ?? provider;
}

export const SYSTEM_PROMPT = `你是一位資深會議紀錄員，替 Sylvia 整理她個人的會議紀錄。

你會拿到這些素材：
1. 逐字稿：由語音轉錄而來，依「環節」分段，可能有錯字、漏字或講者混在一起。
2. 我的即時筆記：會議中我親手打的標記，分成環節、決議、待辦、待確認、想法、筆記。這是最可信的訊號，優先採用。
3. 截圖（可能沒有）：會議中我貼進筆記的畫面截圖，附在訊息最後，依「截圖 N」編號，筆記裡會寫第幾分鐘貼的。
4. 參考資料：會議前放進資料夾的文件，用來校正人名、專有名詞與背景脈絡。

寫作規則：
- 一律繁體中文、台灣用語。不要出現「視頻、信息、項目、落地、賦能、抓手」這類中國用語或顧問黑話。
- 只寫素材裡真的有的東西。需要推論時在句尾標「（推測）」。
- 不要客套、不要「本次會議圓滿結束」這種廢話，不要重複題目。
- 決議必須是會議中真的達成共識的事；討論過但沒結論的放「未決與風險」。
- 待辦若沒指定負責人或期限，寫「待指派」「待確認」，不要自己發明人名或日期。
- 截圖上的數字、表格、時程、決議跟筆記一樣可信：整合進對應的段落，並在句尾標「（截圖 N）」。不要逐張描述圖片長什麼樣子；跟會議內容無關的部分（聊天視窗、工作列）略過。
- 逐字稿裡明顯的錯字（人名、產品名、數字）用參考資料、筆記與截圖校正，並在最後「校正紀錄」用一行一條簡短列出；沒有就寫「無」。
- 輸出純 markdown，不要用 code fence 包住整篇。`;

export interface PromptInput {
  meeting: Meeting;
  referenceContext: string;
  provider?: string;
}

export function transcriptForPrompt(meeting: Meeting, maxChars = 120000): string {
  const blocks: string[] = [];
  for (const seg of meeting.segments) {
    const text = seg.transcript.trim();
    if (!text) continue;
    const label = seg.label ? `環節：${seg.label}` : '未標記環節';
    blocks.push(`[第 ${seg.index + 1} 段 · ${label} · 從 ${formatClock(seg.startedAt)} 開始]\n${text}`);
  }
  let joined = blocks.join('\n\n');
  if (joined.length > maxChars) {
    const keep = Math.floor(maxChars / 2);
    joined = `${joined.slice(0, keep)}\n\n…（中段逐字稿因長度限制省略）…\n\n${joined.slice(-keep)}`;
  }
  return joined;
}

function sortedNotes(meeting: Meeting): MeetingNote[] {
  return meeting.notes.slice().sort((a, b) => a.elapsedSec - b.elapsedSec);
}

/** 有截圖的筆記，依時間排序並編號（截圖 1、2…），提示詞與附上的圖片共用這個編號 */
export function noteImages(meeting: Meeting): { n: number; note: MeetingNote & { image: string } }[] {
  return sortedNotes(meeting)
    .filter((note): note is MeetingNote & { image: string } => Boolean(note.image))
    .map((note, i) => ({ n: i + 1, note }));
}

export function notesForPrompt(meeting: Meeting): string {
  if (!meeting.notes.length) return '（沒有即時筆記）';
  const imageNo = new Map(noteImages(meeting).map(({ n, note }) => [note.id, n]));
  return sortedNotes(meeting)
    .map((n) => {
      const at = formatDurationZh(n.elapsedSec);
      const kind = NOTE_KINDS[n.kind].label;
      const seg = n.segmentIndex >= 0 ? `第 ${n.segmentIndex + 1} 段` : '錄音前';
      const no = imageNo.get(n.id);
      const shot = no ? `（附截圖 ${no}）` : '';
      const text = n.text.replace(/\n/g, ' ') || (no ? '（只有截圖，沒有文字）' : '');
      return `- [${kind}] ${at}（${seg}）：${text}${shot}`;
    })
    .join('\n');
}

/** 每張截圖前面放的一行說明：讓 LLM 知道這張圖是什麼時候、配哪則筆記 */
export function imageCaption(n: number, note: MeetingNote): string {
  const text = note.text.trim() ? `，筆記：${note.text.replace(/\n/g, ' ')}` : '';
  return `截圖 ${n}（${formatDurationZh(note.elapsedSec)}貼上${text}）`;
}

export function buildMinutesPrompt(input: PromptInput): { system: string; user: string } {
  const { meeting, referenceContext } = input;
  const ended = meeting.endedAt ? formatClock(meeting.endedAt) : '現在';

  const meta = [
    `- 標題：${meeting.title}`,
    `- 日期：${formatDate(meeting.startedAt)}`,
    `- 時間：${formatClock(meeting.startedAt)} – ${ended}`,
    `- 逐字稿模型：${meeting.transcribeModel}`,
    `- 摘要模型：${providerLabel(input.provider)}（${meeting.minutes?.model || '尚未產生'}）`,
    `- 分段數：${meeting.segments.filter((s) => s.transcript.trim()).length}`,
    `- 我打的筆記：${meeting.notes.length} 則`,
    `- 截圖：${noteImages(meeting).length} 張（附在訊息最後）`,
  ].join('\n');

  const agenda = meeting.agenda ? `\n## 我事先寫的會議目的\n\n${meeting.agenda}\n` : '';
  const refs = referenceContext.trim()
    ? `\n## 參考資料\n\n${referenceContext.trim()}\n`
    : '';

  const user = `以下是一場會議的素材，請產出會議紀錄。

## 會議資訊

${meta}
${agenda}${refs}
## 我的即時筆記

${notesForPrompt(meeting)}

## 逐字稿

${transcriptForPrompt(meeting) || '（沒有逐字稿，只能依據我的筆記整理）'}

---

# 輸出格式（嚴格照這個結構，不要多也不要少）

## TL;DR
三點，每點一行，講這場會議真正推進了什麼，不要寫流程。

## 決議
- **決議內容** — 依據（引用逐字稿或筆記的關鍵句）。沒有決議就寫「本次沒有形成決議」。

## 待辦
| 事項 | 負責人 | 期限 |
|---|---|---|
| … | … | … |
沒有待辦就寫「無」。負責人或期限未提及時填「待指派」「待確認」。

## 各環節摘要
### <環節名稱，用我標記的名稱；沒標就用內容命名>
150 字以內，寫結論與關鍵數字，不要寫誰先開口。

## 未決與風險
- 還沒結論的問題、被延後的決定、需要外部資訊才能推進的事。

## 我的筆記整理
依類別（決議／待辦／待確認／想法）重排，去重，補上一句上下文讓它看得懂。不要照抄。

## 校正紀錄
- 逐字稿裡被校正的詞：錯 → 對。沒有就寫「無」。`;

  return { system: SYSTEM_PROMPT, user };
}
