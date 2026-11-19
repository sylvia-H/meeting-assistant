import assert from 'node:assert/strict';
import test from 'node:test';
import { pcmToWav, cleanText, geminiModelChain } from './gemini.ts';

test('pcmToWav 產生 16 kHz / 16-bit / mono 的 WAV 檔頭', () => {
  const pcm = Buffer.alloc(3200, 7); // 100 ms
  const wav = pcmToWav(pcm);

  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length);
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
  assert.equal(wav.readUInt32LE(16), 16);
  assert.equal(wav.readUInt16LE(20), 1); // PCM
  assert.equal(wav.readUInt16LE(22), 1); // mono
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(28), 32000); // byte rate
  assert.equal(wav.readUInt16LE(32), 2); // block align
  assert.equal(wav.readUInt16LE(34), 16); // bits
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(wav.subarray(44), pcm);
});

test('pcmToWav 空音訊也能產生合法檔頭', () => {
  const wav = pcmToWav(Buffer.alloc(0));
  assert.equal(wav.length, 44);
  assert.equal(wav.readUInt32LE(40), 0);
  assert.equal(wav.readUInt32LE(4), 36);
});

test('cleanText 砍掉模型自己加的開場白', () => {
  assert.equal(cleanText('好的，以下是該音訊的完整逐字稿：\n今天討論後台設定。'), '今天討論後台設定。');
  assert.equal(cleanText('好的，以下是該段音訊的完整逐字稿：\n\n今天討論後台設定。'), '今天討論後台設定。');
  assert.equal(cleanText('以下是逐字稿：今天討論後台設定。'), '今天討論後台設定。');
});

test('cleanText 不會砍到內文的「以下是」', () => {
  const text = '今天討論後台設定。以下是我們要做的三件事。';
  assert.equal(cleanText(text), text);
});

test('cleanText 去掉 code fence 後再砍開場白', () => {
  assert.equal(cleanText('```text\n好的，以下是逐字稿：\n今天討論後台設定。\n```'), '今天討論後台設定。');
});

test('額度用完時，模型順序會接上另一顆備援（不重複自己）', () => {
  assert.deepEqual(geminiModelChain('gemini-3-flash-preview'), [
    'gemini-3-flash-preview',
    'gemini-flash-lite-latest',
  ]);
  assert.deepEqual(geminiModelChain('gemini-flash-lite-latest'), [
    'gemini-flash-lite-latest',
    'gemini-3-flash-preview',
  ]);
});

test('不在備援清單裡的模型排最前面，後面仍接兩顆備援', () => {
  assert.deepEqual(geminiModelChain('gemini-3.1-flash-lite'), [
    'gemini-3.1-flash-lite',
    'gemini-flash-lite-latest',
    'gemini-3-flash-preview',
  ]);
});

test('沒有指定模型時（空字串）不會留下空的模型 id', () => {
  assert.deepEqual(geminiModelChain('  '), ['gemini-flash-lite-latest', 'gemini-3-flash-preview']);
});
