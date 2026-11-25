import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cloudRisk, ensureWritable, moveSettingsFiles } from './paths.ts';

const temp = (): string => mkdtempSync(path.join(os.tmpdir(), 'ma-paths-'));

test('文件、桌面底下的設定位置會有雲端提示', () => {
  const home = os.homedir();
  assert.match(cloudRisk(path.join(home, 'Documents', 'Meeting Assistant')) ?? '', /文件/);
  assert.match(cloudRisk(path.join(home, 'Desktop', 'x')) ?? '', /桌面/);
});

test('OneDrive 資料夾會有雲端提示（含公司版的「OneDrive - 公司名」）', () => {
  assert.match(cloudRisk(path.join(os.homedir(), 'OneDrive - Contoso', 'keys')) ?? '', /OneDrive/);
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

test('moveSettingsFiles 搬 settings.json 與 .env，舊的刪掉', () => {
  const from = temp();
  const to = temp();
  writeFileSync(path.join(from, 'settings.json'), '{"geminiApiKey":"k"}');
  writeFileSync(path.join(from, '.env'), 'A=1');
  writeFileSync(path.join(from, 'location.json'), '{}');
  assert.deepEqual(moveSettingsFiles(from, to), ['settings.json', '.env']);
  assert.equal(readFileSync(path.join(to, 'settings.json'), 'utf8'), '{"geminiApiKey":"k"}');
  assert.ok(!existsSync(path.join(from, 'settings.json')));
  assert.ok(!existsSync(path.join(from, '.env')));
  assert.ok(existsSync(path.join(from, 'location.json')), '只搬設定檔，其他檔案不動');
});

test('moveSettingsFiles 目的地已有設定檔時不覆蓋、原檔保留', () => {
  const from = temp();
  const to = temp();
  writeFileSync(path.join(from, 'settings.json'), 'old');
  writeFileSync(path.join(to, 'settings.json'), 'other');
  assert.throws(() => moveSettingsFiles(from, to), /已經有 settings\.json/);
  assert.equal(readFileSync(path.join(from, 'settings.json'), 'utf8'), 'old');
  assert.equal(readFileSync(path.join(to, 'settings.json'), 'utf8'), 'other');
});

test('moveSettingsFiles 同一個位置什麼都不做', () => {
  const dir = temp();
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'settings.json'), 'x');
  assert.deepEqual(moveSettingsFiles(dir, `${dir}${path.sep}`), []);
  assert.ok(existsSync(path.join(dir, 'settings.json')));
});
