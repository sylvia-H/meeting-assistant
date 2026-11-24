import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SILENCE_PEAK, cutRunawayRepeat, pcmLevels, silenceReason } from './transcript-guard.ts';

function pcmFromAmplitude(amplitudes: number[], samplesPerFrame = 1600): Buffer {
  const pcm = Buffer.alloc(amplitudes.length * samplesPerFrame * 2);
  amplitudes.forEach((amplitude, frame) => {
    const base = frame * samplesPerFrame;
    for (let i = 0; i < samplesPerFrame; i += 1) {
      const value = i % 2 === 0 ? amplitude : -amplitude;
      pcm.writeInt16LE(Math.round(value * 32767), (base + i) * 2);
    }
  });
  return pcm;
}

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

test('全零的 PCM 判定為沒有聲音', () => {
  const levels = pcmLevels(Buffer.alloc(32000));
  assert.equal(levels.rms, 0);
  assert.equal(levels.p95, 0);
  assert.equal(silenceReason(levels), '幾乎沒有聲音');
  assert.equal(silenceReason(pcmLevels(Buffer.alloc(0))), '幾乎沒有聲音');
});

test('正常說話的音量可以通過', () => {
  // 講話 3 秒、停頓 1 秒交錯，音量有明顯起伏
  const levels = pcmLevels(pcmFromAmplitude([0.08, 0.06, 0.09, 0.002, 0.07, 0.05, 0.08, 0.002]));
  assert.equal(silenceReason(levels), null);
  assert.ok(levels.p95 > SILENCE_PEAK);
});

test('一直很平的低頻底噪（風扇、藍牙耳機雜訊）也會被擋下來', () => {
  const levels = pcmLevels(pcmFromAmplitude(Array.from({ length: 20 }, (_, i) => 0.02 + (i % 3) * 0.0005)));
  assert.equal(silenceReason(levels), '只有持續底噪、沒有說話的起伏');
});

test('極低底噪（幾乎全零）判定為沒有聲音', () => {
  const levels = pcmLevels(pcmFromAmplitude(Array.from({ length: 10 }, () => 0.0001)));
  assert.equal(silenceReason(levels), '幾乎沒有聲音');
});
