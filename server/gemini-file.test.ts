import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mediaDurationSec, mimeForFile } from './gemini-file.ts';

test('mediaDurationSec 讀 mp4 mvhd（version 0）', () => {
  const buf = Buffer.alloc(64);
  buf.writeUInt32BE(100, 0);
  buf.write('mvhd', 4, 'ascii');
  buf.writeUInt8(0, 8);
  buf.writeUInt32BE(1000, 20); // timescale
  buf.writeUInt32BE(123456, 24); // duration
  assert.equal(mediaDurationSec(buf), 123.456);
});

test('mediaDurationSec 讀 mp4 mvhd（version 1）', () => {
  const buf = Buffer.alloc(80);
  buf.writeUInt32BE(112, 0);
  buf.write('mvhd', 4, 'ascii');
  buf.writeUInt8(1, 8);
  buf.writeUInt32BE(10000, 28); // timescale
  buf.writeBigUInt64BE(123456789n, 32); // duration
  assert.equal(mediaDurationSec(buf), 12345.6789);
});

test('mediaDurationSec 對不是 mp4 的資料回 null', () => {
  assert.equal(mediaDurationSec(Buffer.from('not a video')), null);
});

test('mimeForFile 認得常見格式', () => {
  assert.equal(mimeForFile('a.M4A'), 'audio/m4a');
  assert.equal(mimeForFile('b.mp3'), 'audio/mp3');
  assert.equal(mimeForFile('c.wav'), 'audio/wav');
  assert.equal(mimeForFile('d.xyz'), null);
});
