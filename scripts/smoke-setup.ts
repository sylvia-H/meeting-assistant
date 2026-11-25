/**
 * 第一次啟動流程的 smoke test：用隔離的 APPDATA 起一台真的伺服器，走一遍
 * 「未設定 → 擋 API → 選位置 → 能用 → 換會議資料夾 → 搬設定資料夾」。
 * 不碰你真正的資料：location.json、設定、會議全在暫存資料夾。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const temp = mkdtempSync(path.join(os.tmpdir(), 'meeting-assistant-setup-'));
const appData = path.join(temp, 'AppData');
const meetingsA = path.join(temp, 'meetings-a');
const meetingsB = path.join(temp, 'meetings-b');
const settingsA = path.join(temp, 'settings-a');
const settingsB = path.join(temp, 'settings-b');
const PORT = 8796;
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(ok: boolean, label: string): void {
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures++;
}

// MEETING_ASSISTANT_APPDATA 各平台都認（Mac 不看 APPDATA）；APPDATA 一起換掉，預設路徑也落在暫存資料夾
const env: NodeJS.ProcessEnv = {
  ...process.env,
  MEETING_ASSISTANT_APPDATA: path.join(appData, 'meeting-assistant'),
  APPDATA: appData,
  PORT: String(PORT),
};
delete env.MEETING_ASSISTANT_DATA_DIR;
const server = spawn(process.execPath, ['server/index.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (c: Buffer) => (log += c.toString()));
server.stderr.on('data', (c: Buffer) => (log += c.toString()));

async function waitUp(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      // 還沒起來
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`伺服器沒起來：\n${log}`);
}

/** fetch 不能改 Host 標頭，用 http 模組模擬 DNS rebinding（evil.example 解析到 127.0.0.1）。 */
function rawRequest(pathname: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port: PORT, path: pathname, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', () => resolve(-1));
    req.end();
  });
}

/** WebSocket 升級：被拒絕時伺服器直接斷線（回 -1），接受時回 101。 */
function upgradeStatus(origin: string): Promise<number> {
  return new Promise((resolve) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port: PORT,
      path: '/ws/live/x',
      headers: { connection: 'Upgrade', upgrade: 'websocket', origin, 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('response', (res) => resolve(res.statusCode ?? 0));
    req.on('error', () => resolve(-1));
    req.end();
  });
}

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

