/**
 * ffmpeg 的薄封裝：只做「把長錄音切成幾段」這件事。
 *
 * 為什麼要真的切檔：Gemini 對「請只轉錄 30:00–60:00」這種時間範圍指令很不聽話，
 * 常常每次都從頭開始轉一點點就停。切成獨立的檔案，模型就沒有「從頭」的空間。
 *
 * 這台機器沒有系統 ffmpeg 也能用：優先用 FFMPEG_PATH，其次找專案內
 * tools/ffmpeg、%LOCALAPPDATA%\meeting-assistant\ffmpeg、%TEMP% 下解開的 portable 版。
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectRoot } from './config.ts';
import { mediaDurationSec } from './gemini-file.ts';

export class FfmpegMissingError extends Error {
  constructor() {
    super(
      '找不到 ffmpeg，無法把長錄音切段。\n' +
        '  解法 1：把 FFMPEG_PATH 指到 ffmpeg.exe（可寫進 .env）\n' +
        '  解法 2：下載 portable 版解壓到 tools\\ffmpeg\\bin\\ffmpeg.exe\n' +
        '           https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip\n' +
        '  解法 3：winget install Gyan.FFmpeg',
    );
  }
}

/** 從一個資料夾往下找 ffmpeg.exe（最多兩層），找不到回 null。 */
function findExe(dir: string, depth = 2): string | null {
  const direct = path.join(dir, 'ffmpeg.exe');
  if (existsSync(direct)) return direct;
  const nested = path.join(dir, 'bin', 'ffmpeg.exe');
  if (existsSync(nested)) return nested;
  if (depth <= 0 || !existsSync(dir)) return null;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const hit = findExe(path.join(dir, entry.name), depth - 1);
      if (hit) return hit;
    }
  } catch {
    return null;
  }
  return null;
}

/** 回傳可執行的 ffmpeg 指令，找不到就回 null。 */
export function resolveFfmpeg(): string | null {
  const fromEnv = process.env.FFMPEG_PATH?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const roots = [
    path.join(projectRoot, 'tools', 'ffmpeg'),
    path.join(os.homedir(), '.local', 'bin'),
    path.join(process.env.LOCALAPPDATA ?? '', 'meeting-assistant', 'ffmpeg'),
    path.join(os.tmpdir(), 'opencode', 'ffmpeg'),
  ].filter((dir) => dir && existsSync(dir));

  for (const dir of roots) {
    const hit = findExe(dir);
    if (hit) return hit;
  }

  // 最後交給 PATH；真的沒有會在 spawn 時拿到 ENOENT，再由呼叫端轉成 FfmpegMissingError。
  return 'ffmpeg';
}

export interface Chunk {
  /** 切出來的檔案路徑；沒切檔時就是原檔 */
  path: string;
  startSec: number;
  durationSec: number;
  /** 給 Files API 用的檔名，重跑時靠它比對快取 */
  displayName: string;
}

function runFfmpeg(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') reject(new FfmpegMissingError());
      else reject(err);
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 失敗（exit ${code}）：\n${stderr.trim().split('\n').slice(-6).join('\n')}`));
    });
  });
}

/**
 * 把音檔切成 chunkSec 秒一段。用 -c copy，所以幾乎不用重編碼，2 小時幾秒鐘就好。
 * 回傳的順序就是播放順序。
 */
export async function splitAudio(
  file: string,
  options: { outDir: string; chunkSec: number; durationSec?: number | null },
): Promise<Chunk[]> {
  const bin = resolveFfmpeg();
  if (!bin) throw new FfmpegMissingError();

  const ext = path.extname(file) || '.m4a';
  const total = options.durationSec ?? null;
  if (total !== null && total <= options.chunkSec) {
    return [{ path: file, startSec: 0, durationSec: total, displayName: path.basename(file) }];
  }

  const pattern = path.join(options.outDir, `part-%03d${ext}`);

  await runFfmpeg(bin, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    file,
    '-vn',
    '-c:a',
    'copy',
    '-f',
    'segment',
    '-segment_time',
    String(options.chunkSec),
    '-reset_timestamps',
    '1',
    pattern,
  ]);

  const names = readdirSync(options.outDir)
    .filter((name) => name.startsWith('part-') && name.endsWith(ext))
    .sort();
  if (!names.length) throw new Error('ffmpeg 沒有產生任何分段檔，請確認這個音檔能正常播放。');

  const chunks: Chunk[] = [];
  let cursor = 0;
  for (let i = 0; i < names.length; i += 1) {
    const chunkPath = path.join(options.outDir, names[i] as string);
    // 用每個檔案自己的 header 算長度：copy 切段的尾段常常比名目長度長或短
    const actual = mediaDurationSec(readFileSync(chunkPath));
    const nominal =
      total !== null ? Math.max(1, Math.min(options.chunkSec, total - i * options.chunkSec)) : options.chunkSec;
    const durationSec = actual ?? nominal;
    chunks.push({
      path: chunkPath,
      startSec: cursor,
      durationSec,
      displayName: `${path.basename(file, ext)}-part${String(i + 1).padStart(2, '0')}${ext}`,
    });
    cursor += durationSec;
  }
  return chunks;
}
