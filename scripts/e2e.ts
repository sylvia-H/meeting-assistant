/**
 * 瀏覽器端到端測試：真的開一個 headless Edge、真的用假麥克風收音。
 * 驗證「麥克風 → AudioWorklet → WebSocket → 伺服器 → 切段 → 筆記 → 摘要」整條路。
 *
 *   npm run build && npm run e2e
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { launchBrowser, sleep, until } from './cdp.ts';

const temp = mkdtempSync(path.join(os.tmpdir(), 'meeting-assistant-e2e-'));
const dataDir = path.join(temp, 'data');
const meetingsDir = path.join(temp, 'meetings');
const profileDir = path.join(temp, 'edge-profile');
const shotDir = path.join(temp, 'shots');
const PORT = 8892;
const MOCK_PORT = 8899;
const CDP_PORT = 9333;
const BASE = `http://127.0.0.1:${PORT}`;

mkdirSync(dataDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });

process.env.MEETING_ASSISTANT_DATA_DIR = dataDir;
process.env.MOCK_LLM = '1';
process.env.TYPELESS_WS_URL = `ws://127.0.0.1:${MOCK_PORT}/stream`;
process.env.PORT = String(PORT);

writeFileSync(
  path.join(dataDir, 'settings.json'),
  `${JSON.stringify(
    {
      transcriber: 'typeless',
      typelessApiKey: 'tls_sk_e2e_test',
      typelessModel: 'typeless-1.0-pro',
      language: 'zh',
      llmProvider: 'anthropic',
      llmKeys: { anthropic: 'sk-ant-e2e' },
      llmModels: { anthropic: 'claude-sonnet-4-5' },
      meetingsDir,
      autoSegmentSeconds: 180,
      keepAudio: true,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`檢查失敗：${message}`);
  process.stdout.write(`  ✓ ${message}\n`);
}

function step(message: string): void {
  process.stdout.write(`  · ${message}\n`);
}

// ── 假的 Typeless ─────────────────────────────────────────
let connectionSeq = 0;
const mock = new WebSocketServer({ port: MOCK_PORT });
mock.on('connection', (ws) => {
  connectionSeq += 1;
  const index = connectionSeq;
  let bytes = 0;
  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      bytes += (raw as Buffer).length;
      return;
    }
    const msg = JSON.parse(raw.toString()) as { type?: string };
    if (msg.type === 'close_stream') {
      const duration = bytes / 32000;
      ws.send(
        JSON.stringify({
          type: 'result',
          status: 'success',
          result: { transcript: `這是第 ${index} 段測試逐字稿。`, duration_seconds: duration },
          usage: { billed_audio_seconds: Math.max(15, duration) },
          request_id: `req_${index}`,
        }),
      );
    }
  });
});

// ── 啟動 app（dist 靜態檔 + API） ──────────────────────────
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

const created = await (
  await fetch(`${BASE}/api/meetings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: '瀏覽器測試會議',
      startedAt: new Date().toISOString(),
      agenda: '驗證真麥克風收音',
      attendees: '王小明（PM）、Amy（廠商 IT）',
    }),
  })
).json() as { meeting: { id: string } };
const id = created.meeting.id;
step(`建立會議 ${id}`);

// ── 開 headless 瀏覽器 ────────────────────────────────────
const session = await launchBrowser({
  port: CDP_PORT,
  profileDir,
  extraArgs: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
  ],
});
const cdp = session.cdp;
step('瀏覽器啟動');

// 不論成功、失敗、逾時，都要收掉瀏覽器與 mock，不然會留下孤兒程序佔住 port
let cleaned = false;
function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  try {
    session.close();
  } catch {
    // 已經關掉了
  }
  try {
    mock.close();
  } catch {
    // 已經關掉了
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
// 保險：任何一步卡住都不要讓整支腳本無聲掛掉
const watchdog = setTimeout(() => {
  process.stderr.write('\nE2E 逾時（180 秒），強制結束。\n');
  cleanup();
  process.exit(1);
}, 180_000);

async function click(selector: string): Promise<void> {
  const rect = await cdp.eval<{ x: number; y: number } | null>(
    `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      const r = node.getBoundingClientRect();
      if (r.width === 0) return null;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`,
  );
  if (!rect) throw new Error(`找不到可點擊的元素：${selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
}

async function typeNote(text: string): Promise<void> {
  await cdp.eval(`(() => {
    const input = document.querySelector('#note-input');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#composer').requestSubmit();
  })()`);
}

async function shot(name: string): Promise<void> {
  const res = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(shotDir, `${name}.png`), Buffer.from(res.data, 'base64'));
}

process.stdout.write('\n會議助手瀏覽器 E2E\n');

// ── 首頁與設定頁 ──────────────────────────────────────────
await cdp.navigate(`${BASE}/#/`);
await until(
  async () => (await cdp.eval<string>(`document.querySelector('#meeting-list')?.textContent ?? ''`)).includes('瀏覽器測試會議'),
  10000,
  '首頁列出剛建立的會議',
);
check(true, '首頁載入，會議清單有資料');
await shot('home');

await cdp.navigate(`${BASE}/#/settings`);
await until(
  async () => (await cdp.eval<boolean>(`!!document.querySelector('#typeless-key')`)) === true,
  10000,
  '設定頁載入',
);
const keyLeak = await cdp.eval<boolean>(`document.body.textContent.includes('tls_sk_e2e_test')`);
const keyHint = await cdp.eval<string>(`document.querySelector('#typeless-key')?.closest('.r')?.textContent ?? ''`);
check(!keyLeak, '設定頁不會把完整 API key 送到瀏覽器');
check(keyHint.includes('已設定'), '設定頁顯示「已設定」提示');
await shot('settings');

// 切換引擎只改畫面，不會存檔；確認兩邊的欄位會跟著換
const engineSwitch = await cdp.eval<string>(`(() => {
  const select = document.querySelector('#transcriber');
  select.value = 'gemini';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return JSON.stringify({ gemini: !!document.querySelector('#gemini-key'), typeless: !!document.querySelector('#typeless-key') });
})()`);
const engineFields = JSON.parse(engineSwitch) as { gemini: boolean; typeless: boolean };
check(engineFields.gemini && !engineFields.typeless, '切換轉錄引擎會顯示對應的 key 欄位');

// 摘要模型是真的下拉選單（以前是 datalist：欄位有值時清單幾乎是空的，看起來像一般輸入框）
const picker = await cdp.eval<string>(`(() => {
  const select = document.querySelector('#llm-model-select');
  const input = document.querySelector('#llm-model');
  const before = { options: select.options.length, value: input.value, inputHidden: input.hidden };
  select.value = 'claude-sonnet-5-5';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  const picked = input.value;
  select.value = '__custom__';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  const custom = { inputHidden: input.hidden, value: input.value };
  return JSON.stringify({ before, picked, custom });
})()`);
const pickerState = JSON.parse(picker) as {
  before: { options: number; value: string; inputHidden: boolean };
  picked: string;
  custom: { inputHidden: boolean; value: string };
};
check(
  pickerState.before.options >= 5 && pickerState.before.inputHidden && pickerState.before.value === 'claude-sonnet-4-5',
  `摘要模型是下拉選單，清單外的既有設定保留成「目前設定」（${pickerState.before.options} 個選項）`,
);
check(pickerState.picked === 'claude-sonnet-5-5', '從選單選模型會寫進實際送出的欄位');
check(!pickerState.custom.inputHidden && pickerState.custom.value === '', '選「其他」才露出輸入框讓人自己打');

// ── 錄音頁 ────────────────────────────────────────────────
await cdp.navigate(`${BASE}/#/live/${id}`);
await until(
  async () => (await cdp.eval<string>(`document.querySelector('#meeting-title')?.textContent ?? ''`)).includes('瀏覽器測試'),
  10000,
  '會議標題載入',
);
check(true, '錄音頁載入，標題正確');
const people = await cdp.eval<string>(`document.querySelector('#meeting-people')?.textContent ?? ''`);
check(people.includes('王小明') && people.includes('PM') && people.includes('廠商 IT'), `標題下顯示與會者與身分（${people.replace(/\s+/g, ' ').trim()}）`);

// 開始錄音（真的呼叫 getUserMedia + AudioWorklet）
await click('#btn-start');
await sleep(1500);
const started = await cdp.eval<string>(`document.querySelector('#status-text')?.textContent ?? ''`);
if (!started.includes('錄音')) {
  const diagnostics = await cdp.eval<string>(`JSON.stringify({
    status: document.querySelector('#status-text')?.textContent,
    dots: document.querySelector('#status-dot')?.dataset.status,
    banner: document.querySelector('#banner')?.textContent,
    toasts: [...document.querySelectorAll('.toast')].map((n) => n.textContent),
    secure: window.isSecureContext,
    hasMediaDevices: !!(navigator.mediaDevices?.getUserMedia),
  }, null, 2)`);
  process.stdout.write(`  診斷：${diagnostics}\n`);
  if (cdp.consoleErrors.length) {
    process.stdout.write(`  console：\n${cdp.consoleErrors.map((e) => `    ${e}`).join('\n')}\n`);
  }
  await shot('start-failed');
  throw new Error(`按下開始後狀態是「${started}」`);
}
check(true, `按下開始後狀態是「${started}」`);

await sleep(3000);
await typeNote('# 測試環節');
await sleep(1200);
await typeNote('! 寄報價給 Amy');
await sleep(1200);
await typeNote('* 下次先寄 draft');
await sleep(1200);

// 手動切段：不管當前段多短都要立刻收工、拿到逐字稿
await click('#btn-cut');
await until(
  async () => (await cdp.eval<string>(`document.querySelector('#segments')?.textContent ?? ''`)).includes('測試逐字稿'),
  30000,
  '切段後逐字稿出現',
);
check(true, '切段後逐字稿出現在錄音頁');

// 聽者可以直接在錄音頁校正逐字稿：改完要存回伺服器，而且之後的 state 更新不能把它洗掉
const editable = await cdp.eval<boolean>(`!!document.querySelector('#segments textarea.seg-text')`);
check(editable, '逐字稿是可以直接編輯的輸入框');
await cdp.eval(`(() => {
  const area = document.querySelector('#segments textarea.seg-text');
  area.focus();
  area.value = area.value + '（校正：報價改寄給 Amy）';
  area.dispatchEvent(new Event('input', { bubbles: true }));
  area.blur();
})()`);
await until(
  async () => {
    const saved = (await (await fetch(`${BASE}/api/meetings/${id}`)).json()) as {
      meeting: { segments: { transcript: string; edited?: boolean }[] };
    };
    return saved.meeting.segments.some((s) => s.edited && s.transcript.includes('校正：報價改寄給 Amy'));
  },
  10000,
  '校正的逐字稿存回伺服器',
);
check(true, '在錄音頁改的逐字稿存回 meeting.json（標記已校正）');
await sleep(1500); // 讓幾個 state 訊息過去，確認畫面上的修改沒被洗掉
const stillEdited = await cdp.eval<string>(
  `document.querySelector('#segments textarea.seg-text')?.value ?? ''`,
);
check(stillEdited.includes('校正：報價改寄給 Amy'), '之後的畫面更新沒有把修改洗掉');

// 環節（# 名稱）現在是小標 .sec，其他筆記是 .note
const liveNotes = await cdp.eval<number>(`document.querySelectorAll('#notes .note, #notes .sec').length`);
check(liveNotes === 3, `錄音頁出現三則筆記（實際 ${liveNotes}）`);

// 貼上截圖：模擬 Ctrl+V 一張 2400×1200 的 PNG，要縮到長邊 1568、附在輸入框旁，送出後變成筆記
await cdp.eval(`(async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 2400;
  canvas.height = 1200;
  const g = canvas.getContext('2d');
  g.fillStyle = '#2b6';
  g.fillRect(0, 0, 2400, 1200);
  g.fillStyle = '#000';
  g.font = '96px sans-serif';
  g.fillText('Q3 營收 1,234 萬', 120, 300);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const data = new DataTransfer();
  data.items.add(new File([blob], 'screenshot.png', { type: 'image/png' }));
  const input = document.querySelector('#note-input');
  input.focus();
  input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
})()`);
await until(
  async () => cdp.eval<boolean>(`!!document.querySelector('#attach:not([hidden]):not(.loading) img')`),
  10000,
  '截圖預覽出現',
);
check(true, '貼上截圖後輸入框旁出現預覽');
await typeNote('> 這張是 Q3 營收表');
await until(
  async () => cdp.eval<boolean>(`(() => {
    const img = document.querySelector('#notes .note-shot img');
    return !!img && img.complete && img.naturalWidth > 0;
  })()`),
  10000,
  '截圖筆記出現',
);
const shotSize = await cdp.eval<string>(`(() => {
  const img = document.querySelector('#notes .note-shot img');
  return img.naturalWidth + 'x' + img.naturalHeight;
})()`);
check(shotSize === '1568x784', `截圖縮到長邊 1568（實際 ${shotSize}）`);
const attachHidden = await cdp.eval<boolean>(`document.querySelector('#attach').hidden`);
check(attachHidden, '送出後預覽收起來');
const shotNote = (await (await fetch(`${BASE}/api/meetings/${id}`)).json()) as {
  meeting: { notes: { kind: string; text: string; image?: string }[] };
};
check(
  shotNote.meeting.notes.some((n) => n.image && n.kind === 'decision' && n.text === '這張是 Q3 營收表'),
  '截圖筆記存進 meeting.json（前綴 > 分類成決議、說明文字一起存）',
);

const timerText = await cdp.eval<string>(`document.querySelector('#timer')?.textContent ?? ''`);
check(/^\d+:\d{2}$/.test(timerText), `計時器有在跑（${timerText}）`);

const bannerHidden = await cdp.eval<boolean>(`document.querySelector('#banner')?.hidden === true`);
check(bannerHidden, '連線正常時不顯示警告橫幅');

await shot('live');

// 結束會議（confirm 在 headless 會卡住，先換掉）
await cdp.eval(`window.confirm = () => true`);
await click('#btn-end');
// headless 的滑鼠事件偶爾會漏；沒跳頁就再點一次，避免整支測試白等 30 秒
for (let attempt = 0; attempt < 3; attempt += 1) {
  await sleep(800);
  if ((await cdp.eval<string>('location.hash')).startsWith('#/meeting/')) break;
  const canRetry = await cdp.eval<boolean>(
    `(() => { const b = document.querySelector('#btn-end'); return !!b && !b.hidden && !b.disabled; })()`,
  );
  if (canRetry) await click('#btn-end');
}
try {
  await until(async () => (await cdp.eval<string>('location.hash')).startsWith('#/meeting/'), 30000, '切到會議頁');
} catch (err) {
  const diagnostics = await cdp.eval<string>(`JSON.stringify({
    hash: location.hash,
    status: document.querySelector('#status-text')?.textContent,
    segmentInfo: document.querySelector('#segment-info')?.textContent,
    banner: document.querySelector('#banner')?.textContent,
    toasts: [...document.querySelectorAll('.toast')].map((n) => n.textContent),
  })`);
  const saved = (await (await fetch(`${BASE}/api/meetings/${id}`)).json()) as {
    meeting: { status: string; segments: { status: string; bytes?: number; error: string | null }[] };
  };
  process.stdout.write(`  診斷：${diagnostics}\n`);
  process.stdout.write(
    `  伺服器：${saved.meeting.status} ${saved.meeting.segments.map((s) => `${s.status}${s.error ? `(${s.error})` : ''}`).join(', ')}\n`,
  );
  if (cdp.consoleErrors.length) {
    process.stdout.write(`  console：\n${cdp.consoleErrors.map((e) => `    ${e}`).join('\n')}\n`);
  }
  throw err;
}
check(true, '結束會議後跳到紀錄頁');

await until(
  async () => (await cdp.eval<string>(`document.querySelector('#transcript')?.textContent ?? ''`)).includes('測試逐字稿'),
  10000,
  '逐字稿渲染',
);
check(true, '紀錄頁的逐字稿有內容');

await click('#btn-summarize');
await until(
  async () => (await cdp.eval<number>(`document.querySelectorAll('#minutes h2').length`)) > 0,
  30000,
  '摘要渲染',
);
const minutes = await cdp.eval<string>(`document.querySelector('#minutes')?.textContent ?? ''`);
check(minutes.includes('TL;DR'), '摘要頁渲染出 TL;DR');
check(minutes.includes('決議'), '摘要頁有決議段落');
check(!minutes.includes('title:'), '紀錄頁不顯示 YAML frontmatter');
check(minutes.includes('收到 1 張截圖'), '產生紀錄時截圖有送到 LLM');
const resultShots = await cdp.eval<number>(`document.querySelectorAll('#notes .note-shot img').length`);
check(resultShots === 1, `紀錄頁的筆記也看得到截圖（${resultShots} 張）`);

// 會後校正逐字稿：紀錄頁右欄切到「逐字稿」直接改，存回去，並提醒可以重新產生紀錄
await cdp.eval(`document.querySelector('#tab-ctl [data-tab="transcript"]').click()`);
await cdp.eval(`(() => {
  const area = document.querySelector('#transcript textarea.seg-text');
  area.focus();
  area.value = area.value + '（會後補充：Amy 確認週五寄出）';
  area.dispatchEvent(new Event('input', { bubbles: true }));
  area.blur();
})()`);
await until(
  async () => {
    const saved = (await (await fetch(`${BASE}/api/meetings/${id}`)).json()) as {
      meeting: { segments: { transcript: string; editedAt?: string }[] };
    };
    return saved.meeting.segments.some((s) => s.editedAt && s.transcript.includes('會後補充：Amy 確認週五寄出'));
  },
  10000,
  '會後校正存回伺服器',
);
check(true, '會議結束後在紀錄頁改的逐字稿存回 meeting.json');
await until(
  async () => cdp.eval<boolean>(`!!document.querySelector('.gen-line .stale')`),
  5000,
  '提醒重新產生',
);
check(true, '紀錄產生後改過逐字稿，會提醒可以重新產生');

// 會後修改筆記：改內容、換類型、補一則會後想法，都要存回 meeting.json
await cdp.eval(`document.querySelector('#tab-ctl [data-tab="notes"]').click()`);
await cdp.eval(`(() => {
  const row = document.querySelector('#notes .note.editable');
  const area = row.querySelector('textarea.note-edit');
  area.focus();
  area.value = '會後改寫：報價改由 Amy 週五寄出';
  area.dispatchEvent(new Event('input', { bubbles: true }));
  area.blur();
  const select = row.querySelector('select.tag-select');
  select.value = 'decision';
  select.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await cdp.eval(`(() => {
  const input = document.querySelector('#post-input');
  input.value = '* 下次會議前先把報價版本對齊';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#post-composer').requestSubmit();
})()`);
await until(
  async () => {
    const saved = (await (await fetch(`${BASE}/api/meetings/${id}`)).json()) as {
      meeting: { notes: { kind: string; text: string; postMeeting?: boolean; editedAt?: string }[] };
    };
    const edited = saved.meeting.notes.some((n) => n.editedAt && n.kind === 'decision' && n.text === '會後改寫：報價改由 Amy 週五寄出');
    const added = saved.meeting.notes.some((n) => n.postMeeting && n.kind === 'idea' && n.text === '下次會議前先把報價版本對齊');
    return edited && added;
  },
  10000,
  '會後筆記存回伺服器',
);
check(true, '會後可以改筆記內容與類型，也能補一則會後想法（標成會後補充）');

await shot('result');

// 音訊真的從瀏覽器送到伺服器
const wavPath = path.join(meetingsDir, id, 'audio', 'mic.wav');
const wavSize = existsSync(wavPath) ? statSync(wavPath).size : 0;
check(wavSize > 44 + 32000 * 2, `瀏覽器音訊有落地（wav ${wavSize} bytes）`);

const meetingJson = JSON.parse(readFileSync(path.join(meetingsDir, id, 'meeting.json'), 'utf8')) as {
  segments: { transcript: string }[];
  notes: unknown[];
};
check(meetingJson.notes.length === 5, `meeting.json 有三則筆記＋一則截圖＋一則會後補充（實際 ${meetingJson.notes.length}）`);

await sleep(300);
if (cdp.consoleErrors.length) {
  throw new Error(`console 有 ${cdp.consoleErrors.length} 個錯誤：\n${cdp.consoleErrors.join('\n')}`);
}
check(true, 'console 沒有錯誤');

process.stdout.write(`\n全部通過。截圖：${shotDir}\n測試資料：${temp}\n\n`);

clearTimeout(watchdog);
cleanup();
await sleep(300);
process.exit(0);
