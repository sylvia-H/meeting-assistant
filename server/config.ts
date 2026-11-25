import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { LlmProvider, SettingsView, TranscriberKind } from '../src/core/protocol.ts';
import { DEFAULT_GEMINI_TRANSCRIBE_MODEL } from '../src/core/protocol.ts';
import { cloudRisk, defaultLocations, locatedMeetingsDir, projectRoot, runningAsExe, settingsDir } from './paths.ts';

export { projectRoot };

// 設定資料夾可以在設定頁換，所以每次都重新算路徑，不在載入時固定
const settingsFile = (): string => path.join(settingsDir(), 'settings.json');

/** 讀 .env 的位置：設定資料夾；exe 版另外讀 exe 旁邊的那份（設定資料夾優先）。 */
function envFiles(): string[] {
  const files = [path.join(settingsDir(), '.env')];
  if (runningAsExe) files.push(path.join(projectRoot, '.env'));
  return files;
}

const DEFAULT_MODELS: Record<LlmProvider, string> = {
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-5',
  gemini: 'gemini-3.1-flash-lite',
};

interface FileSettings {
  transcriber?: TranscriberKind;
  /** Gemini 轉錄模型；Typeless 的模型放在 typelessModel。 */
  transcribeModel?: string;
  geminiApiKey?: string;
  typelessApiKey?: string;
  typelessModel?: string;
  language?: string;
  llmProvider?: LlmProvider;
  llmKeys?: Partial<Record<LlmProvider, string>>;
  llmModels?: Partial<Record<LlmProvider, string>>;
  meetingsDir?: string;
  autoSegmentSeconds?: number;
  keepAudio?: boolean;
}

export interface Settings {
  transcriber: TranscriberKind;
  transcribeModel: string;
  transcribeModels: Record<TranscriberKind, string>;
  geminiApiKey: string;
  typelessApiKey: string;
  typelessModel: string;
  typelessWsUrl: string;
  language: string;
  llmProvider: LlmProvider;
  llmApiKey: string;
  llmModel: string;
  llmModels: Record<LlmProvider, string>;
  meetingsDir: string;
  autoSegmentSeconds: number;
  keepAudio: boolean;
}

function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  // 清單前面的優先：反著讀，讓前面的檔案蓋掉後面的
  for (const file of [...envFiles()].reverse()) {
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

function readFile(): FileSettings {
  const file = settingsFile();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as FileSettings;
  } catch {
    return {};
  }
}

