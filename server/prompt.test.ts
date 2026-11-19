import assert from 'node:assert/strict';
import test from 'node:test';
import type { Meeting } from '../src/core/protocol.ts';
import { buildMinutesPrompt, notesForPrompt, transcriptForPrompt } from './prompt.ts';

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: '2026-11-18-1430-test',
    title: 'Q4 路線圖',
    agenda: '決定 Q4 要不要做離線模式',
    startedAt: '2026-11-18T06:30:00.000Z',
    endedAt: '2026-11-18T07:10:00.000Z',
    status: 'ended',
    engine: 'typeless',
    transcribeModel: 'typeless-1.0-pro',
    language: 'zh',
    keepAudio: false,
    segments: [
      {
        index: 0,
        label: '需求確認',
        startedAt: '2026-11-18T06:30:00.000Z',
        endedAt: '2026-11-18T06:40:00.000Z',
        offsetSec: 0,
        transcript: '客戶說離線模式是必須的。',
        status: 'done',
        durationSeconds: 600,
        billedSeconds: 600,
        requestId: 'r1',
        error: null,
      },
      {
        index: 1,
        label: null,
        startedAt: '2026-11-18T06:40:00.000Z',
        endedAt: '2026-11-18T06:50:00.000Z',
        offsetSec: 600,
        transcript: '討論工程成本。',
        status: 'done',
        durationSeconds: 600,
        billedSeconds: 600,
        requestId: 'r2',
        error: null,
      },
    ],
    notes: [
      { id: 'n1', kind: 'section', text: '需求確認', at: '2026-11-18T06:30:20.000Z', elapsedSec: 20, segmentIndex: 0 },
      { id: 'n2', kind: 'todo', text: '寄報價給 Amy', at: '2026-11-18T06:45:00.000Z', elapsedSec: 900, segmentIndex: 1 },
    ],
    references: [],
    minutes: null,
    ...overrides,
  };
}

test('逐字稿會被標上段號與環節', () => {
  const text = transcriptForPrompt(makeMeeting());
  assert.ok(text.includes('第 1 段'));
  assert.ok(text.includes('環節：需求確認'));
  assert.ok(text.includes('客戶說離線模式是必須的'));
  assert.ok(text.includes('未標記環節'));
});

test('筆記帶時間與類別，屬於最可信訊號', () => {
  const text = notesForPrompt(makeMeeting());
  assert.ok(text.includes('[待辦]'));
  assert.ok(text.includes('寄報價給 Amy'));
  assert.ok(text.includes('第 2 段'));
  assert.equal(notesForPrompt(makeMeeting({ notes: [] })), '（沒有即時筆記）');
});

test('prompt 含輸出結構與反杜撰規則', () => {
  const { system, user } = buildMinutesPrompt({ meeting: makeMeeting(), referenceContext: '' });
  assert.ok(system.includes('繁體中文'));
  assert.ok(system.includes('不要自己發明'));
  for (const heading of ['## TL;DR', '## 決議', '## 待辦', '## 各環節摘要', '## 未決與風險', '## 我的筆記整理', '## 校正紀錄']) {
    assert.ok(user.includes(heading), `缺少 ${heading}`);
  }
  assert.ok(user.includes('決定 Q4 要不要做離線模式'));
  assert.ok(user.includes('待指派'));
});

test('參考資料會被塞進 prompt', () => {
  const { user } = buildMinutesPrompt({
    meeting: makeMeeting(),
    referenceContext: '### 檔案：spec.md\n\n離線模式規格書',
  });
  assert.ok(user.includes('## 參考資料'));
  assert.ok(user.includes('離線模式規格書'));
});

test('超長逐字稿會截斷並標示', () => {
  const meeting = makeMeeting({
    segments: [
      {
        index: 0,
        label: null,
        startedAt: '2026-11-18T06:30:00.000Z',
        endedAt: null,
        offsetSec: 0,
        transcript: '甲'.repeat(200000),
        status: 'done',
        durationSeconds: 600,
        billedSeconds: 600,
        requestId: null,
        error: null,
      },
    ],
  });
  const text = transcriptForPrompt(meeting, 1000);
  assert.ok(text.includes('中段逐字稿因長度限制省略'));
  assert.ok(text.length < 1200);
});
