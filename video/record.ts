/**
 * 錄製宣傳影片的畫面：每一段旁白對應一個場景，錄成一串 JPEG 影格，之後由 assemble.ts 合成。
 *
 *   npm run build            （在 repo 根目錄，要有 dist/）
 *   node video/build-voice.ts   （先合成旁白，錄影才知道每段要多長）
 *   node video/record.ts [s3 s5 ...]   （不帶參數 = 全部場景）
 *
 * 全程用隔離的暫存資料夾與假資料（MOCK_LLM、假 Typeless、假 key），不碰你真正的會議。
 * 暫存資料夾放在 C:\ma-demo，避免畫面上露出使用者名稱。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { launchBrowser, sleep } from '../scripts/cdp.ts';

const here = import.meta.dirname;
const repo = path.resolve(here, '..');
const build = path.join(here, 'build');
const framesRoot = path.join(build, 'frames');
const demoRoot = process.platform === 'win32' ? 'C:\\ma-demo' : path.join(build, 'ma-demo');

const W = 1280;
const H = 720;
const PORT_SETUP = 8898;
const PORT_MAIN = 8899;
const PORT_MOCK = 8897;
const CDP_PORT = 9341;
const A = `http://127.0.0.1:${PORT_SETUP}`;
const B = `http://127.0.0.1:${PORT_MAIN}`;

const script = JSON.parse(readFileSync(path.join(here, 'script.json'), 'utf8')) as {
  scenes: { id: string; title: string; text: string }[];
};
const timing = JSON.parse(readFileSync(path.join(build, 'timing.json'), 'utf8')) as Record<string, number>;

/** 旁白前的留白（秒）與每場景尾巴的額外停留（秒；操作動畫比旁白長的場景要加） */
const LEAD = 0.4;
const EXTRA: Record<string, number> = { s0: 1.2, s1: 0.6, s2: 1.5, s3: 1.5, s4: 2.2, s5: 2.0, s6: 1.5, s7: 3.0, s8: 1.0, s9: 1.6 };
const sceneLength = (id: string): number => LEAD + timing[id] + (EXTRA[id] ?? 0.6);

// ── 暫存環境 ──────────────────────────────────────────────
rmSync(demoRoot, { recursive: true, force: true });
mkdirSync(demoRoot, { recursive: true });
const meetingsDir = path.join(demoRoot, 'meetings');
const settingsDir = path.join(demoRoot, 'settings');

const children: ChildProcess[] = [];
function startServer(port: number, appdata: string, extra: Record<string, string> = {}): ChildProcess {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MEETING_ASSISTANT_APPDATA: appdata,
    APPDATA: path.dirname(appdata),
    PORT: String(port),
    MOCK_LLM: '1',
    ...extra,
  };
  delete env.MEETING_ASSISTANT_DATA_DIR;
  delete env.HOST;
  const child = spawn(process.execPath, ['server/index.ts'], { cwd: repo, env, stdio: 'ignore' });
  children.push(child);
  return child;
}
async function waitUp(port: number): Promise<void> {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch {
      // 還沒起來
    }
    await sleep(200);
  }
  throw new Error(`伺服器沒起來：port ${port}`);
}
async function api(method: string, urlPath: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${B}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${urlPath} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

// 假的 Typeless：切段時回一段看起來真實的逐字稿
const demoTranscript = (
  JSON.parse(readFileSync(path.join(repo, 'scripts/fixtures/demo-meeting/meeting.json'), 'utf8')) as {
    segments: { transcript: string }[];
  }
).segments[0].transcript
  .split('\n\n')
  .slice(0, 2)
  .join('\n\n');
const mock = new WebSocketServer({ port: PORT_MOCK });
mock.on('connection', (ws) => {
  let bytes = 0;
  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      bytes += (raw as Buffer).length;
      return;
    }
    const msg = JSON.parse(raw.toString()) as { type?: string };
    if (msg.type === 'close_stream') {
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            type: 'result',
            status: 'success',
            result: { transcript: demoTranscript, duration_seconds: bytes / 32000 },
            usage: { billed_audio_seconds: Math.max(15, bytes / 32000) },
            request_id: 'req_demo',
          }),
        );
      }, 700);
    }
  });
});

