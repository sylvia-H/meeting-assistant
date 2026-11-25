import { mkdir, readFile, writeFile, readdir, rm, stat, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Meeting, MeetingNote, MeetingSummary, ReferenceFile, Segment } from '../src/core/protocol.ts';
import { formatClock, formatDate, formatDateTime, formatDurationZh } from '../src/core/format.ts';
import { NOTE_KINDS, KIND_ORDER } from '../src/core/notes.ts';
import { parseAttendees } from '../src/core/attendees.ts';
import { projectRoot, settings } from './config.ts';

const TEXT_EXT = new Set([
  '.md', '.txt', '.json', '.csv', '.tsv', '.yaml', '.yml', '.html', '.htm',
  '.ts', '.js', '.py', '.sql', '.xml', '.log', '.srt', '.vtt',
]);

export function meetingsRoot(): string {
  return path.resolve(projectRoot, settings().meetingsDir);
}

export function meetingDir(id: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error('invalid meeting id');
  return path.join(meetingsRoot(), id);
}

const pad = (n: number): string => String(n).padStart(2, '0');

function slugify(title: string): string {
  const ascii = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return ascii.slice(0, 40) || 'meeting';
}

export async function ensureRoot(): Promise<void> {
  await mkdir(meetingsRoot(), { recursive: true });
}

