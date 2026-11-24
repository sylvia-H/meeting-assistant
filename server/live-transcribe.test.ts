import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DailyQuotaError, MaxTokensError, TransientGeminiError } from './gemini.ts';
import { RETRY_WAITS_MS, splitPcm, transcribeLiveSegment } from './live-transcribe.ts';

const SECOND = 32000;
const pcmOf = (seconds: number) => Buffer.alloc(Math.round(seconds * SECOND));
const LOOP = '那個時候，'.repeat(200);

function fake(script: (pcm: Buffer, model: string, call: number) => string) {
  const calls: { model: string; seconds: number }[] = [];
  const waits: number[] = [];
  const notices: string[] = [];
  return {
    calls,
    waits,
    notices,
    deps: {
      transcribe: async (pcm: Buffer, model: string) => {
        calls.push({ model, seconds: pcm.length / SECOND });
        return script(pcm, model, calls.length);
      },
      sleep: async (ms: number) => {
        waits.push(ms);
      },
      onNotice: (message: string) => notices.push(message),
    },
  };
}

test('一次就過：不重試、不換模型', async () => {
  const f = fake(() => '大家好');
  const result = await transcribeLiveSegment(pcmOf(180), ['a', 'b'], f.deps);
  assert.equal(result.text, '大家好');
  assert.equal(result.model, 'a');
  assert.deepEqual(f.waits, []);
  assert.equal(f.calls.length, 1);
});

test('503 等一下重送同一顆模型就過', async () => {
  const f = fake((_pcm, _model, call) => {
    if (call === 1) throw new TransientGeminiError(503, 'busy');
    return '第二次成功';
  });
  const result = await transcribeLiveSegment(pcmOf(180), ['a', 'b'], f.deps);
  assert.equal(result.text, '第二次成功');
  assert.equal(result.model, 'a');
  assert.deepEqual(f.waits, [RETRY_WAITS_MS[0]]);
  assert.deepEqual(result.quotaExhausted, []);
});

test('同一顆一直 503：重試用完換備援模型，但不算額度用完', async () => {
  const f = fake((_pcm, model) => {
    if (model === 'a') throw new TransientGeminiError(503, 'busy');
    return '備援成功';
  });
  const result = await transcribeLiveSegment(pcmOf(180), ['a', 'b'], f.deps);
  assert.equal(result.text, '備援成功');
  assert.equal(result.model, 'b');
  assert.deepEqual(result.quotaExhausted, []);
  assert.deepEqual(f.waits, [...RETRY_WAITS_MS]);
  assert.deepEqual(
    f.calls.map((c) => c.model),
    ['a', 'a', 'a', 'b'],
  );
});

test('每日額度用完：直接換下一顆，不浪費時間等待', async () => {
  const f = fake((_pcm, model) => {
    if (model === 'a') throw new DailyQuotaError('a', 'quota');
    return 'ok';
  });
  const result = await transcribeLiveSegment(pcmOf(180), ['a', 'b'], f.deps);
  assert.equal(result.model, 'b');
  assert.deepEqual(result.quotaExhausted, ['a']);
  assert.deepEqual(f.waits, []);
});

test('所有模型額度都用完：錯誤訊息說明重置時間', async () => {
  const f = fake((_pcm, model) => {
    throw new DailyQuotaError(model, 'quota');
  });
  await assert.rejects(transcribeLiveSegment(pcmOf(180), ['a', 'b'], f.deps), /所有轉錄模型都用完了（a、b）/);
});

test('一般錯誤（key 錯）不重試、不換模型', async () => {
  const f = fake(() => {
    throw new Error('Gemini API key 無效');
  });
  await assert.rejects(transcribeLiveSegment(pcmOf(180), ['a', 'b'], f.deps), /key 無效/);
  assert.equal(f.calls.length, 1);
});

test('MAX_TOKENS：切兩半各自重送，接起來', async () => {
  const f = fake((pcm) => {
    if (pcm.length / SECOND > 100) throw new MaxTokensError(`前面是對的${LOOP}`);
    return `半段 ${pcm.length / SECOND} 秒`;
  });
  const result = await transcribeLiveSegment(pcmOf(180), ['a'], f.deps);
  assert.equal(result.text, '半段 90 秒\n半段 90 秒');
  assert.equal(result.splits, 1);
  assert.equal(result.trimmed, false);
  assert.deepEqual(
    f.calls.map((c) => c.seconds),
    [180, 90, 90],
  );
});

test('回傳正常但尾端鬼打牆：一樣切半重送', async () => {
  const f = fake((pcm) => (pcm.length / SECOND > 100 ? `開頭${LOOP}` : '乾淨的半段'));
  const result = await transcribeLiveSegment(pcmOf(180), ['a'], f.deps);
  assert.equal(result.text, '乾淨的半段\n乾淨的半段');
});

test('切到底還是鬼打牆：保留砍掉重複後的文字並標記', async () => {
  const f = fake(() => {
    throw new MaxTokensError(`還記得的開頭${LOOP}`);
  });
  const result = await transcribeLiveSegment(pcmOf(180), ['a'], f.deps);
  // 180 → 90 → 45：兩層共 1 + 2 + 4 = 7 次
  assert.equal(f.calls.length, 7);
  assert.equal(result.trimmed, true);
  assert.ok(result.text.startsWith('還記得的開頭'));
  assert.ok(!result.text.includes('那個時候，那個時候，'));
});

test('短段落鬼打牆不切，直接保留前面的文字', async () => {
  const f = fake(() => {
    throw new MaxTokensError(`短段${LOOP}`);
  });
  const result = await transcribeLiveSegment(pcmOf(30), ['a'], f.deps);
  assert.equal(f.calls.length, 1);
  assert.equal(result.text, '短段');
});

test('splitPcm 切點對齊 16-bit 樣本', () => {
  const [a, b] = splitPcm(Buffer.alloc(10));
  assert.equal(a.length % 2, 0);
  assert.equal(a.length + b.length, 10);
});
