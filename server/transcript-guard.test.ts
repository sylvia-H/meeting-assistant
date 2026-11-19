import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cutRunawayRepeat } from './transcript-guard.ts';

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