export function writeSettings(patch: Partial<FileSettings>): void {
  const current = readFile();
  const next: FileSettings = {
    ...current,
    ...patch,
    llmKeys: { ...(current.llmKeys ?? {}), ...(patch.llmKeys ?? {}) },
    llmModels: { ...(current.llmModels ?? {}), ...(patch.llmModels ?? {}) },
  };
  const dir = settingsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(settingsFile(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  cached = null;
}

let cached: Settings | null = null;
let cachedStamp = '';

/** settings.json 或 .env 被改過（或設定資料夾換了）就讓快取失效，改 .env 不用重啟伺服器。 */
function fileStamp(): string {
  const one = (file: string): string => {
    try {
      const st = statSync(file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return 'missing';
    }
  };
  const files = [settingsFile(), ...envFiles()];
  return files.map((file) => `${file}=${one(file)}`).join('|');
}

type EnvRecord = Record<string, string | undefined>;

function llmEnvKey(env: EnvRecord, provider: LlmProvider): string | undefined {
  if (provider === 'anthropic') return env.ANTHROPIC_API_KEY;
  if (provider === 'openai') return env.OPENAI_API_KEY;
  return env.GEMINI_API_KEY;
}

/** 目前設定的 provider 對應的 LLM key。優先序：設定頁 > .env > Gemini 轉錄用的那把。 */
function keyFor(file: FileSettings, env: EnvRecord, provider: LlmProvider): string {
  const fromFile = file.llmKeys?.[provider];
  if (fromFile) return fromFile;
  const fromEnv = llmEnvKey(env, provider);
  if (fromEnv) return fromEnv;
  if (provider === 'gemini') return file.geminiApiKey || env.GEMINI_API_KEY || '';
  return '';
}

/** key 是從哪裡來的；設定頁的「測試連線」會把這個一起顯示，避免搞不清楚吃到哪一把。 */
export function llmKeySource(provider: LlmProvider): 'settings' | 'env' | 'shared' | 'none' {
  const file = readFile();
  const env = { ...readEnvFile(), ...process.env } as EnvRecord;
  if (file.llmKeys?.[provider]) return 'settings';
  if (llmEnvKey(env, provider)) return 'env';
  if (provider === 'gemini' && (file.geminiApiKey || env.GEMINI_API_KEY)) return 'shared';
  return 'none';
}

/** 指定 provider 的 LLM key，不受目前選定的 provider 影響。 */
export function llmKeyFor(provider: LlmProvider): string {
  const env = { ...readEnvFile(), ...process.env } as EnvRecord;
  return keyFor(readFile(), env, provider);
}

export function settings(): Settings {
  const stamp = fileStamp();
  if (cached && cachedStamp === stamp) return cached;
  const file = readFile();
  const env = { ...readEnvFile(), ...process.env } as Record<string, string | undefined>;
  // 沒在設定頁存過 provider 時，用「有 key 的那一家」，避免明明只有 Gemini key 卻預設去測 Anthropic
  const llmProvider: LlmProvider =
    file.llmProvider ??
    (['anthropic', 'openai', 'gemini'] as LlmProvider[]).find((p) => keyFor(file, env, p)) ??
    'anthropic';
  const llmModels: Record<LlmProvider, string> = {
    anthropic: file.llmModels?.anthropic ?? DEFAULT_MODELS.anthropic,
    openai: file.llmModels?.openai ?? DEFAULT_MODELS.openai,
    gemini: file.llmModels?.gemini ?? DEFAULT_MODELS.gemini,
  };
  const transcriber: TranscriberKind =
    file.transcriber === 'gemini' || file.transcriber === 'typeless'
      ? file.transcriber
      : env.TRANSCRIBER === 'gemini'
        ? 'gemini'
        : 'typeless';
  const typelessModel = file.typelessModel || 'typeless-1.0-pro';
  const geminiModel = file.transcribeModel || env.GEMINI_TRANSCRIBE_MODEL || DEFAULT_GEMINI_TRANSCRIBE_MODEL;
  // 一把 Gemini key 同時給轉錄與摘要用；優先序：專用欄位 > 環境變數 > LLM 的 Gemini key
  const geminiApiKey = file.geminiApiKey || env.GEMINI_API_KEY || file.llmKeys?.gemini || '';

  cached = {
    transcriber,
    transcribeModel: transcriber === 'gemini' ? geminiModel : typelessModel,
    transcribeModels: { typeless: typelessModel, gemini: geminiModel },
    geminiApiKey,
    typelessApiKey: file.typelessApiKey || env.TYPELESS_API_KEY || '',
    typelessModel,
    typelessWsUrl: env.TYPELESS_WS_URL || 'wss://api.typelessapi.com/v1/transcribe/stream',
    language: file.language ?? 'zh',
    llmProvider,
    llmApiKey: keyFor(file, env, llmProvider),
    llmModel: llmModels[llmProvider],
    llmModels,
    // 優先序：引導頁／設定頁選的位置 > settings.json（測試與舊資料）> .env > 預設的「文件\Meeting Assistant」
    meetingsDir: locatedMeetingsDir() || file.meetingsDir || env.MEETINGS_DIR || defaultLocations().meetingsDir,
    autoSegmentSeconds: Math.min(280, Math.max(60, file.autoSegmentSeconds ?? 180)),
    keepAudio: file.keepAudio ?? false,
  };
  cachedStamp = stamp;
  return cached;
}

function mask(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return `••••${key.slice(-4)}`;
}

let portNote: string | null = null;

/** 預設 port 被占用、自動換了 port 時，設定頁要顯示的小字。 */
export function setPortNote(note: string | null): void {
  portNote = note;
}

/** 會議資料夾的完整路徑；相對路徑以設定資料夾為基準。 */
export function meetingsPath(): string {
  return path.resolve(settingsDir(), settings().meetingsDir);
}

export function settingsView(): SettingsView {
  const s = settings();
  const llmKeys = {} as SettingsView['llmKeys'];
  for (const provider of ['anthropic', 'openai', 'gemini'] as LlmProvider[]) {
    const key = llmKeyFor(provider);
    llmKeys[provider] = { set: Boolean(key), hint: mask(key) };
  }
  return {
    transcriber: s.transcriber,
    transcribeModel: s.transcribeModel,
    transcribeModels: s.transcribeModels,
    typelessModel: s.typelessModel,
    language: s.language,
    meetingsDir: s.meetingsDir,
    meetingsPath: meetingsPath(),
    settingsPath: settingsDir(),
    settingsCloudRisk: cloudRisk(settingsDir()),
    portNote,
    autoSegmentSeconds: s.autoSegmentSeconds,
    keepAudio: s.keepAudio,
    llmProvider: s.llmProvider,
    llmModel: s.llmModel,
    llmModels: s.llmModels,
    typelessKeySet: Boolean(s.typelessApiKey),
    typelessKeyHint: mask(s.typelessApiKey),
    geminiKeySet: Boolean(s.geminiApiKey),
    geminiKeyHint: mask(s.geminiApiKey),
    llmKeys,
    ready: {
      transcriber: s.transcriber === 'gemini' ? Boolean(s.geminiApiKey) : Boolean(s.typelessApiKey),
      typeless: Boolean(s.typelessApiKey),
      llm: Boolean(s.llmApiKey),
    },
  };
}

export function invalidateSettings(): void {
  cached = null;
}
