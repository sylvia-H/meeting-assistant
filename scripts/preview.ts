/**
 * 拍目前畫面的截圖，存到 preview/：首頁、最新一場會議的紀錄頁、設定頁，含手機寬度。
 * 需要先 `npm run build`，並在另一個視窗跑 `npm start`（預設 8787）。
 *
 *   node scripts/preview.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchBrowser, sleep } from './cdp.ts';

const PORT = process.env.PORT ?? '8787';
const BASE = `http://127.0.0.1:${PORT}`;
const out = path.resolve(import.meta.dirname, '..', 'preview');
mkdirSync(out, { recursive: true });

const list = (await (await fetch(`${BASE}/api/meetings`)).json()) as { meetings: { id: string }[] };
const latest = list.meetings[0]?.id;
if (!latest) throw new Error('目前沒有任何會議，先建立一場再截圖');

const shots: { name: string; url: string; width: number; height: number }[] = [
  { name: 'home-1440', url: `${BASE}/#/`, width: 1440, height: 900 },
  { name: 'result-1440', url: `${BASE}/#/meeting/${latest}`, width: 1440, height: 1100 },
  { name: 'settings-1440', url: `${BASE}/#/settings`, width: 1440, height: 900 },
  { name: 'result-390', url: `${BASE}/#/meeting/${latest}`, width: 390, height: 1200 },
];

const session = await launchBrowser({ port: 9334, profileDir: path.join(out, '.edge-profile') });
const cdp = session.cdp;

for (const shot of shots) {
  await cdp.setViewport(shot.width, shot.height);
  await cdp.send('Page.navigate', { url: shot.url });
  await sleep(1400);
  const res = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(out, `${shot.name}.png`), Buffer.from(res.data, 'base64'));
  process.stdout.write(`  ✓ ${shot.name}.png\n`);
}

if (cdp.consoleErrors.length) process.stdout.write(`  console 錯誤：${cdp.consoleErrors.join(' | ')}\n`);
session.close();
await sleep(300);
process.exit(0);
