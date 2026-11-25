/**
 * 把錄好的影格與旁白合成最後的 mp4，另外輸出字幕檔 .srt。
 *   node video/assemble.ts
 * 需要 video/build/frames/<id>/（record.ts）與 video/build/audio/<id>.mp3（build-voice.ts）。
 * 輸出：video/out/meeting-assistant-promo.mp4、.srt
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';

const here = import.meta.dirname;
const build = path.join(here, 'build');
const out = path.join(here, 'out');
const clips = path.join(build, 'clips');
mkdirSync(clips, { recursive: true });
mkdirSync(out, { recursive: true });

const FF = ffmpeg as unknown as string;
const LEAD = 0.4;
const script = JSON.parse(readFileSync(path.join(here, 'script.json'), 'utf8')) as { scenes: { id: string }[] };

function run(args: string[]): void {
  const r = spawnSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg 失敗：${args.join(' ')}\n${r.stderr}`);
}

const srtTime = (s: number): string => {
  const ms = Math.round(s * 1000);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

const list: string[] = [];
const srt: string[] = [];
let offset = 0;
let n = 0;

for (const { id } of script.scenes) {
  const dir = path.join(build, 'frames', id);
  if (!existsSync(path.join(dir, 'frames.json'))) throw new Error(`缺少場景 ${id} 的影格，先跑 record.ts`);
  const meta = JSON.parse(readFileSync(path.join(dir, 'frames.json'), 'utf8')) as {
    length: number;
    frames: { t: number; file: string }[];
  };

  // concat demuxer：每格停留到下一格出現，最後一格停到場景結束
  const lines: string[] = [];
  meta.frames.forEach((f, i) => {
    const next = i + 1 < meta.frames.length ? meta.frames[i + 1].t : meta.length * 1000;
    const dur = Math.max(0.001, (next - f.t) / 1000);
    lines.push(`file '${f.file}'`, `duration ${dur.toFixed(4)}`);
  });
  lines.push(`file '${meta.frames[meta.frames.length - 1].file}'`);
  const listFile = path.join(dir, 'list.txt');
  writeFileSync(listFile, `${lines.join('\n')}\n`);

  const video = path.join(clips, `${id}.v.mp4`);
  run(['-f', 'concat', '-safe', '0', '-i', listFile, '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-t', String(meta.length), video]);

  const clip = path.join(clips, `${id}.mp4`);
  run([
    '-i', video,
    '-i', path.join(build, 'audio', `${id}.mp3`),
    '-filter_complex', `[1:a]aresample=44100,adelay=${Math.round(LEAD * 1000)}|${Math.round(LEAD * 1000)},apad[a]`,
    '-map', '0:v', '-map', '[a]',
    '-t', String(meta.length),
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '44100',
    clip,
  ]);
  list.push(`file '${clip.replace(/\\/g, '/')}'`);

  const subsFile = path.join(build, 'frames', `${id}.subs.json`);
  if (existsSync(subsFile)) {
    for (const c of JSON.parse(readFileSync(subsFile, 'utf8')) as { from: number; to: number; text: string }[]) {
      n += 1;
      srt.push(`${n}\n${srtTime(offset + c.from)} --> ${srtTime(offset + c.to)}\n${c.text}\n`);
    }
  }
  offset += meta.length;
  process.stdout.write(`  ✓ ${id} ${meta.length.toFixed(1)}s\n`);
}

const listAll = path.join(build, 'all.txt');
writeFileSync(listAll, `${list.join('\n')}\n`);
const mp4 = path.join(out, 'meeting-assistant-promo.mp4');
run(['-f', 'concat', '-safe', '0', '-i', listAll, '-c', 'copy', '-movflags', '+faststart', mp4]);
writeFileSync(path.join(out, 'meeting-assistant-promo.srt'), srt.join('\n'));
process.stdout.write(`完成：${mp4}（共 ${offset.toFixed(1)} 秒）\n`);
