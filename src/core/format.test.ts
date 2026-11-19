import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateCost, formatBytes, formatDuration, formatDurationZh } from './format.ts';
import { TYPELESS_PRICE_PER_HOUR } from './protocol.ts';

test('formatDuration 分秒與時分秒', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(7), '0:07');
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(3725), '1:02:05');
  assert.equal(formatDuration(-4), '0:00');
});

test('formatDurationZh 中文寫法', () => {
  assert.equal(formatDurationZh(45), '45 秒');
  assert.equal(formatDurationZh(128), '2 分 08 秒');
  assert.equal(formatDurationZh(2700), '45 分鐘');
  assert.equal(formatDurationZh(3600 + 240), '1 小時 04 分');
  assert.equal(formatDurationZh(7200), '2 小時');
});

test('estimateCost 依模型費率換算', () => {
  assert.equal(estimateCost(3600, 'typeless-1.0-pro', TYPELESS_PRICE_PER_HOUR), 0.5);
  assert.equal(estimateCost(3600, 'typeless-1.0-max', TYPELESS_PRICE_PER_HOUR), 2.5);
  assert.equal(estimateCost(1800, 'typeless-1.0-lite', TYPELESS_PRICE_PER_HOUR), 0.125);
  assert.equal(estimateCost(60, 'unknown-model', TYPELESS_PRICE_PER_HOUR), 0);
});

test('formatBytes', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
});
