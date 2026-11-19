const ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPE[ch] ?? ch);
}

function inline(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;!?]|$)/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return out;
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** 去掉 YAML frontmatter：那是給 Obsidian 讀的，不需要在畫面上佔一頁。 */
export function stripFrontmatter(markdown: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(markdown);
  if (!match) return markdown;
  const body = match[1] ?? '';
  if (!/^[a-zA-Z_][\w-]*:/m.test(body)) return markdown;
  return markdown.slice(match[0].length);
}

/** 夠用的 markdown → html：標題、清單、表格、引用、程式碼、分隔線 */
export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  const closeList = (tag: 'ul' | 'ol' | null): void => {
    if (tag) out.push(`</${tag}>`);
  };

  let listTag: 'ul' | 'ol' | null = null;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    if (trimmed === '') {
      closeList(listTag);
      listTag = null;
      i += 1;
      continue;
    }

    if (trimmed.startsWith('```')) {
      closeList(listTag);
      listTag = null;
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith('```')) {
        code.push(lines[i] ?? '');
        i += 1;
      }
      i += 1;
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    if (/^#{1,6}\s/.test(trimmed)) {
      closeList(listTag);
      listTag = null;
      const level = trimmed.match(/^#+/)?.[0].length ?? 1;
      const text = trimmed.replace(/^#+\s*/, '');
      out.push(`<h${level}>${inline(text)}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,})\s*$/.test(trimmed)) {
      closeList(listTag);
      listTag = null;
      out.push('<hr />');
      i += 1;
      continue;
    }

    if (trimmed.startsWith('|') && isTableSeparator(lines[i + 1] ?? '')) {
      closeList(listTag);
      listTag = null;
      const head = splitRow(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('|')) {
        rows.push(splitRow(lines[i] ?? ''));
        i += 1;
      }
      const thead = head.map((c) => `<th>${inline(c)}</th>`).join('');
      const tbody = rows
        .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
        .join('');
      out.push(`<div class="table-wrap"><table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`);
      continue;
    }

    if (trimmed.startsWith('>')) {
      closeList(listTag);
      listTag = null;
      const quote: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('>')) {
        quote.push((lines[i] ?? '').trim().replace(/^>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote><p>${inline(quote.join(' '))}</p></blockquote>`);
      continue;
    }

    const bullet = trimmed.match(/^[-*+]\s+(.*)$/);
    const ordered = trimmed.match(/^(\d+)[.)]\s+(.*)$/);

    if (bullet) {
      if (listTag !== 'ul') {
        closeList(listTag);
        out.push('<ul>');
        listTag = 'ul';
      }
      out.push(`<li>${inline(bullet[1] ?? '')}</li>`);
      i += 1;
      continue;
    }

    if (ordered) {
      if (listTag !== 'ol') {
        closeList(listTag);
        out.push('<ol>');
        listTag = 'ol';
      }
      out.push(`<li>${inline(ordered[2] ?? '')}</li>`);
      i += 1;
      continue;
    }

    closeList(listTag);
    listTag = null;
    out.push(`<p>${inline(trimmed)}</p>`);
    i += 1;
  }

  closeList(listTag);
  return out.join('\n');
}
