import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Meeting } from '../src/core/protocol.ts';
import { applyInfoPatch, applyTranscriptEdit } from './store.ts';

function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: '2026-11-24-1400-test',
    title: '舊名稱',
    agenda: '',
    startedAt: '2026-11-24T06:00:00.000Z',
    endedAt: null,
    status: 'ready',
    engine: 'gemini',
    transcribeModel: 'gemini-3-flash-preview',
    language: 'zh',
    keepAudio: false,
    segments: [],
    notes: [],
    references: [],
    minutes: null,
    ...overrides,
  };
}

test('改名稱：去掉多餘空白', () => {
  const m = meeting();
  applyInfoPatch(m, { title: '  Q4   產品路線圖 ' });
  assert.equal(m.title, 'Q4 產品路線圖');
});

test('名稱不能是空的、最多 80 字', () => {
  assert.throws(() => applyInfoPatch(meeting(), { title: '   ' }), /不能是空的/);
  assert.throws(() => applyInfoPatch(meeting(), { title: '字'.repeat(81) }), /80/);
});

test('錄音中、結束後也能改名稱', () => {
  const m = meeting({ status: 'ended' });
  applyInfoPatch(m, { title: '會後改名' });
  assert.equal(m.title, '會後改名');
});

test('還沒開始錄音時可以改開始時間', () => {
  const m = meeting();
  applyInfoPatch(m, { startedAt: '2026-11-24T08:30:00.000Z' });
  assert.equal(m.startedAt, '2026-11-24T08:30:00.000Z');
});

test('開始錄音後時間鎖定：計時與筆記時間點都依它', () => {
  assert.throws(() => applyInfoPatch(meeting({ status: 'recording' }), { startedAt: '2026-11-24T08:30:00.000Z' }), /不能再改/);
  assert.throws(() => applyInfoPatch(meeting({ status: 'ended' }), { startedAt: '2026-11-24T08:30:00.000Z' }), /不能再改/);
  // ready 但已經有段落（錄過又被標記回來的情況）一樣鎖
  const withSeg = meeting({ segments: [{} as Meeting['segments'][number]] });
  assert.throws(() => applyInfoPatch(withSeg, { startedAt: '2026-11-24T08:30:00.000Z' }), /不能再改/);
});

test('時間格式錯誤會擋下', () => {
  assert.throws(() => applyInfoPatch(meeting(), { startedAt: 'not a date' }), /格式/);
});

test('逐字稿校正：記下已校正與時間；內容沒變就不算修改', () => {
  const m = meeting({
    status: 'ended',
    segments: [{ index: 0, status: 'done', transcript: '原文' } as Meeting['segments'][number]],
  });
  assert.equal(applyTranscriptEdit(m, 0, '原文  \r\n'), false);
  assert.equal(applyTranscriptEdit(m, 0, '校正後\r\n第二行'), true);
  assert.equal(m.segments[0]?.transcript, '校正後\n第二行');
  assert.equal(m.segments[0]?.edited, true);
  assert.ok(m.segments[0]?.editedAt);
});

test('收音中／轉錄中的段落不能改，找不到的段落會報錯', () => {
  const m = meeting({ segments: [{ index: 0, status: 'finalizing', transcript: '' } as Meeting['segments'][number]] });
  assert.throws(() => applyTranscriptEdit(m, 0, 'x'), /還在轉錄/);
  assert.throws(() => applyTranscriptEdit(m, 3, 'x'), /找不到第 4 段/);
});
