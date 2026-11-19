import type { NoteKind } from './protocol.ts';

export interface KindMeta {
  label: string;
  /** 單一符號前綴 */
  symbol: string;
  /** 字母別名前綴（含冒號） */
  alias: string;
  hint: string;
  color: string;
}

export const NOTE_KINDS: Record<NoteKind, KindMeta> = {
  section: {
    label: '環節',
    symbol: '#',
    alias: 's:',
    hint: '標記會議進入哪個環節，同時切段',
    color: '#a78bfa',
  },
  decision: {
    label: '決議',
    symbol: '>',
    alias: 'd:',
    hint: '已達成共識的結論',
    color: '#34d399',
  },
  todo: {
    label: '待辦',
    symbol: '!',
    alias: 't:',
    hint: '會後要做的事',
    color: '#fbbf24',
  },
  question: {
    label: '待確認',
    symbol: '?',
    alias: 'q:',
    hint: '還沒答案的問題',
    color: '#60a5fa',
  },
  idea: {
    label: '想法',
    symbol: '*',
    alias: 'i:',
    hint: '靈感、延伸念頭',
    color: '#f472b6',
  },
  note: {
    label: '筆記',
    symbol: '-',
    alias: 'n:',
    hint: '一般紀錄',
    color: '#94a3b8',
  },
};

export const KIND_ORDER: NoteKind[] = ['section', 'decision', 'todo', 'question', 'idea', 'note'];

/** 全形符號 → 半形 */
const FULLWIDTH: Record<string, string> = {
  '＃': '#',
  '＞': '>',
  '！': '!',
  '？': '?',
  '＊': '*',
  '－': '-',
  '：': ':',
  '／': '/',
};

export function normalizeSymbols(text: string): string {
  return text.replace(/[＃＞！？＊－：／]/g, (ch) => FULLWIDTH[ch] ?? ch);
}

export type ParsedInput =
  | { type: 'note'; kind: NoteKind; text: string; prefix: string }
  | { type: 'command'; command: 'pause' | 'resume' | 'end' | 'seg'; arg: string; raw: string };

const COMMANDS: Record<string, 'pause' | 'resume' | 'end' | 'seg'> = {
  p: 'pause',
  pause: 'pause',
  r: 'resume',
  resume: 'resume',
  end: 'end',
  stop: 'end',
  seg: 'seg',
  section: 'seg',
};

/**
 * 解析即時輸入：
 *   # 需求確認      → 環節
 *   t: 寄報價給 Amy  → 待辦
 *   /pause          → 指令
 *   其他            → 一般筆記
 */
export function parseInput(raw: string): ParsedInput {
  const text = normalizeSymbols(raw).trim();

  if (text.startsWith('/')) {
    const body = text.slice(1).trim();
    const [head = '', ...rest] = body.split(/\s+/);
    const command = COMMANDS[head.toLowerCase()];
    if (command) return { type: 'command', command, arg: rest.join(' '), raw: text };
    return { type: 'note', kind: 'note', text, prefix: '' };
  }

  for (const [kind, meta] of Object.entries(NOTE_KINDS) as [NoteKind, KindMeta][]) {
    if (text.toLowerCase().startsWith(meta.alias)) {
      return { type: 'note', kind, text: text.slice(meta.alias.length).trim(), prefix: meta.alias };
    }
    if (text.startsWith(meta.symbol) && !text.startsWith(`${meta.symbol}${meta.symbol}`)) {
      return { type: 'note', kind, text: text.slice(1).trim(), prefix: meta.symbol };
    }
  }

  // 有前綴但沒內容 → 視為空輸入，交給呼叫端處理
  return { type: 'note', kind: 'note', text, prefix: '' };
}

export function kindMeta(kind: NoteKind): KindMeta {
  return NOTE_KINDS[kind];
}
