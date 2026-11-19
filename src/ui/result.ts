import type { Meeting } from '../core/protocol.ts';
import { formatClock, formatDate, formatDateTime, formatDuration, formatDurationZh } from '../core/format.ts';
import { renderMarkdown, stripFrontmatter } from '../core/markdown.ts';
import { NOTE_KINDS } from '../core/notes.ts';
import { copyText, el, escapeHtml, q, setBusy, toast } from './dom.ts';
import { errorText, type View } from './home.ts';
import {
  deleteMeeting,
  finishMeeting,
  getMeeting,
  getMinutes,
  revealMeeting,
  summarizeMeeting,
} from './api.ts';

export function renderMeeting(id: string): View {
  const root = el('div', 'page result');

  root.innerHTML = `
    <div class="result-head">
      <div>
        <a class="back" href="#/">← 所有會議</a>
        <h1 id="title">載入中…</h1>
        <p class="muted" id="meta"></p>
      </div>
      <div class="result-actions">
        <button class="primary" id="btn-summarize" type="button" disabled>產生會議紀錄</button>
        <button class="ghost" id="btn-folder" type="button">開啟資料夾</button>
        <button class="ghost" id="btn-copy" type="button">複製 markdown</button>
        <button class="ghost danger-text" id="btn-delete" type="button">刪除</button>
      </div>
    </div>

    <section class="card" id="minutes-card">
      <h2>會議紀錄</h2>
      <div id="minutes" class="markdown"><p class="muted">還沒有會議紀錄。按右上角「產生會議紀錄」。</p></div>
    </section>

    <details class="card" id="transcript-card">
      <summary><h2 style="display:inline">逐字稿</h2><span class="muted small" id="seg-count"></span></summary>
      <div id="transcript" class="transcript"><p class="muted">載入中…</p></div>
    </details>

    <details class="card" id="notes-card">
      <summary><h2 style="display:inline">筆記</h2><span class="muted small" id="note-count"></span></summary>
      <div id="notes" class="notes-static"></div>
    </details>
  `;

  const titleEl = q<HTMLElement>(root, '#title');
  const metaEl = q<HTMLElement>(root, '#meta');
  const minutesHost = q<HTMLElement>(root, '#minutes');
  const btnSummarize = q<HTMLButtonElement>(root, '#btn-summarize');
  const btnFolder = q<HTMLButtonElement>(root, '#btn-folder');
  const btnCopy = q<HTMLButtonElement>(root, '#btn-copy');
  const btnDelete = q<HTMLButtonElement>(root, '#btn-delete');

  let meeting: Meeting | null = null;
  let markdown = '';

  function renderHeader(): void {
    if (!meeting) return;
    titleEl.textContent = meeting.title;
    document.title = `${meeting.title} · 會議紀錄`;
    const sameDay = meeting.endedAt ? formatDate(meeting.endedAt) === formatDate(meeting.startedAt) : true;
    const end = meeting.endedAt ? (sameDay ? formatClock(meeting.endedAt) : formatDateTime(meeting.endedAt)) : '還沒結束';
    const range = meeting.endedAt
      ? `${formatClock(meeting.startedAt)} → ${end} · ${formatDurationZh((new Date(meeting.endedAt).getTime() - new Date(meeting.startedAt).getTime()) / 1000)}`
      : meeting.status === 'ready'
        ? '尚未開始'
        : `${formatClock(meeting.startedAt)} → 還沒結束 · 進行中`;
    const segCount = meeting.segments.filter((s) => s.transcript.trim()).length;
    metaEl.textContent = `${formatDate(meeting.startedAt)} · ${range} · ${segCount} 段逐字稿 · ${meeting.notes.length} 則筆記`;
    btnSummarize.textContent = meeting.minutes ? '重新產生紀錄' : '產生會議紀錄';
    btnSummarize.disabled = false;
  }

  function renderTranscript(): void {
    if (!meeting) return;
    const host = q<HTMLElement>(root, '#transcript');
    const segs = meeting.segments.filter((s) => s.transcript.trim());
    q<HTMLElement>(root, '#seg-count').textContent = segs.length ? ` · ${segs.length} 段` : '';
    host.innerHTML = segs.length
      ? segs
          .map(
            (seg) => `
        <article class="seg">
          <header>
            <span class="seg-index">${String(seg.index + 1).padStart(2, '0')}</span>
            <strong>${escapeHtml(seg.label?.trim() || '未標記環節')}</strong>
            <span class="muted small">${formatDuration(seg.offsetSec)} 起${seg.durationSeconds ? ` · ${formatDuration(seg.durationSeconds)}` : ''}</span>
          </header>
          <p>${escapeHtml(seg.transcript).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br />')}</p>
        </article>`,
          )
          .join('')
      : meeting.status === 'ready'
        ? '<p class="muted">這場還沒開始錄音，所以沒有逐字稿。按上方「開始錄音」。</p>'
        : '<p class="muted">這場沒有逐字稿。</p>';
  }

  function renderNotes(): void {
    if (!meeting) return;
    const host = q<HTMLElement>(root, '#notes');
    q<HTMLElement>(root, '#note-count').textContent = meeting.notes.length ? ` · ${meeting.notes.length} 則` : '';
    host.innerHTML = meeting.notes.length
      ? meeting.notes
          .map((note) => {
            const meta = NOTE_KINDS[note.kind];
            return `<div class="note" style="--kind:${meta.color}"><span class="note-time">${formatDuration(note.elapsedSec)}</span><span class="note-kind">${meta.label}</span><span class="note-text">${escapeHtml(note.text)}</span></div>`;
          })
          .join('')
      : '<p class="muted">沒有筆記。</p>';
  }

  async function load(): Promise<void> {
    try {
      const [meetingRes, minutesRes] = await Promise.all([getMeeting(id), getMinutes(id)]);
      meeting = meetingRes.meeting;
      markdown = minutesRes.markdown;
      renderHeader();
      renderTranscript();
      renderNotes();
      minutesHost.innerHTML = markdown
        ? renderMarkdown(stripFrontmatter(markdown))
        : '<p class="muted">還沒有會議紀錄。按右上角「產生會議紀錄」。</p>';
      if (meeting.status !== 'ended') {
        const actions = q<HTMLElement>(root, '.result-actions');
        if (meeting.status === 'ready') {
          const start = el('a', 'primary', '開始錄音');
          start.href = `#/live/${encodeURIComponent(id)}`;
          actions.prepend(start);
        }
        const finish = el('button', 'ghost', meeting.status === 'ready' ? '取消這場會議' : '標記為已結束');
        finish.addEventListener('click', async () => {
          await finishMeeting(id);
          toast('已標記結束');
          location.reload();
        });
        actions.appendChild(finish);
      }
    } catch (err) {
      minutesHost.innerHTML = `<p class="warn">載入失敗：${escapeHtml(errorText(err))}</p>`;
    }
  }

  btnSummarize.addEventListener('click', async () => {
    setBusy(btnSummarize, true, '整理中，可能要一分鐘…');
    try {
      const res = await summarizeMeeting(id, Boolean(meeting?.minutes));
      markdown = res.markdown;
      meeting = res.meeting;
      minutesHost.innerHTML = renderMarkdown(stripFrontmatter(markdown));
      renderHeader();
      toast('會議紀錄已存到 minutes.md');
    } catch (err) {
      toast(errorText(err), 'error', 8000);
    } finally {
      setBusy(btnSummarize, false);
    }
  });

  btnFolder.addEventListener('click', async () => {
    try {
      const res = await revealMeeting(id);
      toast(`已開啟：${res.path}`);
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });

  btnCopy.addEventListener('click', async () => {
    if (!markdown) {
      toast('還沒有紀錄可以複製', 'error');
      return;
    }
    await copyText(markdown);
    toast('已複製 markdown');
  });

  btnDelete.addEventListener('click', async () => {
    if (!confirm('確定刪除這場會議？逐字稿、筆記、紀錄和錄音檔都會一起刪掉，無法復原。')) return;
    try {
      await deleteMeeting(id);
      toast('已刪除');
      location.hash = '#/';
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });

  void load();

  return { node: root, destroy() {} };
}
