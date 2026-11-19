import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { LlmProvider, SettingsView, TranscriberKind } from '../src/core/protocol.ts';
import { DEFAULT_GEMINI_TRANSCRIBE_MODEL } from '../src/core/protocol.ts';

export const projectRoot = path.resolve(import.meta.dirname, '..');
// MEETING_ASSISTANT_DATA_DIR 是給 smoke test 用的隔離目錄
const dataDir = process.env.MEETING_ASSISTANT_DATA_DIR
  ? path.resolve(process.env.MEETING_ASSISTANT_DATA_DIR)
  : path.join(projectRoot, 'server', '.data');
const settingsFile = path.join(dataDir, 'settings.json');
const envFile = path.join(projectRoot, '.env');

const DEFAULT_MODELS: Record<LlmProvider, string> = {
  anthropic: 'claude-sonnet-4-5',
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
  const file = envFile;
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function readFile(): FileSettings {
  if (!existsSync(settingsFile)) return {};
  try {
    return JSON.parse(readFileSync(settingsFile, 'utf8')) as FileSettings;
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
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  writeFileSync(settingsFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  cached = null;
}

let cached: Settings | null = null;
let cachedStamp = '';

/** settings.json 或 .env 被改過就讓快取失效，改 .env 不用重啟伺服器。 */
function fileStamp(): string {
  const one = (file: string): string => {
    try {
      const st = statSync(file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return 'missing';
    }
  };
  return `${one(settingsFile)}|${one(envFile)}`;
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
    meetingsDir: file.meetingsDir || env.MEETINGS_DIR || 'meetings',
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
    meetingsPath: path.resolve(projectRoot, s.meetingsDir),
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