startServer(PORT_SETUP, path.join(demoRoot, 'appdata-a', 'meeting-assistant'));
startServer(PORT_MAIN, path.join(demoRoot, 'appdata-b', 'meeting-assistant'), {
  TYPELESS_WS_URL: `ws://127.0.0.1:${PORT_MOCK}/stream`,
});
await Promise.all([waitUp(PORT_SETUP), waitUp(PORT_MAIN)]);

await api('POST', '/api/setup', { meetingsDir, settingsDir });
await api('PUT', '/api/settings', {
  transcriber: 'typeless',
  typelessApiKey: 'tls_sk_demo_000000000000',
  typelessModel: 'typeless-1.0-pro',
  language: 'zh',
  llmProvider: 'anthropic',
  llmKeys: { anthropic: 'sk-ant-demo-000000000000' },
});

// 首頁清單用的示範會議（複製 repo 現成的 fixture，改標題與日期）
const demos = [
  { id: '2026-11-24-1400-design', title: '設計評審（示範資料）', start: '2026-11-24T06:00:00.000Z', end: '2026-11-24T06:40:00.000Z' },
  { id: '2026-11-20-1000-customer', title: '客戶訪談：採購流程（示範資料）', start: '2026-11-20T02:00:00.000Z', end: '2026-11-20T02:50:00.000Z' },
  { id: '2026-11-18-1000-demo', title: '產品週會（示範資料）', start: '2026-11-18T02:00:00.000Z', end: '2026-11-18T02:45:00.000Z' },
];
for (const d of demos) {
  const dir = path.join(meetingsDir, d.id);
  cpSync(path.join(repo, 'scripts/fixtures/demo-meeting'), dir, { recursive: true });
  const file = path.join(dir, 'meeting.json');
  const m = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  Object.assign(m, { id: d.id, title: d.title, startedAt: d.start, endedAt: d.end });
  writeFileSync(file, JSON.stringify(m, null, 2));
}

