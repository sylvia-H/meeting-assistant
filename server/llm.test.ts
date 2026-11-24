import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anthropicContent, geminiParts, openaiContent, type PromptImage } from './llm.ts';

const img: PromptImage = { caption: '截圖 1（12 分貼上）', mime: 'image/jpeg', data: Buffer.from('abc') };

test('沒有截圖時，Claude／OpenAI 照舊送純文字', () => {
  assert.equal(anthropicContent('素材', []), '素材');
  assert.equal(openaiContent('素材', []), '素材');
  assert.deepEqual(geminiParts('素材', []), [{ text: '素材' }]);
});

test('Claude：文字在前，每張圖前面緊貼一行說明', () => {
  assert.deepEqual(anthropicContent('素材', [img]), [
    { type: 'text', text: '素材' },
    { type: 'text', text: '截圖 1（12 分貼上）' },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'YWJj' } },
  ]);
});

test('OpenAI：圖片用 data URL', () => {
  const content = openaiContent('素材', [img]) as { type: string; image_url?: { url: string } }[];
  assert.equal(content[2]?.type, 'image_url');
  assert.equal(content[2]?.image_url?.url, 'data:image/jpeg;base64,YWJj');
});

test('Gemini：圖片用 inlineData', () => {
  assert.deepEqual(geminiParts('素材', [img])[2], { inlineData: { mimeType: 'image/jpeg', data: 'YWJj' } });
});
