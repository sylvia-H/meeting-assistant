import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatAttendees, parseAttendees } from './attendees.ts';

test('頓號分隔、括號寫身分（全形半形都可）', () => {
  assert.deepEqual(parseAttendees('王小明（PM）、Amy (廠商 IT)、陳大文'), [
    { name: '王小明', role: 'PM' },
    { name: 'Amy', role: '廠商 IT' },
    { name: '陳大文', role: '' },
  ]);
});

test('一行一位，斜線、冒號、空白後面當身分', () => {
  assert.deepEqual(parseAttendees('林小華 / SA\n張三：RD\n李四 廠商 IT 人員\n\n'), [
    { name: '林小華', role: 'SA' },
    { name: '張三', role: 'RD' },
    { name: '李四', role: '廠商 IT 人員' },
  ]);
});

test('重複的名字只留一個；格式化回文字', () => {
  const list = parseAttendees('Amy（PM）、Amy（RD）、Bob');
  assert.equal(list.length, 2);
  assert.equal(formatAttendees(list), 'Amy（PM）、Bob');
  assert.equal(formatAttendees(undefined), '');
});
