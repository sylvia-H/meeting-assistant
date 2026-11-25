/** 前後端共用的型別定義。server 直接以相對路徑 import。 */

export type MeetingStatus = 'ready' | 'recording' | 'paused' | 'ended';

/** 語音轉錄引擎。 */
export type TranscriberKind = 'typeless' | 'gemini';

export type SegmentStatus = 'open' | 'finalizing' | 'done' | 'failed';

export type NoteKind = 'section' | 'decision' | 'todo' | 'question' | 'idea' | 'note';

export interface MeetingNote {
  id: string;
  kind: NoteKind;
  text: string;
  /** ISO 時間 */
  at: string;
  /** 距會議開始幾秒 */
  elapsedSec: number;
  /** -1 表示當時還沒有任何錄音段 */
  segmentIndex: number;
  /** 貼上的截圖：會議資料夾 images/ 底下的檔名 */
  image?: string;
  /** 會後在紀錄頁補的筆記（不是會議當下打的） */
  postMeeting?: boolean;
  /** 最後一次修改的時間：晚於會議紀錄產生時間，就提醒可以重新產生 */
  editedAt?: string;
}

/** 一場會議最多貼幾張截圖：每張都會送進摘要的 LLM，太多會拖慢、變貴 */
export const MAX_NOTE_IMAGES = 30;
/** 瀏覽器縮圖後的長邊上限（Claude 建議 ≤ 1568px，再大也只會被它縮小） */
export const NOTE_IMAGE_MAX_EDGE = 1568;

export interface Segment {
  index: number;
  label: string | null;
  startedAt: string;
  endedAt: string | null;
  /** 距會議開始幾秒 */
  offsetSec: number;
  transcript: string;
  status: SegmentStatus;
  durationSeconds: number | null;
  billedSeconds: number | null;
  requestId: string | null;
  error: string | null;
  /** 這一段的音量（診斷用）：整體 RMS 與講話時的 95 百分位 */
  audioRms?: number;
  audioPeak?: number;
  /** 使用者在錄音頁或之後手動改過這段逐字稿 */
  edited?: boolean;
  /** 最後一次手動修改的時間：晚於會議紀錄產生時間，就提醒可以重新產生 */
  editedAt?: string;
}

export interface ReferenceFile {
  name: string;
  bytes: number;
  addedAt: string;
}

export interface Attendee {
  name: string;
  /** 身分／角色，例如 PM、RD、SA、廠商 IT；可以空白 */
  role: string;
}

export interface Meeting {
  id: string;
  title: string;
  agenda: string;
  /** 與會者（選填）：幫轉錄辨識人名、幫摘要辨識角色 */
  attendees?: Attendee[];
  startedAt: string;
  endedAt: string | null;
  status: MeetingStatus;
  /** 這場會議用的轉錄引擎（建立會議時決定）。 */
  engine: TranscriberKind;
  /** 轉錄模型 id：Typeless 是 typeless-1.0-*，Gemini 是 gemini-2.5-*。 */
  transcribeModel: string;
  language: string;
  keepAudio: boolean;
  segments: Segment[];
  notes: MeetingNote[];
  references: ReferenceFile[];
  minutes: { generatedAt: string; provider: string; model: string } | null;
}

export interface MeetingSummary {
  id: string;
  title: string;
  startedAt: string;
  endedAt: string | null;
  status: MeetingStatus;
  durationSec: number;
  noteCount: number;
  segmentCount: number;
  hasMinutes: boolean;
}

export interface LiveState {
  status: MeetingStatus;
  recording: boolean;
  elapsedSec: number;
  segmentIndex: number;
  segmentLabel: string | null;
  segmentElapsedSec: number;
  billedSeconds: number;
  pendingSegments: number;
  noteCount: number;
}

export type ClientMessage =
  | { type: 'start' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'note'; kind: NoteKind; text: string; image?: string }
  | { type: 'delete-note'; id: string }
  | { type: 'section'; label: string }
  | { type: 'cut' }
  | { type: 'edit'; index: number; transcript: string }
  | { type: 'end' };

export type ServerMessage =
  | { type: 'hello'; meeting: Meeting; state: LiveState }
  | { type: 'state'; state: LiveState }
  | { type: 'meeting'; meeting: Meeting }
  | { type: 'segment'; segment: Segment }
  | { type: 'note'; note: MeetingNote }
  | { type: 'note-removed'; id: string }
  | { type: 'ended'; meeting: Meeting }
  | { type: 'error'; message: string }
  /** 不算錯誤的提醒（例如額度用完自動換模型），前端用一般提示顯示 */
  | { type: 'notice'; message: string };

