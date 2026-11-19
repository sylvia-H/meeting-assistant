/**
 * 中文孤行檢測：把頁面真的渲染出來，量每個文字區塊最後一行的字數。
 *
 * 判定：一個區塊有 2 行以上、最後一行 ≤ 4 字、前一行 ≥ 8 字 → 孤行。
 * 桌機 1440px 與手機 390px 各跑一輪。
 *
 *   npm run build && node scripts/typography.ts
 *
 * 會自己開一個暫存資料夾與伺服器（port 8894），不會動到真的會議資料。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser, sleep, until } from './cdp.ts';

const PORT = 8894;
const CDP_PORT = 9335;
const BASE = `http://127.0.0.1:${PORT}`;
const temp = mkdtempSync(path.join(os.tmpdir(), 'meeting-assistant-typo-'));
const dataDir = path.join(temp, 'data');
const meetingsDir = path.join(temp, 'meetings');
const demoId = '2026-11-18-1000-demo';

mkdirSync(dataDir, { recursive: true });
mkdirSync(meetingsDir, { recursive: true });

process.env.MEETING_ASSISTANT_DATA_DIR = dataDir;
process.env.MOCK_LLM = '1';
process.env.TYPELESS_WS_URL = 'ws://127.0.0.1:1/stream';
process.env.PORT = String(PORT);

writeFileSync(
  path.join(dataDir, 'settings.json'),
  `${JSON.stringify(
    {
      transcriber: 'typeless',
      typelessApiKey: 'tls_sk_typography_check',
      typelessModel: 'typeless-1.0-pro',
      language: 'zh',
      llmProvider: 'anthropic',
      llmKeys: { anthropic: 'sk-ant-typography' },
      llmModels: { anthropic: 'claude-sonnet-4-5' },
      meetingsDir,
      autoSegmentSeconds: 180,
      keepAudio: false,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

// 有真的示範會議就複製一份來量，沒有的話只量表單頁
const demoSource = path.resolve(import.meta.dirname, '..', 'meetings', demoId);
const hasDemo = existsSync(demoSource);
if (hasDemo) cpSync(demoSource, path.join(meetingsDir, demoId), { recursive: true });

await import('../server/index.ts');
await until(
  async () => {
    try {
      return (await fetch(`${BASE}/api/settings`)).ok;
    } catch {
      return false;
    }
  },
  10000,
  'API 啟動',
);

/** 每一頁用到的孤行偵測：回傳「字數 孤行｜行數｜tag｜前 24 字」 */
const DETECT = `(() => {
  const SELECTOR = 'p, h1, h2, h3, li, summary, .note-text, .meeting-main span, .field > span, .hint';
  const out = [];
  document.querySelectorAll(SELECTOR).forEach((el) => {
    if (el.closest('[hidden]')) return;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return;
    const txt = (el.textContent || '').trim();
    if (txt.length < 10) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
    const lines = [];
    for (const r of rects) {
      const line = lines.find((l) => Math.abs(l.top - r.top) < 4);
      if (line) line.width += r.width;
      else lines.push({ top: r.top, width: r.width });
    }
    if (lines.length < 2) return;
    const fontSize = parseFloat(style.fontSize) || 16;
    const last = Math.round(lines[lines.length - 1].width / fontSize);
    const prev = Math.round(lines[lines.length - 2].width / fontSize);
    if (last <= 4 && prev >= 8) {
      const ratio = (lines[lines.length - 1].width / el.getBoundingClientRect().width).toFixed(2);
      out.push(last + ' 字｜' + lines.length + ' 行｜< ' + el.tagName.toLowerCase() + ' >｜末行佔 ' + ratio + '｜' + txt.slice(0, 24));
    }
  });
  return out;
})()`;

const pages: { name: string; hash: string }[] = [
  { name: '首頁', hash: '#/' },
  { name: '設定', hash: '#/settings' },
  { name: '紀錄頁', hash: hasDemo ? `#/meeting/${demoId}` : '' },
  { name: '錄音頁', hash: hasDemo ? `#/live/${demoId}` : '' },
];

const session = await launchBrowser({ port: CDP_PORT, profileDir: path.join(temp, 'edge-profile') });
const cdp = session.cdp;

let total = 0;
for (const width of [1440, 390]) {
  await cdp.setViewport(width, 900);
  process.stdout.write(`\n${width === 1440 ? '桌機 1440px' : '手機 390px'}\n`);
  for (const page of pages) {
    if (!page.hash) continue;
    await cdp.navigate(`${BASE}/${page.hash}`);
    await sleep(400);
    const found = await cdp.eval<string[]>(DETECT);
    total += found.length;
    if (!found.length) {
      process.stdout.write(`  ${page.name}：無孤行\n`);
      continue;
    }
    process.stdout.write(`  ${page.name}：${found.length} 處\n`);
    for (const line of found) process.stdout.write(`    · ${line}\n`);
  }
}

process.stdout.write(`\n合計 ${total} 處孤行\n`);
session.close();
await sleep(200);
process.exit(0);
