import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { LlmProvider, SettingsView, TranscriberKind } from '../src/core/protocol.ts';
import { DEFAULT_GEMINI_TRANSCRIBE_MODEL } from '../src/core/protocol.ts';

export const projectRoot = path.resolve(import.meta.dirname, '..');
// MEETING_ASSISTANT_DATA_DIR 是給 smoke test 用的隔離目錄
const dataDir = process.env.MEETING_ASSISTANT_DATA_DIR
  ? path.resolve(process.env.MEETING_ASSISTANT_DATA_DIR)
  : path.join(projectRoot, 'server', '.data');
const settingsFile = path.join(dataDir, 'settings.json');

const DEFAULT_MODELS: Record<LlmProvider, string> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-5',
  gemini: 'gemini-2.5-pro',
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
  const file = path.join(projectRoot, '.env');
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

export function settings(): Settings {
  if (cached) return cached;
  const file = readFile();
  const env = { ...readEnvFile(), ...process.env } as Record<string, string | undefined>;
  const llmProvider = file.llmProvider ?? 'anthropic';
  const providerEnvKey: Record<LlmProvider, string | undefined> = {
    anthropic: env.ANTHROPIC_API_KEY,
    openai: env.OPENAI_API_KEY,
    gemini: env.GEMINI_API_KEY,
  };
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
    llmApiKey:
      llmProvider === 'gemini'
        ? file.llmKeys?.gemini || env.GEMINI_API_KEY || file.geminiApiKey || ''
        : file.llmKeys?.[llmProvider] || providerEnvKey[llmProvider] || '',
    llmModel: file.llmModels?.[llmProvider] ?? DEFAULT_MODELS[llmProvider],
    llmModels,
    meetingsDir: file.meetingsDir || env.MEETINGS_DIR || 'meetings',
    autoSegmentSeconds: Math.min(280, Math.max(60, file.autoSegmentSeconds ?? 180)),
    keepAudio: file.keepAudio ?? false,
  };
  return cached;
}

function mask(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return `••••${key.slice(-4)}`;
}

export function settingsView(): SettingsView {
  const s = settings();
  const file = readFile();
  const env = { ...readEnvFile(), ...process.env } as Record<string, string | undefined>;
  const providerEnvKey: Record<LlmProvider, string | undefined> = {
    anthropic: env.ANTHROPIC_API_KEY,
    openai: env.OPENAI_API_KEY,
    gemini: env.GEMINI_API_KEY,
  };
  const llmKeys = {} as SettingsView['llmKeys'];
  for (const provider of ['anthropic', 'openai', 'gemini'] as LlmProvider[]) {
    const key =
      file.llmKeys?.[provider] ||
      providerEnvKey[provider] ||
      (provider === 'gemini' ? file.geminiApiKey || '' : '');
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
