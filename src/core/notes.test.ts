import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInput } from './notes.ts';
import type { ParsedInput } from './notes.ts';

function asNote(raw: string): Extract<ParsedInput, { type: 'note' }> {
  const parsed = parseInput(raw);
  assert.equal(parsed.type, 'note', `預期是筆記，實際是 ${parsed.type}`);
  return parsed as Extract<ParsedInput, { type: 'note' }>;
}

function asCommand(raw: string): Extract<ParsedInput, { type: 'command' }> {
  const parsed = parseInput(raw);
  assert.equal(parsed.type, 'command', `預期是指令，實際是 ${parsed.type}`);
  return parsed as Extract<ParsedInput, { type: 'command' }>;
}

test('符號前綴對應到正確類別', () => {
  assert.deepEqual(asNote('# 需求確認'), { type: 'note', kind: 'section', text: '需求確認', prefix: '#' });
  assert.deepEqual(asNote('! 寄報價給 Amy'), { type: 'note', kind: 'todo', text: '寄報價給 Amy', prefix: '!' });
  assert.deepEqual(asNote('> 先用 A 方案'), { type: 'note', kind: 'decision', text: '先用 A 方案', prefix: '>' });
  assert.deepEqual(asNote('? 誰負責前端'), { type: 'note', kind: 'question', text: '誰負責前端', prefix: '?' });
  assert.deepEqual(asNote('* 可以抽成模板'), { type: 'note', kind: 'idea', text: '可以抽成模板', prefix: '*' });
});

test('字母別名也能用', () => {
  assert.equal(asNote('t: 寄報價').kind, 'todo');
  assert.equal(asNote('S: 中場休息').kind, 'section');
  assert.equal(asNote('q:要問法務').kind, 'question');
});

test('全形符號視同半形', () => {
  assert.equal(asNote('＃ 需求確認').kind, 'section');
  assert.equal(asNote('！寄報價').kind, 'todo');
  assert.equal(asNote('？誰負責').kind, 'question');
});

test('沒有前綴就是一般筆記', () => {
  const parsed = asNote('客戶提到他們下個月要換系統');
  assert.equal(parsed.kind, 'note');
  assert.equal(parsed.text, '客戶提到他們下個月要換系統');
});

test('斜線指令', () => {
  assert.deepEqual(asCommand('/pause'), { type: 'command', command: 'pause', arg: '', raw: '/pause' });
  assert.deepEqual(asCommand('/seg 新環節'), { type: 'command', command: 'seg', arg: '新環節', raw: '/seg 新環節' });
  assert.equal(asCommand('/end').command, 'end');
  assert.equal(asCommand('/stop').command, 'end');
});

test('未知指令退回一般筆記，不會吃掉內容', () => {
  const parsed = asNote('/覺得這個方向可以');
  assert.ok(parsed.text.includes('覺得這個方向可以'));
});

test('只有前綴、沒有內容時 text 是空的', () => {
  assert.equal(asNote('#').text, '');
});
