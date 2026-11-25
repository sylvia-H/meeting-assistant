import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cloudRisk,
  copySettingsFiles,
  ensureWritable,
  isConfigured,
  LocationCorruptError,
  removeSettingsFiles,
  settingsDir,
  writeLocation,
} from './paths.ts';

const temp = (): string => mkdtempSync(path.join(os.tmpdir(), 'ma-paths-'));

test('文件、桌面底下的設定位置會有雲端提示', () => {
  const home = os.homedir();
  assert.match(cloudRisk(path.join(home, 'Documents', 'Meeting Assistant')) ?? '', /文件/);
  assert.match(cloudRisk(path.join(home, 'Desktop', 'x')) ?? '', /桌面/);
});

test('OneDrive 資料夾會有雲端提示（含公司版的「OneDrive - 公司名」）', () => {
  assert.match(cloudRisk(path.join(os.homedir(), 'OneDrive - Contoso', 'keys')) ?? '', /OneDrive/);
});

// D:\ 這種磁碟路徑只在 Windows 是絕對路徑；Mac／Linux 會被接到目前目錄後面
test('其他磁碟上的 OneDrive 也算', { skip: process.platform !== 'win32' }, () => {
  assert.match(cloudRisk('D:\\OneDrive\\keys') ?? '', /OneDrive/);
});

test('預設的應用程式資料夾與一般磁碟路徑沒有提示', () => {
  assert.equal(cloudRisk(path.join(os.homedir(), 'AppData', 'Roaming', 'meeting-assistant')), null);
  assert.equal(cloudRisk(path.join(temp(), 'settings')), null);
  assert.equal(cloudRisk(''), null);
});

test('「文件」的字首相同但不在裡面，不算', () => {
  assert.equal(cloudRisk(path.join(os.homedir(), 'Documents-backup')), null);
});

test('ensureWritable 會建立資料夾，並擋掉相對路徑與空白', () => {
  const dir = path.join(temp(), 'a', 'b');
  assert.equal(ensureWritable(dir, '會議資料夾'), path.resolve(dir));
  assert.ok(existsSync(dir));
  assert.throws(() => ensureWritable('meetings', '會議資料夾'), /完整路徑/);
  assert.throws(() => ensureWritable('  ', '會議資料夾'), /不能留白/);
});

test('ensureWritable 寫不進去時說明原因', () => {
  const root = temp();
  const file = path.join(root, 'not-a-dir');
  writeFileSync(file, 'x');
  assert.throws(() => ensureWritable(path.join(file, 'child'), '設定資料夾'), /設定資料夾無法使用/);
});

test('搬設定檔：先複製比對，刪舊檔是另一步', () => {
  const from = temp();
  const to = temp();
  writeFileSync(path.join(from, 'settings.json'), '{"geminiApiKey":"k"}');
  writeFileSync(path.join(from, '.env'), 'A=1');
  writeFileSync(path.join(from, 'location.json'), '{}');
  const copied = copySettingsFiles(from, to);
  assert.deepEqual(copied, ['settings.json', '.env']);
  assert.equal(readFileSync(path.join(to, 'settings.json'), 'utf8'), '{"geminiApiKey":"k"}');
  assert.ok(existsSync(path.join(from, 'settings.json')), '複製完舊檔還在，等位置改好才刪');
  assert.deepEqual(removeSettingsFiles(from, copied), []);
  assert.ok(!existsSync(path.join(from, 'settings.json')));
  assert.ok(!existsSync(path.join(from, '.env')));
  assert.ok(existsSync(path.join(from, 'location.json')), '只搬設定檔，其他檔案不動');
});

test('搬設定檔：目的地已有設定檔時不覆蓋、原檔保留', () => {
  const from = temp();
  const to = temp();
  writeFileSync(path.join(from, 'settings.json'), 'old');
  writeFileSync(path.join(to, 'settings.json'), 'other');
  assert.throws(() => copySettingsFiles(from, to), /已經有 settings\.json/);
  assert.equal(readFileSync(path.join(from, 'settings.json'), 'utf8'), 'old');
  assert.equal(readFileSync(path.join(to, 'settings.json'), 'utf8'), 'other');
});

test('搬設定檔：複製到一半失敗，已複製的清掉、原檔不動', () => {
  const from = temp();
  const to = temp();
  writeFileSync(path.join(from, 'settings.json'), 'keys');
  // .env 是資料夾：copyFileSync 會失敗，模擬第二個檔複製不了
  mkdirSync(path.join(from, '.env'));
  assert.throws(() => copySettingsFiles(from, to));
  assert.ok(!existsSync(path.join(to, 'settings.json')), '第一個已複製的被清掉');
  assert.equal(readFileSync(path.join(from, 'settings.json'), 'utf8'), 'keys');
});

test('搬設定檔：刪不掉的舊檔回報檔名，不丟錯', () => {
  const dir = temp();
  // 非空資料夾 rmSync（不帶 recursive）會失敗，模擬檔案被鎖住
  mkdirSync(path.join(dir, '.env'));
  writeFileSync(path.join(dir, '.env', 'x'), '1');
  assert.deepEqual(removeSettingsFiles(dir, ['.env']), ['.env']);
});

test('搬設定檔：同一個位置什麼都不做', () => {
  const dir = temp();
  writeFileSync(path.join(dir, 'settings.json'), 'x');
  assert.deepEqual(copySettingsFiles(dir, `${dir}${path.sep}`), []);
  assert.ok(existsSync(path.join(dir, 'settings.json')));
});

test('location.json：原子寫入，損壞時報錯而不是當成沒設定過', () => {
  const appData = temp();
  const before = process.env.MEETING_ASSISTANT_APPDATA;
  process.env.MEETING_ASSISTANT_APPDATA = appData;
  try {
    assert.equal(isConfigured(), false);
    const settingsAt = temp();
    writeLocation({ settingsDir: settingsAt });
    assert.equal(isConfigured(), true);
    assert.equal(settingsDir(), settingsAt);
    assert.deepEqual(readdirSync(appData), ['location.json'], '沒有留下暫存檔');
    writeFileSync(path.join(appData, 'location.json'), '{"settingsDir": "C:\\\\x');
    assert.equal(isConfigured(), true, '損壞也算設定過，不重跳引導頁');
    assert.throws(() => settingsDir(), LocationCorruptError);
  } finally {
    if (before === undefined) delete process.env.MEETING_ASSISTANT_APPDATA;
    else process.env.MEETING_ASSISTANT_APPDATA = before;
  }
});