export async function createMeeting(input: {
  title: string;
  startedAt?: string;
  agenda?: string;
  attendees?: string;
}): Promise<Meeting> {
  await ensureRoot();
  const s = settings();
  const startedAt = input.startedAt ?? new Date().toISOString();
  const d = new Date(startedAt);
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${slugify(input.title)}`;
  let id = base;
  let n = 2;
  while (existsSync(path.join(meetingsRoot(), id))) {
    id = `${base}-${n}`;
    n += 1;
  }
  const meeting: Meeting = {
    id,
    title: input.title.trim() || '未命名會議',
    agenda: (input.agenda ?? '').trim(),
    attendees: parseAttendees(input.attendees ?? ''),
    startedAt,
    endedAt: null,
    status: 'ready',
    engine: s.transcriber,
    transcribeModel: s.transcribeModel,
    language: s.language,
    keepAudio: s.keepAudio,
    segments: [],
    notes: [],
    references: [],
    minutes: null,
  };
  await mkdir(meetingDir(id), { recursive: true });
  await mkdir(path.join(meetingDir(id), 'reference'), { recursive: true });
  await saveMeeting(meeting);
  await writeTranscript(meeting);
  await writeNotes(meeting);
  return meeting;
}

/** 先寫暫存檔再改名，避免讀到寫一半的 JSON（摘要時會同時讀） */
let writeSeq = 0;
async function writeFileAtomic(file: string, content: string): Promise<void> {
  // 暫存檔名要唯一：end() 與背景的逐字稿存檔可能同時寫同一個檔案
  const tmp = `${file}.${process.pid}.${writeSeq++}.tmp`;
  await writeFile(tmp, content, 'utf8');
  // Windows：目標檔正被讀取（瀏覽器抓 meeting.json、防毒掃描、另一個寫入剛好在改名）時
  // rename 會回 EPERM／EBUSY／EACCES，等一下通常就好；重試用盡才真的失敗
  const waits = [30, 80, 200, 500];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const wait = waits[attempt];
      if (wait === undefined || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

export async function saveMeeting(meeting: Meeting): Promise<void> {
  const dir = meetingDir(meeting.id);
  await mkdir(dir, { recursive: true });
  await writeFileAtomic(path.join(dir, 'meeting.json'), `${JSON.stringify(meeting, null, 2)}\n`);
}

export async function readMeeting(id: string): Promise<Meeting> {
  const raw = await readFile(path.join(meetingDir(id), 'meeting.json'), 'utf8');
  const stored = JSON.parse(raw) as Meeting & { typelessModel?: string };
  // 舊資料只有 typelessModel；讀進來時補成新的 engine / transcribeModel。
  return {
    ...stored,
    engine: stored.engine ?? 'typeless',
    transcribeModel: stored.transcribeModel ?? stored.typelessModel ?? '',
  };
}

export async function meetingExists(id: string): Promise<boolean> {
  try {
    await stat(path.join(meetingDir(id), 'meeting.json'));
    return true;
  } catch {
    return false;
  }
}

function meetingDurationSec(m: Meeting): number {
  const end = m.endedAt ? new Date(m.endedAt).getTime() : Date.now();
  return Math.max(0, Math.round((end - new Date(m.startedAt).getTime()) / 1000));
}

export async function listMeetings(): Promise<MeetingSummary[]> {
  await ensureRoot();
  const entries = await readdir(meetingsRoot(), { withFileTypes: true });
  const out: MeetingSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const m = await readMeeting(entry.name);
      out.push({
        id: m.id,
        title: m.title,
        startedAt: m.startedAt,
        endedAt: m.endedAt,
        status: m.status,
        durationSec: meetingDurationSec(m),
        noteCount: m.notes.length,
        segmentCount: m.segments.filter((s) => s.transcript.trim()).length,
        hasMinutes: Boolean(m.minutes),
      });
    } catch {
      // 不是會議資料夾，略過
    }
  }
  out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return out;
}

export async function deleteMeeting(id: string): Promise<void> {
  await rm(meetingDir(id), { recursive: true, force: true });
}

function safeName(name: string): string {
  return path.basename(name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'file';
}

export async function addReferences(
  id: string,
  files: { name: string; base64: string }[],
): Promise<ReferenceFile[]> {
  const meeting = await readMeeting(id);
  const dir = path.join(meetingDir(id), 'reference');
  await mkdir(dir, { recursive: true });
  const added: ReferenceFile[] = [];
  for (const file of files) {
    const name = safeName(file.name);
    const buf = Buffer.from(file.base64, 'base64');
    await writeFile(path.join(dir, name), buf);
    const record: ReferenceFile = { name, bytes: buf.length, addedAt: new Date().toISOString() };
    added.push(record);
    meeting.references = meeting.references.filter((r) => r.name !== name);
    meeting.references.push(record);
  }
  await saveMeeting(meeting);
  return added;
}

export async function removeReference(id: string, name: string): Promise<void> {
  const meeting = await readMeeting(id);
  const target = safeName(name);
  await rm(path.join(meetingDir(id), 'reference', target), { force: true });
  meeting.references = meeting.references.filter((r) => r.name !== target);
  await saveMeeting(meeting);
}

export async function readReferenceContext(id: string): Promise<string> {
  const dir = path.join(meetingDir(id), 'reference');
  if (!existsSync(dir)) return '';
  const names = await readdir(dir);
  const parts: string[] = [];
  let total = 0;
  for (const name of names.sort()) {
    if (!TEXT_EXT.has(path.extname(name).toLowerCase())) continue;
    let text = await readFile(path.join(dir, name), 'utf8');
    if (text.length > 8000) text = `${text.slice(0, 8000)}\n…（已截斷）`;
    if (total + text.length > 40000) break;
    total += text.length;
    parts.push(`### 檔案：${name}\n\n${text}`);
  }
  return parts.join('\n\n');
}

function transcriptBlocks(meeting: Meeting): string[] {
  const blocks: string[] = [];
  for (const seg of meeting.segments) {
    const text = seg.transcript.trim();
    if (!text) continue;
    const title = seg.label ? `環節：${seg.label}` : '（未標記環節）';
    const clock = formatClock(seg.startedAt);
    blocks.push(`### ${pad(seg.index + 1)} · ${title} · ${clock}\n\n${text}`);
  }
  return blocks;
}

export async function writeTranscript(meeting: Meeting): Promise<void> {
  const end = meeting.endedAt ? formatDateTime(meeting.endedAt) : '（進行中）';
  const header = [
    `# ${formatDate(meeting.startedAt)} ${meeting.title}`,
    '',
    `- 開始：${formatDateTime(meeting.startedAt)}`,
    `- 結束：${end}`,
    `- 時長：${formatDurationZh(meetingDurationSec(meeting))}`,
    `- 轉錄模型：${meeting.transcribeModel}`,
    `- 分段數：${transcriptBlocks(meeting).length}`,
    '',
    `<!-- 這份逐字稿由 ${meeting.engine === 'gemini' ? 'Gemini' : 'Typeless'} 轉錄；打字筆記請看 notes.md -->`,
    '',
  ].join('\n');
  const body = transcriptBlocks(meeting).join('\n\n');
  await writeFileAtomic(path.join(meetingDir(meeting.id), 'transcript.md'), `${header}${body}\n`);
}