export const TYPELESS_MODELS = [
  { id: 'typeless-1.0-lite', label: 'Lite · $0.25 / 小時' },
  { id: 'typeless-1.0-pro', label: 'Pro · $0.50 / 小時' },
  { id: 'typeless-1.0-max', label: 'Max · $2.50 / 小時' },
] as const;

export const TYPELESS_PRICE_PER_HOUR: Record<string, number> = {
  'typeless-1.0-lite': 0.25,
  'typeless-1.0-pro': 0.5,
  'typeless-1.0-max': 2.5,
};

/** Gemini 用 generateContent 的 inline audio 轉錄；免費額度以官方為準。 */
export const GEMINI_TRANSCRIBE_MODELS = [
  { id: 'gemini-3-flash-preview', label: 'gemini-3-flash-preview（建議，速度與品質最平衡）' },
  { id: 'gemini-flash-lite-latest', label: 'gemini-flash-lite-latest（更快，長音檔要留意重複）' },
  { id: 'gemini-3.1-flash-lite', label: 'gemini-3.1-flash-lite（最快，長音檔常卡在重複同一句）' },
  { id: 'gemini-flash-latest', label: 'gemini-flash-latest（品質好，但會思考很久，長音檔不實用）' },
] as const;

export const DEFAULT_GEMINI_TRANSCRIBE_MODEL = 'gemini-3-flash-preview';

export const TRANSCRIBER_LABELS: Record<TranscriberKind, string> = {
  typeless: 'Typeless',
  gemini: 'Gemini',
};

export type LlmProvider = 'anthropic' | 'openai' | 'gemini';

export interface ModelOption {
  id: string;
  label: string;
}

/**
 * 設定頁「摘要用的 LLM」的下拉選單。清單外的模型可以選「其他（自行輸入）」。
 * 價格是每百萬 token 的輸入／輸出（2026-11 官方定價）；一場 45 分鐘會議約 2–3 萬 token 輸入。
 */
export const LLM_MODEL_OPTIONS: Record<LlmProvider, ModelOption[]> = {
  anthropic: [
    { id: 'claude-opus-5-5', label: 'claude-opus-5-5（建議，$4／$20）' },
    { id: 'claude-sonnet-5-5', label: 'claude-sonnet-5-5（便宜一半，$2／$10）' },
    { id: 'claude-haiku-5-5', label: 'claude-haiku-5-5（最便宜，$0.10／$0.50）' },
    { id: 'claude-fable-5-2', label: 'claude-fable-5-2（最強也最貴，$8／$40）' },
  ],
  openai: [
    { id: 'gpt-5', label: 'gpt-5' },
    { id: 'gpt-5-mini', label: 'gpt-5-mini（較便宜）' },
    { id: 'gpt-4.1', label: 'gpt-4.1' },
  ],
  gemini: [
    { id: 'gemini-3.1-flash-lite', label: 'gemini-3.1-flash-lite（預設，快、免費額度）' },
    { id: 'gemini-3-flash-preview', label: 'gemini-3-flash-preview（品質較好）' },
    { id: 'gemini-flash-latest', label: 'gemini-flash-latest（會先思考，較慢）' },
    { id: 'gemini-2.5-pro', label: 'gemini-2.5-pro' },
    { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash' },
  ],
};

export interface SettingsView {
  transcriber: TranscriberKind;
  /** 目前引擎的轉錄模型。 */
  transcribeModel: string;
  /** 兩邊的模型各自記住，切換引擎時不會互相蓋掉。 */
  transcribeModels: Record<TranscriberKind, string>;
  typelessModel: string;
  language: string;
  meetingsDir: string;
  meetingsPath: string;
  autoSegmentSeconds: number;
  keepAudio: boolean;
  llmProvider: LlmProvider;
  llmModel: string;
  llmModels: Record<LlmProvider, string>;
  typelessKeySet: boolean;
  typelessKeyHint: string;
  geminiKeySet: boolean;
  geminiKeyHint: string;
  llmKeys: Record<LlmProvider, { set: boolean; hint: string }>;
  /** transcriber 是「目前引擎是否已設定好 key」。 */
  ready: { transcriber: boolean; typeless: boolean; llm: boolean };
}