try {
  await waitUp();
  console.log(`測試資料在 ${temp}`);

  const first = await call('GET', '/api/setup');
  check(first.json.configured === false, '全新電腦：尚未設定');
  check(first.json.defaults.settingsDir === path.join(appData, 'meeting-assistant'), '設定預設在 %APPDATA%\\meeting-assistant');
  check(/Meeting Assistant$/.test(first.json.defaults.meetingsDir), '會議預設在「文件\\Meeting Assistant」');
  check(log.includes('第一次使用'), '啟動訊息提示第一次使用');

  check((await call('GET', '/api/meetings')).status === 409, '未設定前不能用會議 API');
  check((await call('GET', '/api/settings')).status === 409, '未設定前不能讀設定');

  const docs = path.join(os.homedir(), 'Documents', 'x');
  check(/文件/.test((await call('POST', '/api/setup/check', { path: docs })).json.risk ?? ''), '選在「文件」底下有紅字提示');
  check((await call('POST', '/api/setup/check', { path: settingsA })).json.risk === null, '暫存資料夾沒有提示');

  const evil = await call('POST', '/api/setup/pick', { initial: '' }, { origin: 'https://evil.example' });
  check(evil.status === 403, '其他網站不能叫出選資料夾視窗');
  check((await rawRequest('/api/setup', { host: `evil.example:${PORT}` })) === 403, 'Host 不是本機（DNS rebinding）時拒絕');
  check((await rawRequest('/api/setup', { host: `localhost:${PORT}` })) === 200, 'Host 是 localhost 照常');
  check((await upgradeStatus('https://evil.example')) === -1, '其他網站不能連 WebSocket');

  const bad = await call('POST', '/api/setup', { meetingsDir: 'relative', settingsDir: settingsA });
  check(bad.status === 400, '相對路徑被擋下（400，不是伺服器錯誤）');
  check(/完整路徑/.test(bad.json.error ?? ''), '錯誤訊息說明要填完整路徑');

  const done = await call('POST', '/api/setup', { meetingsDir: meetingsA, settingsDir: settingsA });
  check(done.status === 200 && done.json.configured === true, '選好位置後完成設定');
  check(existsSync(meetingsA) && existsSync(settingsA), '兩個資料夾都建立了');
  const location = JSON.parse(readFileSync(path.join(appData, 'meeting-assistant', 'location.json'), 'utf8'));
  check(location.meetingsDir === meetingsA && location.settingsDir === settingsA, 'location.json 記下兩個位置');
  check(!JSON.stringify(location).includes('Key'), 'location.json 不存 key');
  check((await call('POST', '/api/setup', { meetingsDir: meetingsB, settingsDir: settingsB })).status === 409, '設定過不能再走引導頁');

  const saved = await call('PUT', '/api/settings', { geminiApiKey: 'AIza-test-key-1234', transcriber: 'gemini' });
  check(saved.status === 200 && saved.json.settingsPath === settingsA, '設定存進選的設定資料夾');
  check(existsSync(path.join(settingsA, 'settings.json')), 'settings.json 在設定資料夾');
  writeFileSync(path.join(settingsA, '.env'), 'TYPELESS_API_KEY=tls_sk_from_env_5678\n');

  const created = await call('POST', '/api/meetings', { title: '位置測試' });
  check(created.status === 201 && existsSync(path.join(meetingsA, created.json.meeting.id)), '會議建在選的會議資料夾');

  const switched = await call('PUT', '/api/settings', { meetingsDir: meetingsB });
  check(switched.json.meetingsPath === meetingsB, '換會議資料夾');
  check((await call('GET', '/api/meetings')).json.meetings.length === 0, '換位置後清單讀新資料夾（舊會議不搬）');
  check(existsSync(path.join(meetingsA, created.json.meeting.id)), '舊會議留在原地');

  const moved = await call('POST', '/api/settings/move', { settingsDir: settingsB });
  check(moved.status === 200 && moved.json.moved.join(',') === 'settings.json,.env', '搬設定資料夾：settings.json 與 .env 都搬了');
  check(Array.isArray(moved.json.leftBehind) && moved.json.leftBehind.length === 0, '舊檔都刪掉了（leftBehind 是空的）');
  check(!existsSync(path.join(settingsA, 'settings.json')) && !existsSync(path.join(settingsA, '.env')), '舊位置的設定檔刪掉');
  check(moved.json.settings.geminiKeySet === true && moved.json.settings.typelessKeySet === true, '搬完 key 還讀得到，不用重填');

  writeFileSync(path.join(settingsA, 'settings.json'), '{}');
  const clash = await call('POST', '/api/settings/move', { settingsDir: settingsA });
  check(clash.status === 400 && /已經有/.test(clash.json.error ?? ''), '目的地已有設定檔時拒絕搬移');
  check((await call('GET', '/api/settings')).json.settingsPath === settingsB, '拒絕後設定位置不變');

  // 固定 port（這裡有設 PORT）時碰到另一份會議助手：要報錯退出（code 1），不能悄悄當成成功
  const second = spawn(process.execPath, ['server/index.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let secondLog = '';
  second.stdout.on('data', (c: Buffer) => (secondLog += c.toString()));
  second.stderr.on('data', (c: Buffer) => (secondLog += c.toString()));
  const code = await new Promise<number | null>((resolve) => second.on('exit', resolve));
  check(code === 1 && secondLog.includes('另一份會議助手'), '固定 port 碰到另一份會議助手時報錯退出');
} catch (err) {
  console.error(err);
  failures++;
} finally {
  server.kill();
}

if (failures) {
  console.log(`\n${failures} 項失敗。伺服器輸出：\n${log}`);
  process.exit(1);
}
console.log('\n全部通過。');
