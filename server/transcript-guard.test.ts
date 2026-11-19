import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SILENCE_RMS, cutRunawayRepeat, pcmRms } from './transcript-guard.ts';

test('砍掉尾端鬼打牆的短句重複', () => {
  const head = '正常的會議內容，大家討論專有名詞的定義。';
  const loop = '那個時候，'.repeat(500);
  const result = cutRunawayRepeat(head + loop);
  assert.equal(result.cut, true);
  assert.equal(result.text, head);
  assert.ok(result.times >= 400);
});

test('長句（30 字）反覆輸出也會砍', () => {
  const head = '前半段的內容。';
  const unit = '我們這邊要請佩蓉一起幫忙確認後台的設定是不是正確的。';
  const result = cutRunawayRepeat(head + unit.repeat(50));
  assert.equal(result.cut, true);
  assert.equal(result.text, head);
});

test('正常口語重複不要誤砍', () => {
  const text = '對。對。對。對。對。對。我們下一頁。';
  const result = cutRunawayRepeat(text);
  assert.equal(result.cut, false);
  assert.equal(result.text, text);
});

test('短逐字稿直接跳過檢查', () => {
  const text = '好，今天先到這邊。';
  assert.deepEqual(cutRunawayRepeat(text), { text, cut: false, times: 0 });
});

test('全零的 PCM 量出 RMS 0（麥克風沒收到聲音）', () => {
  assert.equal(pcmRms(Buffer.alloc(32000)), 0);
  assert.equal(pcmRms(Buffer.alloc(0)), 0);
});

test('正常說話的音量遠高於靜音門檻', () => {
  // 半振幅的方波，RMS 應該是 0.5
  const pcm = Buffer.alloc(3200);
  for (let i = 0; i < 1600; i += 1) pcm.writeInt16LE(i % 2 === 0 ? 16384 : -16384, i * 2);
  assert.equal(Number(pcmRms(pcm).toFixed(3)), 0.5);
  assert.ok(pcmRms(pcm) > SILENCE_RMS);
});

test('極低底噪會被當成靜音，但一般底噪不會', () => {
  const quiet = Buffer.alloc(3200);
  for (let i = 0; i < 1600; i += 1) quiet.writeInt16LE(i % 2 === 0 ? 3 : -3, i * 2); // RMS ≈ 0.0001
  assert.ok(pcmRms(quiet) < SILENCE_RMS);

  const room = Buffer.alloc(3200);
  for (let i = 0; i < 1600; i += 1) room.writeInt16LE(i % 2 === 0 ? 300 : -300, i * 2); // RMS ≈ 0.009
  assert.ok(pcmRms(room) > SILENCE_RMS);
});