export async function writeNotes(meeting: Meeting): Promise<void> {
  const lines = [
    `# 筆記 · ${formatDate(meeting.startedAt)} ${meeting.title}`,
    '',
    `共 ${meeting.notes.length} 則。時間為距會議開始的分秒。`,
    '',
  ];
  for (const kind of KIND_ORDER) {
    const group = meeting.notes.filter((n) => n.kind === kind);
    if (!group.length) continue;
    lines.push(`## ${NOTE_KINDS[kind].label}`, '');
    for (const note of group) {
      const text = note.text.replace(/\n/g, ' ') || (note.image ? '（截圖）' : '');
      lines.push(`- \`${formatDurationZh(note.elapsedSec)}\` ${text}`);
      // 用相對路徑嵌入，在 Obsidian／VS Code 打開會議資料夾就看得到圖
      if (note.image) lines.push(`  ![](images/${note.image})`);
    }
    lines.push('');
  }
  await writeFileAtomic(path.join(meetingDir(meeting.id), 'notes.md'), `${lines.join('\n')}\n`);
}

export interface MeetingInfoPatch {
  title?: string;
  startedAt?: string;
  /** 與會者文字（一行一位或頓號分隔），任何時候都能改 */
  attendees?: string;
}

/**
 * 改會議名稱／預定開始時間。資料夾名稱（meeting.id）不跟著改：已開的頁面、
 * Obsidian 裡的連結、錄音中的存檔都靠它。開始錄音後時間鎖定：計時器與每則筆記的
 * 「第幾分鐘」都從 startedAt 算，事後改會讓整條時間軸錯位。
 */
export function applyInfoPatch(meeting: Meeting, patch: MeetingInfoPatch): void {
  if (patch.title !== undefined) {
    const title = patch.title.replace(/\s+/g, ' ').trim();
    if (!title) throw new Error('會議名稱不能是空的');
    if (title.length > 80) throw new Error('會議名稱最多 80 個字');
    meeting.title = title;
  }
  if (patch.attendees !== undefined) {
    meeting.attendees = parseAttendees(patch.attendees);
  }
  if (patch.startedAt !== undefined) {
    const at = new Date(patch.startedAt);
    if (Number.isNaN(at.getTime())) throw new Error('開始時間格式不對');
    if (meeting.status !== 'ready' || meeting.segments.length > 0) {
      throw new Error('已經開始錄音，開始時間不能再改（計時與筆記時間點都依它計算）');
    }
    meeting.startedAt = at.toISOString();
  }
}

/** 沒有進行中的連線時（紀錄頁、會後）直接改檔案；minutes.md 的 frontmatter 標題一起換 */
export function updateMeetingInfo(id: string, patch: MeetingInfoPatch): Promise<Meeting> {
  return withMeetingLock(id, () => updateMeetingInfoNow(id, patch));
}

async function updateMeetingInfoNow(id: string, patch: MeetingInfoPatch): Promise<Meeting> {
  const meeting = await readMeeting(id);
  applyInfoPatch(meeting, patch);
  await saveMeeting(meeting);
  await writeTranscript(meeting);
  await writeNotes(meeting);
  if (patch.title !== undefined && meeting.minutes) {
    const minutes = await readMinutes(id);
    if (minutes.startsWith('---')) {
      await writeMinutes(meeting, minutes.replace(/^title: .*$/m, `title: ${meeting.title}`));
    }
  }
  return meeting;
}

// ── 筆記：會後修改／新增／刪除（錄音頁開著時由 LiveSession.mutate 套用同一套規則） ──

const NOTE_KIND_SET = new Set<MeetingNote['kind']>(['section', 'decision', 'todo', 'question', 'idea', 'note']);
const MAX_NOTE_CHARS = 4000;

