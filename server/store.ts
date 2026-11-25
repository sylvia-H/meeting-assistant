import { mkdir, readFile, writeFile, readdir, rm, stat, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Meeting, MeetingNote, MeetingSummary, ReferenceFile, Segment } from '../src/core/protocol.ts';
import { formatClock, formatDate, formatDateTime, formatDurationZh } from '../src/core/format.ts';
import { NOTE_KINDS, KIND_ORDER } from '../src/core/notes.ts';
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
