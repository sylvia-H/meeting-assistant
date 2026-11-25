/**
 * 依 script.json 合成每段旁白（Edge TTS 女聲），輸出 build/audio/<id>.mp3 與 build/timing.json（每段實際秒數）。
 *   node build-voice.ts
 * 需要：uv（暫時環境跑 edge-tts）、npm install（ffmpeg-static）。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';

const root = import.meta.dirname;
const out = path.join(root, 'build', 'audio');
mkdirSync(out, { recursive: true });
const script = JSON.parse(readFileSync(path.join(root, 'script.json'), 'utf8')) as {
  voice: string;
  rate: string;
  scenes: { id: string; text: string }[];
};

function seconds(file: string): number {
  const r = spawnSync(ffmpeg as unknown as string, ['-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /time=(\d+):(\d+):([\d.]+)/g;
  let last: RegExpExecArray | null = null;
  for (let x = m.exec(r.stderr); x; x = m.exec(r.stderr)) last = x;
  if (!last) throw new Error(`量不到長度：${file}`);
  return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
}

const timing: Record<string, number> = {};
for (const scene of script.scenes) {
  const mp3 = path.join(out, `${scene.id}.mp3`);
  const r = spawnSync(
    'uv',
    ['run', '--with', 'edge-tts', 'edge-tts', '--voice', script.voice, `--rate=${script.rate}`, '--text', scene.text, '--write-media', mp3],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`合成失敗 ${scene.id}：${r.stderr}`);
  timing[scene.id] = Math.round(seconds(mp3) * 100) / 100;
  process.stdout.write(`  ✓ ${scene.id} ${timing[scene.id]}s\n`);
}
writeFileSync(path.join(root, 'build', 'timing.json'), `${JSON.stringify(timing, null, 2)}\n`);
const total = Object.values(timing).reduce((a, b) => a + b, 0);
process.stdout.write(`旁白總長 ${total.toFixed(1)} 秒\n`);