function cleanNoteText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim().slice(0, MAX_NOTE_CHARS);
}

export function applyNoteEdit(
  meeting: Meeting,
  noteId: string,
  patch: { text?: string; kind?: string },
): MeetingNote {
  const note = meeting.notes.find((n) => n.id === noteId);
  if (!note) throw new Error('找不到這則筆記（可能已經被刪掉）');
  if (patch.kind !== undefined) {
    if (!NOTE_KIND_SET.has(patch.kind as MeetingNote['kind'])) throw new Error(`不認得的筆記類型：${patch.kind}`);
    note.kind = patch.kind as MeetingNote['kind'];
  }
  if (patch.text !== undefined) {
    const text = cleanNoteText(patch.text);
    if (!text && !note.image) throw new Error('筆記不能是空的；不要的話用刪除');
    note.text = text;
  }
  note.editedAt = new Date().toISOString();
  return note;
}

/** 會後補的筆記：時間點放在會議結尾，標成會後補充 */
export function addPostMeetingNote(meeting: Meeting, kind: string, text: string): MeetingNote {
  if (!NOTE_KIND_SET.has(kind as MeetingNote['kind'])) throw new Error(`不認得的筆記類型：${kind}`);
  const cleaned = cleanNoteText(text);
  if (!cleaned) throw new Error('筆記不能是空的');
  const end = meeting.endedAt ? new Date(meeting.endedAt).getTime() : Date.now();
  const elapsed = Math.max(0, Math.round((end - new Date(meeting.startedAt).getTime()) / 1000));
  const lastSeg = meeting.segments.length ? Math.max(...meeting.segments.map((s) => s.index)) : -1;
  const note = newNote(kind as MeetingNote['kind'], cleaned, elapsed, lastSeg);
  note.postMeeting = true;
  note.editedAt = note.at;
  meeting.notes.push(note);
  return note;
}

/** 刪一則筆記，回傳被刪的那則（有截圖時呼叫端要一併刪檔） */
export function removeNoteFrom(meeting: Meeting, noteId: string): MeetingNote | null {
  const note = meeting.notes.find((n) => n.id === noteId) ?? null;
  if (note) meeting.notes = meeting.notes.filter((n) => n.id !== noteId);
  return note;
}

/**
 * 同一場會議的「讀檔 → 改 → 寫回」要排隊：紀錄頁改內容和換類型幾乎同時送出時，
 * 兩個請求各自讀到舊檔、各自寫回，後寫的會把先寫的修改蓋掉。
 */
const meetingLocks = new Map<string, Promise<unknown>>();

export function withMeetingLock<T>(id: string, task: () => Promise<T>): Promise<T> {
  const prev = meetingLocks.get(id) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(task);
  const tail = run.catch(() => undefined);
  meetingLocks.set(id, tail);
  void tail.then(() => {
    if (meetingLocks.get(id) === tail) meetingLocks.delete(id);
  });
  return run;
}

/** 會後（沒有進行中的連線）直接改檔：套用變更、存 meeting.json 與 notes.md */
export function mutateMeetingFile<T>(id: string, fn: (meeting: Meeting) => T): Promise<{ meeting: Meeting; result: T }> {
  return withMeetingLock(id, async () => {
    const meeting = await readMeeting(id);
    const result = fn(meeting);
    await saveMeeting(meeting);
    await writeTranscript(meeting);
    await writeNotes(meeting);
    return { meeting, result };
  });
}

/** 一段 280 秒的逐字稿約 1–2 千字，留足空間給補充 */
const MAX_EDIT_CHARS = 50_000;

/**
 * 手動校正一段逐字稿（錄音頁與紀錄頁共用同一套規則）。
 * 只收已經有結果的段落：收音中／轉錄中的還沒有文字，改了也會被轉錄結果蓋掉。
 * 回傳 false 代表內容沒變，不用存檔。
 */
