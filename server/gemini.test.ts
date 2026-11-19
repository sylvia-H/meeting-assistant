import assert from 'node:assert/strict';
import test from 'node:test';
import { pcmToWav } from './gemini.ts';

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