// ── 瀏覽器 ────────────────────────────────────────────────
const session = await launchBrowser({
  port: CDP_PORT,
  profileDir: path.join(demoRoot, 'edge-profile'),
  extraArgs: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio', `--window-size=${W},${H}`],
});
const cdp = session.cdp;
await cdp.setViewport(W, H);
const fxSource = readFileSync(path.join(here, 'fx.js'), 'utf8');
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.confirm = () => true; window.alert = () => {};\n${fxSource}`,
});

function cleanup(): void {
  try {
    session.close();
  } catch {
    // 已關
  }
  try {
    mock.close();
  } catch {
    // 已關
  }
  for (const c of children) c.kill();
}
process.on('exit', () => {
  cleanup();
  rmSync(demoRoot, { recursive: true, force: true });
});
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

// ── 影格擷取 ──────────────────────────────────────────────
interface Frame {
  t: number;
  file: string;
}
let current: { id: string; dir: string; start: number; frames: Frame[]; n: number } | null = null;

cdp.on('Page.screencastFrame', ((p: { data: string; sessionId: number }) => {
  void cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId });
  const cur = current;
  if (!cur) return;
  const file = `f${String(cur.n++).padStart(5, '0')}.jpg`;
  writeFileSync(path.join(cur.dir, file), Buffer.from(p.data, 'base64'));
  cur.frames.push({ t: Date.now() - cur.start, file });
}) as (p: never) => void);
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: W, maxHeight: H, everyNthFrame: 1 });

async function beginScene(id: string): Promise<void> {
  const dir = path.join(framesRoot, id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const start = Date.now();
  current = { id, dir, start, frames: [], n: 0 };
  // 畫面靜止時 screencast 不會送新影格，先拍一張當第一格
  const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
  const cur = current;
  const file = `f${String(cur.n++).padStart(5, '0')}.jpg`;
  writeFileSync(path.join(dir, file), Buffer.from(shot.data, 'base64'));
  cur.frames.push({ t: 0, file });
}
function endScene(length: number): void {
  const cur = current;
  if (!cur) return;
  current = null;
  writeFileSync(path.join(cur.dir, 'frames.json'), JSON.stringify({ length, frames: cur.frames }, null, 2));
}

// ── 操作小工具 ────────────────────────────────────────────
const fx = (call: string): Promise<unknown> => cdp.eval(`window.__fx && window.__fx.${call}`);
const q = (sel: string): string => JSON.stringify(sel);

async function waitFor(test: string, label: string, ms = 15000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cdp.eval<boolean>(`!!(${test})`)) return;
    await sleep(120);
  }
  throw new Error(`等待逾時：${label}`);
}

async function rectOf(sel: string): Promise<{ x: number; y: number; w: number; h: number }> {
  const r = await cdp.eval<{ x: number; y: number; w: number; h: number } | null>(
    `(() => { const n = document.querySelector(${q(sel)}); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`,
  );
  if (!r) throw new Error(`找不到元素：${sel}`);
  return r;
}

async function glide(sel: string): Promise<void> {
  await cdp.eval(`window.__fx.moveTo(${q(sel)})`);
  await sleep(750);
}

async function click(sel: string): Promise<void> {
  await cdp.eval(`document.querySelector(${q(sel)})?.scrollIntoView({ block: 'center' })`);
  await sleep(250);
  await glide(sel);
  await fx('click()');
  const r = await rectOf(sel);
  const x = r.x + r.w / 2;
  const y = r.y + r.h / 2;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function typeInto(sel: string, text: string, perChar = 45): Promise<void> {
  await cdp.eval(`(() => { const n = document.querySelector(${q(sel)}); n.focus(); n.setSelectionRange?.(n.value.length, n.value.length); })()`);
  for (const ch of text) {
    await cdp.send('Input.insertText', { text: ch });
    await sleep(perChar);
  }
}

async function go(url: string, readySel: string): Promise<void> {
  await cdp.send('Page.navigate', { url });
  await sleep(300);
  await waitFor(`document.querySelector(${q(readySel)})`, `${url} → ${readySel}`);
  await sleep(500);
}

// ── 場景 ──────────────────────────────────────────────────
interface Ctx {
  id: string;
  length: number;
  /** 等到場景開始後的第 sec 秒 */
  until(sec: number): Promise<void>;
  /** 旁白裡某個詞大約在場景第幾秒被念出（依字數比例估算） */
  at(phrase: string): number;
}

function makeCtx(id: string, start: number, length: number): Ctx {
  const text = script.scenes.find((s) => s.id === id)?.text ?? '';
  return {
    id,
    length,
    until: (sec) => sleep(Math.max(0, start + sec * 1000 - Date.now())),
    at(phrase) {
      const i = text.indexOf(phrase);
      if (i < 0) throw new Error(`旁白找不到：${phrase}`);
      return LEAD + (timing[id] * i) / text.length;
    },
  };
}

/** 旁白字幕：依標點切句，按字數比例分配時間 */
function subtitleChunks(text: string, duration: number): { from: number; to: number; text: string }[] {
  const parts = text.split(/(?<=[，。：、])/).map((s) => s.trim()).filter(Boolean);
  const merged: string[] = [];
  for (const p of parts) {
    const last = merged[merged.length - 1];
    // 只在同一句裡（上一段不是以「。」結尾）把太短的碎片併起來
    if (last && !/[。]$/.test(last) && (last.length < 8 || p.length < 5) && last.length + p.length <= 26) merged[merged.length - 1] = last + p;
    else merged.push(p);
  }
  const total = merged.reduce((n, s) => n + s.length, 0);
  let cursor = LEAD;
  return merged.map((s) => {
    const span = (duration * s.length) / total;
    const chunk = { from: cursor, to: cursor + span, text: s.replace(/[，。：、]+$/, '') };
    cursor += span;
    return chunk;
  });
}

const scenes: Record<string, (c: Ctx) => Promise<void>> = {
  // s8 在下方定義（需要先換頁、頁面載入後才有元素）
  async s0(c) {
    await fx(`title('會議助手', '邊開會，邊把紀錄做好')`);
    await c.until(c.length);
  },

  async s1(c) {
    await fx('title(null)');
    await sleep(500);
    await c.until(0.5);
    await fx(`highlight('#meeting-list')`);
    await c.until(2.2);
    await fx('clearHighlight()');
    const steps = ['建會議', '錄音', '筆記', '會議紀錄'];
    await fx(`flow(${JSON.stringify(steps)}, -1)`);
    for (let i = 0; i < steps.length; i++) {
      await c.until(3.0 + i * 1.7);
      await fx(`flow(${JSON.stringify(steps)}, ${i})`);
    }
    await c.until(c.length);
  },

  async s2(c) {
    await cdp.eval(`(() => {
      const set = (id, v) => { const n = document.getElementById(id); if (n) n.value = v; };
      set('setup-meetings', 'C:\\\\Users\\\\小明\\\\Documents\\\\Meeting Assistant');
      set('setup-settings', 'C:\\\\Users\\\\小明\\\\AppData\\\\Roaming\\\\meeting-assistant');
      document.querySelectorAll('.cloud-risk').forEach((n) => (n.hidden = true));
    })()`);
    await c.until(c.at('點兩下'));
    await fx(`bubble('a', '.setup-card h1', '單一 exe，免安裝', 'right')`);
    await c.until(c.at('錄音和紀錄'));
    await fx(`clearBubble('a')`);
    await fx(`highlight('#setup-meetings')`);
    await fx(`bubble('b', '#setup-meetings', '資料留在自己的硬碟', 'bottom')`);
    await cdp.eval(`window.__fx.moveTo('[data-pick=setup-meetings]', 0.25, 0.2)`);
    await c.until(c.at('錄音和紀錄') + 2.2);
    await fx(`click()`); // 示意：只做點擊動畫，不真的開資料夾視窗
    await fx(`highlight('#setup-settings')`);
    await fx(`clearBubble('b')`);
    await cdp.eval(`window.__fx.moveTo('[data-pick=setup-settings]', 0.25, 0.2)`);
    await c.until(c.length);
  },

  async s3(c) {
    await fx('hideCursor()');
    await c.until(c.at('轉錄可以選'));
    await glide('#transcriber');
    await fx('click()');
    await cdp.eval(`(() => { const s = document.querySelector('#transcriber'); s.value = 'gemini'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await fx(`bubble('g', '#transcriber', 'Gemini 有免費額度', 'right')`);
    await c.until(c.at('摘要可以用'));
    await fx(`clearBubble('g')`);
    await glide('#provider');
    await fx('click()');
    await c.until(c.at('API key'));
    await cdp.eval(`(() => { const s = document.querySelector('#transcriber'); s.value = 'typeless'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(300);
    await fx(`highlight('#typeless-key')`);
    await glide('#typeless-key');
    await fx(`bubble('k', '#typeless-key', 'Key 只存在你的電腦', 'top')`);
    await c.until(c.length);
  },

  async s4(c) {
    await fx('hideCursor()');
    await c.until(0.3);
    await glide('#title');
    await fx('click()');
    await typeInto('#title', '產品週會');
    await glide('#attendees');
    await fx('click()');
    await typeInto('#attendees', '王小明（PM）、Amy（客服）');
    await fx(`bubble('t', '#attendees', '議程與與會者會一起交給 AI', 'right')`);
    await glide('#agenda');
    await fx('click()');
    await typeInto('#agenda', '確認 Q1 排程與匯出功能範圍');
    await c.until(c.length - 1.0);
    await fx('clearBubbles()');
    await click('#btn-create-start');
    // 保險：點擊沒送出表單時，改用表單本身送出，免得後面場景接不上
    await sleep(1500);
    if (!(await cdp.eval<boolean>(`location.hash.startsWith('#/live/')`))) {
      await cdp.eval(`document.querySelector('#create-form').requestSubmit(document.querySelector('#btn-create-start'))`);
    }
  },

  async s5(c) {
    await waitFor(`document.querySelector('#btn-start')`, 'live 頁');
    await c.until(0.5);
    await click('#btn-start');
    await waitFor(`document.querySelector('#status-text')?.textContent.includes('錄音')`, '開始錄音');
    await fx(`bubble('r', '#status-text', '錄音中，自動切段', 'bottom')`);
    await c.until(c.at('講話'));
    await click('#btn-cut');
    await fx(`bubble('r', '#btn-cut', '切段後轉成逐字稿', 'bottom')`);
    await waitFor(`document.querySelector('#segments textarea.seg-text')`, '逐字稿出現', 20000);
    await c.until(c.length);
  },

  async s6(c) {
    await fx('clearBubbles()');
    const kinds = [
      { key: '#', label: '新環節', color: '#a78bfa' },
      { key: '>', label: '決議', color: '#34d399' },
      { key: '!', label: '待辦', color: '#fbbf24' },
      { key: '?', label: '待確認', color: '#60a5fa' },
      { key: '*', label: '想法', color: '#f472b6' },
    ];
    const submit = `document.querySelector('#composer').requestSubmit()`;
    const note = async (text: string, activeKey: string): Promise<void> => {
      await fx(`symbols(${JSON.stringify(kinds)}, ${kinds.findIndex((k) => k.key === activeKey)})`);
      await glide('#note-input');
      await typeInto('#note-input', text, 40);
      await cdp.eval(submit);
    };
    await c.until(c.at('同時可以'));
    await fx(`symbols(${JSON.stringify(kinds)}, -1)`);
    await c.until(c.at('驚嘆號'));
    await note('! 通知客服上線日往後一週', '!');
    await c.until(c.at('井字號'));
    await note('# 排程討論', '#');
    await c.until(c.at('大於號'));
    await note('> 這版只做 markdown 匯出，PDF 下一版', '>');
    await c.until(c.at('聽錯的地方'));
    await fx('symbols(null)');
    await fx(`highlight('#segments textarea.seg-text')`);
    await glide('#segments textarea.seg-text');
    await fx('click()');
    await typeInto('#segments textarea.seg-text', '（校正：Q1 排程）', 50);
    await cdp.eval(`document.querySelector('#segments textarea.seg-text').blur()`);
    await fx(`bubble('e', '#segments textarea.seg-text', '直接改，會存回去', 'top')`);
    await c.until(c.length);
  },

  async s7(c) {
    await fx('clearHighlight()');
    await fx('clearBubbles()');
    await c.until(0.4);
    await click('#btn-end');
    await waitFor(`location.hash.startsWith('#/meeting/')`, '進入紀錄頁', 20000);
    await waitFor(`document.querySelector('#btn-summarize') && !document.querySelector('#btn-summarize').disabled`, '產生鈕可按', 20000);
    await waitFor(`document.querySelector('#minutes')?.textContent.trim().length > 40`, '紀錄產生', 30000);
    // 模擬的 LLM 只會吐「離線測試」的假紀錄；把這場會議的紀錄換成 fixture 的真實樣貌再重整畫面
    const id = await cdp.eval<string>(`decodeURIComponent(location.hash.split('/')[2])`);
    cpSync(path.join(repo, 'scripts/fixtures/demo-meeting/minutes.md'), path.join(meetingsDir, id, 'minutes.md'));
    await cdp.eval('location.reload()');
    await waitFor(`document.querySelector('#minutes')?.textContent.includes('TL;DR')`, '紀錄換成範例內容', 20000);
    await sleep(600);
    await fx(`bubble('m', '#btn-summarize', 'Claude／OpenAI／Gemini 任選', 'bottom')`);
    await glide('#btn-summarize');
    await c.until(c.length);
  },

  async s9(c) {
    await fx(`title('會議助手', '專心開會，紀錄交給它・本機執行，資料自己掌握')`);
    await c.until(c.length);
  },
};

// 每個場景開錄前要先導覽到的頁面（s5～s7 接著上一場景的操作，不用換頁）
const pre: Record<string, () => Promise<void>> = {
  s0: () => go(`${B}/#/`, '#meeting-list'),
  s1: () => go(`${B}/#/`, '#meeting-list'),
  s2: () => go(`${A}/#/`, '#setup-save'),
  s3: () => go(`${B}/#/settings`, '#typeless-key'),
  s4: () => go(`${B}/#/`, '#btn-create-start'),
  s5: async () => undefined, // 接著 s4 按下「建立並開始錄音」
  s6: async () => undefined,
  s7: async () => undefined,
  s8: () => go(`${B}/#/meeting/2026-11-18-1000-demo`, '#minutes'),
  s9: () => go(`${B}/#/`, '#meeting-list'),
};

scenes.s8 = async (c) => {
  await fx('hideCursor()');
  await c.until(0.4);
  const labels: [string, string][] = [
    ['TL;DR', '重點摘要'],
    ['決議', '決議與依據'],
    ['待辦', '待辦事項與負責人'],
  ];
  const find = (text: string): string =>
    `(() => { const h = [...document.querySelectorAll('#minutes h2')].find((n) => n.textContent.trim().startsWith(${JSON.stringify(text)})); if (!h) return null; h.scrollIntoView({ behavior: 'smooth', block: 'start' }); h.id = '__t_' + ${JSON.stringify(text)}.length; return '#' + h.id; })()`;
  const times = [c.at('重點摘要'), c.at('決議'), c.at('待辦事項')];
  for (let i = 0; i < labels.length; i++) {
    await c.until(times[i]);
    const sel = await cdp.eval<string | null>(find(labels[i][0]));
    await sleep(700);
    if (sel) {
      await fx(`highlight(${q(sel)}, 10)`);
      await fx(`bubble('h', ${q(sel)}, ${JSON.stringify(labels[i][1])}, 'right')`);
    }
    await c.until(times[i] + 2.0);
    await fx('clearHighlight()');
    await fx('clearBubbles()');
  }
  await c.until(c.at('還能複製'));
  await click('#btn-copy').catch(() => undefined);
  await c.until(c.length);
};

// ── 主流程 ────────────────────────────────────────────────
const wanted = process.argv.slice(2);
const order = script.scenes.map((s) => s.id);
const run = wanted.length ? order.filter((id) => wanted.includes(id)) : order;

for (const id of run) {
  process.stdout.write(`  ● ${id} …`);
  await pre[id]();
  await fx(`clearBubbles()`);
  await fx(`clearHighlight()`);
  await fx(`subtitle('')`);
  const length = sceneLength(id);
  await beginScene(id);
  const start = current!.start;
  const ctx = makeCtx(id, start, length);
  // 字幕在背景依時間切換
  const scene = script.scenes.find((s) => s.id === id)!;
  const chunks = subtitleChunks(scene.text, timing[id]);
  const subs = chunks.flatMap((ch) => [
    sleep(Math.max(0, start + ch.from * 1000 - Date.now())).then(() => fx(`subtitle(${JSON.stringify(ch.text)})`)),
    sleep(Math.max(0, start + ch.to * 1000 - Date.now())).then(() => fx(`subtitle('')`)),
  ]);
  writeFileSync(path.join(framesRoot, `${id}.subs.json`), JSON.stringify(chunks, null, 2));
  try {
    await scenes[id](ctx);
    await ctx.until(length);
  } finally {
    await Promise.allSettled(subs);
    endScene(length);
  }
  process.stdout.write(` ✓ ${length.toFixed(1)}s\n`);
}

if (cdp.consoleErrors.length) process.stdout.write(`  console 錯誤：${cdp.consoleErrors.join(' | ')}\n`);
cleanup();
await sleep(300);
if (existsSync(demoRoot)) rmSync(demoRoot, { recursive: true, force: true });
process.exit(0);
