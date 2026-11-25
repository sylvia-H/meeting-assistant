import type { Attendee } from './protocol.ts';

/** 一場會議最多記幾位（再多也幫不了辨識，只會讓提示詞變長） */
export const MAX_ATTENDEES = 40;

/**
 * 把使用者打的與會者文字拆成清單。一行一位，或用頓號、逗號、分號分隔：
 *   王小明（PM）、Amy（廠商 IT）
 *   陳大文 RD
 *   林小華 / SA
 * 括號（全形半形都可）、斜線、冒號、破折號後面是身分；都沒有時，第一個空白後面當身分。
 */
export function parseAttendees(text: string): Attendee[] {
  const out: Attendee[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[\n,，、;；]+/)) {
    const item = raw.trim();
    if (!item) continue;
    let name = item;
    let role = '';
    const paren = item.match(/^(.+?)\s*[（(](.*?)[）)]\s*$/);
    const sep = item.match(/^(.+?)\s*(?:\/|／|:|：|\s-\s|\s–\s)\s*(.+)$/);
    const space = item.match(/^(\S+)\s+(.+)$/);
    if (paren) [, name = item, role = ''] = paren;
    else if (sep) [, name = item, role = ''] = sep;
    else if (space) [, name = item, role = ''] = space;
    name = name.trim().slice(0, 40);
    role = role.trim().slice(0, 40);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, role });
    if (out.length >= MAX_ATTENDEES) break;
  }
  return out;
}

/** 顯示與提示詞用：王小明（PM）、Amy（廠商 IT）、陳大文 */
export function formatAttendees(list: Attendee[] | undefined, sep = '、'): string {
  return (list ?? []).map((a) => (a.role ? `${a.name}（${a.role}）` : a.name)).join(sep);
}