export function applyTranscriptEdit(meeting: Meeting, index: number, text: string): boolean {
  const seg = meeting.segments.find((s) => s.index === index);
  if (!seg) throw new Error(`找不到第 ${index + 1} 段`);
  if (seg.status !== 'done' && seg.status !== 'failed') {
    throw new Error(`第 ${index + 1} 段還在轉錄，等文字出來再改`);
  }
  const cleaned = text.replace(/\r\n?/g, '\n').replace(/\s+$/, '').slice(0, MAX_EDIT_CHARS);
  if (cleaned === seg.transcript) return false;
  seg.transcript = cleaned;
  seg.edited = true;
  seg.editedAt = new Date().toISOString();
  return true;
}

/** 會後（沒有進行中的連線）改逐字稿：直接改檔，transcript.md 一起更新 */
export function editTranscriptFile(id: string, index: number, text: string): Promise<Meeting> {
  return withMeetingLock(id, async () => {
    const meeting = await readMeeting(id);
    if (applyTranscriptEdit(meeting, index, text)) {
      await saveMeeting(meeting);
      await writeTranscript(meeting);
    }
    return meeting;
  });
}

export async function writeMinutes(meeting: Meeting, markdown: string): Promise<void> {
  await writeFileAtomic(
    path.join(meetingDir(meeting.id), 'minutes.md'),
    markdown.endsWith('\n') ? markdown : `${markdown}\n`,
  );
}

export async function readMinutes(id: string): Promise<string> {
  try {
    return await readFile(path.join(meetingDir(id), 'minutes.md'), 'utf8');
  } catch {
    return '';
  }
}

export function newNote(
  kind: MeetingNote['kind'],
  text: string,
  elapsedSec: number,
  segmentIndex: number,
  image?: string,
): MeetingNote {
  return {
    id: `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    kind,
    text,
    at: new Date().toISOString(),
    elapsedSec,
    segmentIndex,
    ...(image ? { image } : {}),
  };
}

// ── 筆記截圖 ──────────────────────────────────────────────
const IMAGE_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};
const IMAGE_MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
/** 瀏覽器已經縮過圖；這是防呆上限，不是正常大小（正常一張 200–400 KB） */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_NAME = /^img-[0-9a-z]+-[0-9a-z]{4}\.(jpg|png|webp)$/;

export function imagesDir(id: string): string {
  return path.join(meetingDir(id), 'images');
}

/** 只接受我們自己產生的檔名，擋掉 ../ 之類的路徑穿越 */
export function isImageName(name: string): boolean {
  return IMAGE_NAME.test(name);
}

export function imageMime(name: string): string {
  return IMAGE_MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

export async function countImages(id: string): Promise<number> {
  const dir = imagesDir(id);
  if (!existsSync(dir)) return 0;
  return (await readdir(dir)).filter(isImageName).length;
}

/** 存一張截圖，回傳檔名。數量上限由呼叫端檢查。 */
export async function saveImage(id: string, mime: string, data: Buffer): Promise<string> {
  const ext = IMAGE_EXT[mime];
  if (!ext) throw new Error(`不支援的圖片格式：${mime}（只收 JPEG／PNG／WebP）`);
  if (!data.length) throw new Error('圖片是空的');
  if (data.length > MAX_IMAGE_BYTES) {
    throw new Error(`圖片太大（${(data.length / 1024 / 1024).toFixed(1)} MB），上限 8 MB`);
  }
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  const name = `img-${Date.now().toString(36)}-${rand}${ext}`;
  await mkdir(imagesDir(id), { recursive: true });
  await writeFile(path.join(imagesDir(id), name), data);
  return name;
}

export async function removeImage(id: string, name: string): Promise<void> {
  if (!isImageName(name)) return;
  await rm(path.join(imagesDir(id), name), { force: true });
}

export async function readImage(id: string, name: string): Promise<Buffer | null> {
  if (!isImageName(name)) return null;
  try {
    return await readFile(path.join(imagesDir(id), name));
  } catch {
    return null;
  }
}

export function emptySegment(index: number, label: string | null, offsetSec: number): Segment {
  return {
    index,
    label,
    startedAt: new Date().toISOString(),
    endedAt: null,
    offsetSec,
    transcript: '',
    status: 'open',
    durationSeconds: null,
    billedSeconds: null,
    requestId: null,
    error: null,
  };
}
