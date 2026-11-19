import assert from 'node:assert/strict';
import test from 'node:test';
import { escapeHtml, renderMarkdown, stripFrontmatter } from './markdown.ts';

test('frontmatter 不會出現在畫面上', () => {
  const md = '---\ntitle: 週會\ndate: 2026-11-18\ntags:\n  - meeting\n---\n## TL;DR\n- 重點\n';
  const body = stripFrontmatter(md);
  assert.ok(!body.includes('title:'));
  assert.ok(body.startsWith('## TL;DR'));
});

test('沒有 frontmatter 的內容原樣保留', () => {
  const md = '## TL;DR\n- 重點\n';
  assert.equal(stripFrontmatter(md), md);
});

test('開頭的 --- 如果是分隔線，不會被吃掉', () => {
  const md = '---\n\n## TL;DR\n';
  assert.equal(stripFrontmatter(md), md);
});

test('HTML 一定先跳脫', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('標題與段落', () => {
  const html = renderMarkdown('# 標題\n\n一段話。');
  assert.ok(html.includes('<h1>標題</h1>'));
  assert.ok(html.includes('<p>一段話。</p>'));
});

test('清單', () => {
  const html = renderMarkdown('- 一\n- 二');
  assert.ok(html.includes('<ul>'));
  assert.equal((html.match(/<li>/g) ?? []).length, 2);

  const ordered = renderMarkdown('1. 先做 A\n2. 再做 B');
  assert.ok(ordered.startsWith('<ol>'));
});

test('表格', () => {
  const html = renderMarkdown('| 事項 | 負責人 |\n|---|---|\n| 寄報價 | Amy |');
  assert.ok(html.includes('<table>'));
  assert.ok(html.includes('<th>事項</th>'));
  assert.ok(html.includes('<td>寄報價</td>'));
});

test('行內格式', () => {
  const html = renderMarkdown('**粗體** 與 `code` 與 [連結](https://example.com)');
  assert.ok(html.includes('<strong>粗體</strong>'));
  assert.ok(html.includes('<code>code</code>'));
  assert.ok(html.includes('href="https://example.com"'));
});

test('程式碼區塊不解析 markdown', () => {
  const html = renderMarkdown('```\n# 不是標題\n```');
  assert.ok(html.includes('<pre><code># 不是標題</code></pre>'));
  assert.ok(!html.includes('<h1>'));
});
