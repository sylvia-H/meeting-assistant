import type { Meeting, MeetingNote, NoteKind } from '../core/protocol.ts';
import { formatBytes, formatClock, formatDate, formatDateTime, formatDuration, formatDurationZh } from '../core/format.ts';
import { renderMarkdown, stripFrontmatter } from '../core/markdown.ts';
import { NOTE_KINDS, parseInput } from '../core/notes.ts';
import { copyText, el, escapeHtml, meetingsChanged, q, toast } from './dom.ts';
import { errorText, type View } from './home.ts';
import { icon } from './icons.ts';
import { meetingHead } from './meeting-head.ts';
import {
  addReferences,
  deleteMeeting,
  fileToBase64,
  finishMeeting,
  getMeeting,
  getMinutes,
  imageUrl,
  removeReference,
  revealMeeting,
  summarizeMeeting,
  updateSegment,
  addNote,
  deleteNote,
  updateNote,
} from './api.ts';

type Tab = 'notes' | 'transcript' | 'refs';
const TAB_KEY = 'meeting-assistant.result-tab';
const WIDTH_KEY = 'meeting-assistant.source-width';

export function renderMeeting(id: string): View {
  const root = el('div', 'page result');

  root.innerHTML = `
    <div class="toolbar">
      <span class="status-pill" id="status-pill"></span>
      <span class="state" id="meta"></span>
      <span class="sp"></span>
      <span class="toolbar-extra" id="extra-actions"></span>
      <button class="btn" id="btn-summarize" type="button" disabled>${icon('refresh')}<span>產生會議紀錄</span></button>
      <button class="btn" id="btn-folder" type="button">${icon('folder')}<span>開啟資料夾</span></button>
      <button class="btn primary" id="btn-copy" type="button">${icon('copy')}<span>複製 Markdown</span></button>
      <div class="menu-wrap">
        <button class="btn icon-only" id="btn-more" type="button" aria-haspopup="menu" aria-expanded="false" title="更多">${icon('more', '更多')}</button>
        <div class="menu" id="more-menu" role="menu" hidden>
          <button type="button" role="menuitem" class="danger" id="btn-delete">${icon('trash')}刪除這場會議</button>
        </div>
      </div>
    </div>

    <div class="result-body" id="result-body">
      <section class="pane-doc" aria-label="會議紀錄">
        <div class="scroll">
          <div class="sheet doc-sheet" id="doc-sheet">
            <p class="gen-line" id="gen-line"></p>
            <article id="minutes" class="markdown"><p class="empty">載入中…</p></article>
          </div>
        </div>
      </section>
      <div class="split" id="split" role="separator" aria-orientation="vertical" aria-label="拖曳調整紀錄與素材欄的寬度" tabindex="0" title="拖曳調整寬度，雙擊還原"></div>
      <section class="pane-source" aria-label="素材">
        <header class="pane-head">
          <div class="seg-ctl" id="tab-ctl" role="tablist" aria-label="素材">
            <button type="button" role="tab" data-tab="notes">筆記</button>
            <button type="button" role="tab" data-tab="transcript">逐字稿</button>
            <button type="button" role="tab" data-tab="refs">參考資料</button>
          </div>
          <span class="pane-sub" id="tab-count"></span>
        </header>
        <div class="scroll">
          <div class="source-list" data-tab="notes">
            <div id="notes"></div>
            <form class="post-composer" id="post-composer">
              <span class="tag k-note" id="post-chip">筆記</span>
              <input id="post-input" type="text" autocomplete="off" aria-label="新增會後筆記" placeholder="補上會後想法，Enter 新增（# ! ? > * 前綴分類）" />
            </form>
          </div>
          <div id="transcript" class="source-list" data-tab="transcript" hidden></div>
          <div id="refs" class="source-list" data-tab="refs" hidden></div>
        </div>
      </section>
    </div>
  `;

  const metaEl = q<HTMLElement>(root, '#meta');
  const pill = q<HTMLElement>(root, '#status-pill');
  const genLine = q<HTMLElement>(root, '#gen-line');
  const minutesHost = q<HTMLElement>(root, '#minutes');
  const btnSummarize = q<HTMLButtonElement>(root, '#btn-summarize');
  const btnFolder = q<HTMLButtonElement>(root, '#btn-folder');
  const btnCopy = q<HTMLButtonElement>(root, '#btn-copy');
  const btnMore = q<HTMLButtonElement>(root, '#btn-more');
  const menu = q<HTMLElement>(root, '#more-menu');
  const tabCtl = q<HTMLElement>(root, '#tab-ctl');
  const body = q<HTMLElement>(root, '#result-body');
  const split = q<HTMLElement>(root, '#split');

  let meeting: Meeting | null = null;
  let markdown = '';
  let tab: Tab = (localStorage.getItem(TAB_KEY) as Tab) || 'notes';

  const head = meetingHead(id, (next) => {
    meeting = next;
    renderHeader();
  });
  q<HTMLElement>(root, '#doc-sheet').prepend(head.node);

  function renderHeader(): void {
    if (!meeting) return;
    head.update(meeting);
    document.title = `${meeting.title} · 會議紀錄`;
    const segCount = meeting.segments.filter((s) => s.transcript.trim()).length;
    const counts = `${segCount} 段逐字稿 · ${meeting.notes.filter((n) => n.kind !== 'section').length} 則筆記`;
    if (meeting.status === 'ready') {
      pill.className = 'status-pill';
      pill.textContent = '尚未開始';
      metaEl.textContent = '還沒錄音，所以沒有逐字稿';
    } else if (meeting.status !== 'ended') {
      pill.className = 'status-pill live';
      pill.textContent = meeting.status === 'paused' ? '已暫停' : '錄音中';
      metaEl.textContent = `${formatClock(meeting.startedAt)} 開始 · ${counts}`;
    } else {
      const sameDay = meeting.endedAt ? formatDate(meeting.endedAt) === formatDate(meeting.startedAt) : true;
      const end = meeting.endedAt ? (sameDay ? formatClock(meeting.endedAt) : formatDateTime(meeting.endedAt)) : '';
      const dur = meeting.endedAt
        ? formatDurationZh((new Date(meeting.endedAt).getTime() - new Date(meeting.startedAt).getTime()) / 1000)
        : '';
      pill.className = `status-pill ${meeting.minutes ? 'done' : 'todo'}`;
      pill.textContent = meeting.minutes ? '已整理' : '待整理';
      metaEl.textContent = `${formatClock(meeting.startedAt)}–${end} · ${dur} · ${counts}`;
    }
    q<HTMLElement>(btnSummarize, 'span').textContent = meeting.minutes ? '重新產生' : '產生會議紀錄';
    btnSummarize.classList.toggle('primary', !meeting.minutes);
    btnCopy.classList.toggle('primary', Boolean(meeting.minutes));
    btnSummarize.disabled = false;
    const generatedAt = meeting.minutes?.generatedAt ?? '';
    const staleEdit =
      Boolean(generatedAt) &&
      [...meeting.segments, ...meeting.notes].some((x) => x.editedAt !== undefined && x.editedAt > generatedAt);
    genLine.innerHTML = meeting.minutes
      ? `<span class="chip">${escapeHtml(meeting.minutes.model)}</span>${formatDateTime(meeting.minutes.generatedAt)} 產生${
          staleEdit
            ? '<span class="stale">逐字稿或筆記在這之後改過，按「重新產生」讓紀錄跟上</span>'
            : ' · 逐字稿或筆記改過後可以重新產生'
        }`
      : '';
    genLine.hidden = !meeting.minutes;
  }

  function renderMinutes(): void {
    minutesHost.innerHTML = markdown
      ? renderMarkdown(stripFrontmatter(markdown).replace(/^#\s+.*\n+/, ''))
      : meeting?.status === 'ready'
        ? '<p class="empty">這場還沒開始錄音。到錄音頁按「開始錄音」，會後再回來產生會議紀錄。</p>'
        : '<p class="empty">還沒有會議紀錄。按右上角「產生會議紀錄」，LLM 會依逐字稿、筆記、截圖與參考資料整理，通常一分鐘內完成。</p>';
  }

  const EDIT_KINDS: NoteKind[] = ['decision', 'todo', 'question', 'idea', 'note'];

  function noteRow(note: MeetingNote): string {
    const remove = `<button type="button" class="icon-btn note-remove" data-remove="${escapeHtml(note.id)}" title="刪除這則" aria-label="刪除這則">${icon('trash')}</button>`;
    const when = note.postMeeting
      ? '<span class="post-tag">會後補充</span>'
      : `<time title="會議第 ${formatDuration(note.elapsedSec)}">${formatClock(note.at)}</time>`;
    if (note.kind === 'section') {
      return `<div class="sec sec-row" data-note-id="${escapeHtml(note.id)}"><textarea class="note-edit sec-edit" rows="1" aria-label="環節名稱">${escapeHtml(note.text)}</textarea>${when}${remove}</div>`;
    }
    const shot = note.image
      ? `<a class="note-shot" href="${imageUrl(id, note.image)}" target="_blank" rel="noopener" title="開新分頁看大圖"><img src="${imageUrl(id, note.image)}" alt="截圖" loading="lazy" /></a>`
      : '';
    const kindSelect = `<select class="tag tag-select k-${note.kind}" data-kind-of="${escapeHtml(note.id)}" aria-label="筆記類型" title="換類型">${EDIT_KINDS.map(
      (k) => `<option value="${k}" ${k === note.kind ? 'selected' : ''}>${NOTE_KINDS[k].label}</option>`,
    ).join('')}</select>`;
    return `<div class="note editable${note.image ? ' has-shot' : ''}" data-note-id="${escapeHtml(note.id)}">${kindSelect}<div class="note-body"><textarea class="note-edit" rows="1" aria-label="筆記內容" placeholder="${note.image ? '幫這張截圖寫一句說明' : ''}">${escapeHtml(note.text)}</textarea>${shot}</div><span class="note-side">${when}${remove}</span></div>`;
  }

  function renderSources(): void {
    if (!meeting) return;
    const notesHost = q<HTMLElement>(root, '#notes');
    if (!notesHost.contains(document.activeElement) && noteDrafts.size === 0) {
      notesHost.innerHTML = meeting.notes.length
        ? meeting.notes.map(noteRow).join('')
        : '<p class="empty">這場沒有筆記。用下面的輸入框補上會後想法。</p>';
    }

    // 有文字的段落，加上轉錄失敗的段落（會後還記得內容的話可以補上）
    const segs = meeting.segments.filter((s) => s.transcript.trim() || s.status === 'failed');
    const transcriptHost = q<HTMLElement>(root, '#transcript');
    // 正在改的時候不重畫，免得游標與打到一半的字被洗掉
    const editing = transcriptHost.contains(document.activeElement) || drafts.size > 0;
    if (!editing) transcriptHost.innerHTML = segs.length
      ? segs
          .map(
            (seg) => `
        <article class="seg" data-seg-index="${seg.index}">
          <h3 class="seg-head">
            <span class="seg-index">${String(seg.index + 1).padStart(2, '0')}</span>
            <span class="seg-label">${escapeHtml(seg.label?.trim() || '未標記環節')}</span>
            <span class="seg-time">${formatClock(seg.startedAt)}${seg.durationSeconds ? ` · ${formatDuration(seg.durationSeconds)}` : ''}</span>
            <span class="seg-edited"${seg.edited ? '' : ' hidden'}>已校正</span>
            <span class="seg-save" aria-live="polite"></span>
          </h3>
          ${seg.status === 'failed' ? `<p class="seg-error">這一段轉錄失敗：${escapeHtml(seg.error ?? '未知原因')}</p>` : ''}
          <textarea class="seg-text" data-index="${seg.index}" rows="1" spellcheck="false" aria-label="第 ${seg.index + 1} 段逐字稿" placeholder="${seg.status === 'failed' ? '記得這段在談什麼的話，可以直接打在這裡補上' : '這段沒有文字'}">${escapeHtml(seg.transcript)}</textarea>
        </article>`,
          )
          .join('')
      : meeting.status === 'ready'
        ? '<p class="empty">還沒開始錄音，所以沒有逐字稿。</p>'
        : '<p class="empty">這場沒有逐字稿。</p>';
    fitAll();
    fitNotes();

    const refs = meeting.references;
    q<HTMLElement>(root, '#refs').innerHTML = `
      ${
        refs.length
          ? refs
              .map(
                (r) =>
                  `<div class="ref-row"><span class="ref-name">${escapeHtml(r.name)}</span><small>${formatBytes(r.bytes)}</small><button type="button" class="icon-btn" data-ref="${escapeHtml(r.name)}" title="移除" aria-label="移除 ${escapeHtml(r.name)}">${icon('close')}</button></div>`,
              )
              .join('')
          : '<p class="empty">沒有參考資料。產生紀錄前加進來，會用來校正人名與專有名詞。</p>'
      }
      <label class="dropzone compact"><input type="file" id="ref-input" multiple hidden />${icon('upload')}<span>加入參考資料</span></label>`;

    const noteCount = meeting.notes.filter((n) => n.kind !== 'section').length;
    q<HTMLElement>(root, '#tab-count').textContent =
      tab === 'notes' ? `${noteCount} 則` : tab === 'transcript' ? `${segs.length} 段` : `${refs.length} 個檔案`;
  }

  // ── 會後校正逐字稿：停手 0.8 秒或離開輸入框就存 ─────────
  const drafts = new Map<number, string>();
  const saveTimers = new Map<number, number>();

  function fitTextarea(area: HTMLTextAreaElement): void {
    area.style.height = 'auto';
    area.style.height = `${area.scrollHeight}px`;
  }

  function fitAll(): void {
    requestAnimationFrame(() => {
      for (const area of root.querySelectorAll<HTMLTextAreaElement>('#transcript textarea.seg-text')) fitTextarea(area);
    });
  }

  function segEl(index: number): HTMLElement | null {
    return root.querySelector<HTMLElement>(`#transcript [data-seg-index="${index}"]`);
  }

  function setSaveState(index: number, text: string): void {
    const node = segEl(index)?.querySelector<HTMLElement>('.seg-save');
    if (node) node.textContent = text;
  }

  async function saveSegment(index: number): Promise<void> {
    window.clearTimeout(saveTimers.get(index));
    saveTimers.delete(index);
    const text = drafts.get(index);
    if (text === undefined) return;
    drafts.delete(index);
    setSaveState(index, '儲存中…');
    try {
      const res = await updateSegment(id, index, text);
      meeting = res.meeting;
      setSaveState(index, '已儲存');
      const badge = segEl(index)?.querySelector<HTMLElement>('.seg-edited');
      if (badge) badge.hidden = !meeting.segments.find((s) => s.index === index)?.edited;
      renderHeader();
    } catch (err) {
      // 沒存成功就把文字放回待存清單，下次停手會再試
      if (!drafts.has(index)) drafts.set(index, text);
      setSaveState(index, '沒存成功');
      toast(errorText(err), 'error', 7000);
    }
  }

  const transcriptPane = q<HTMLElement>(root, '#transcript');
  transcriptPane.addEventListener('input', (event) => {
    const area = event.target;
    if (!(area instanceof HTMLTextAreaElement) || !area.dataset.index) return;
    const index = Number(area.dataset.index);
    drafts.set(index, area.value);
    fitTextarea(area);
    setSaveState(index, '編輯中…');
    window.clearTimeout(saveTimers.get(index));
    saveTimers.set(index, window.setTimeout(() => void saveSegment(index), 800));
  });
  transcriptPane.addEventListener('focusout', (event) => {
    const area = event.target;
    if (area instanceof HTMLTextAreaElement && area.dataset.index) void saveSegment(Number(area.dataset.index));
  });

  // ── 會後修改筆記：停手 0.8 秒或離開就存；換類型、刪除立即生效 ─────
  const noteDrafts = new Map<string, string>();
  const noteTimers = new Map<string, number>();
  const notesPane = q<HTMLElement>(root, '#notes');

  function fitNotes(): void {
    requestAnimationFrame(() => {
      for (const area of notesPane.querySelectorAll<HTMLTextAreaElement>('textarea.note-edit')) fitTextarea(area);
    });
  }

  async function saveNote(noteId: string): Promise<void> {
    window.clearTimeout(noteTimers.get(noteId));
    noteTimers.delete(noteId);
    const text = noteDrafts.get(noteId);
    if (text === undefined) return;
    noteDrafts.delete(noteId);
    try {
      meeting = (await updateNote(id, noteId, { text })).meeting;
      renderHeader();
    } catch (err) {
      toast(errorText(err), 'error', 7000);
    }
  }

  notesPane.addEventListener('input', (event) => {
    const area = event.target;
    if (!(area instanceof HTMLTextAreaElement)) return;
    const noteId = area.closest<HTMLElement>('[data-note-id]')?.dataset.noteId;
    if (!noteId) return;
    noteDrafts.set(noteId, area.value);
    fitTextarea(area);
    window.clearTimeout(noteTimers.get(noteId));
    noteTimers.set(noteId, window.setTimeout(() => void saveNote(noteId), 800));
  });
  notesPane.addEventListener('keydown', (event) => {
    // 筆記是短句：Enter 直接存，Shift+Enter 才換行
    const area = event.target;
    if (area instanceof HTMLTextAreaElement && event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      area.blur();
    }
  });
  notesPane.addEventListener('focusout', (event) => {
    const noteId = (event.target as HTMLElement).closest<HTMLElement>('[data-note-id]')?.dataset.noteId;
    if (noteId && event.target instanceof HTMLTextAreaElement) void saveNote(noteId);
  });
  notesPane.addEventListener('change', async (event) => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement) || !select.dataset.kindOf) return;
    select.className = `tag tag-select k-${select.value}`;
    try {
      meeting = (await updateNote(id, select.dataset.kindOf, { kind: select.value })).meeting;
      renderHeader();
    } catch (err) {
      toast(errorText(err), 'error', 7000);
    }
  });
  notesPane.addEventListener('click', async (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-remove]');
    if (!button?.dataset.remove) return;
    const note = meeting?.notes.find((n) => n.id === button.dataset.remove);
    if (!note) return;
    if (!confirm(note.image ? '刪除這則截圖筆記？圖片也會一併刪除。' : `刪除這則筆記？\n「${note.text.slice(0, 40)}」`)) return;
    try {
      noteDrafts.delete(note.id);
      meeting = (await deleteNote(id, note.id)).meeting;
      renderHeader();
      renderSources();
      meetingsChanged();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });

  const postInput = q<HTMLInputElement>(root, '#post-input');
  const postChip = q<HTMLElement>(root, '#post-chip');
  postInput.addEventListener('input', () => {
    const parsed = parseInput(postInput.value);
    const kind = parsed.type === 'note' ? parsed.kind : 'note';
    postChip.className = `tag k-${kind}`;
    postChip.textContent = NOTE_KINDS[kind].label;
  });
  q<HTMLFormElement>(root, '#post-composer').addEventListener('submit', async (event) => {
    event.preventDefault();
    const parsed = parseInput(postInput.value);
    if (parsed.type !== 'note') {
      toast('會後筆記不支援指令，直接打文字就好', 'error');
      return;
    }
    if (!parsed.text) return;
    try {
      meeting = (await addNote(id, parsed.kind, parsed.text)).meeting;
      postInput.value = '';
      postChip.className = 'tag k-note';
      postChip.textContent = NOTE_KINDS.note.label;
      renderHeader();
      renderSources();
      meetingsChanged();
      const scroller = notesPane.closest<HTMLElement>('.scroll');
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });

  function setTab(next: Tab): void {
    tab = next;
    localStorage.setItem(TAB_KEY, next);
    for (const b of tabCtl.querySelectorAll<HTMLButtonElement>('button')) {
      const on = b.dataset.tab === next;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    }
    for (const pane of root.querySelectorAll<HTMLElement>('.source-list')) pane.hidden = pane.dataset.tab !== next;
    renderSources();
  }

  tabCtl.addEventListener('click', (event) => {
    const next = (event.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.tab as Tab | undefined;
    if (next) setTab(next);
  });

  root.addEventListener('click', async (event) => {
    const refBtn = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-ref]');
    if (!refBtn?.dataset.ref) return;
    try {
      meeting = (await removeReference(id, refBtn.dataset.ref)).meeting;
      renderSources();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });
  root.addEventListener('change', async (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.id !== 'ref-input' || !input.files?.length) return;
    try {
      const files = await Promise.all(
        Array.from(input.files).map(async (f) => ({ name: f.name, base64: await fileToBase64(f) })),
      );
      meeting = (await addReferences(id, files)).meeting;
      renderSources();
      toast(`已加入 ${files.length} 個檔案`);
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });

  async function load(): Promise<void> {
    try {
      const [meetingRes, minutesRes] = await Promise.all([getMeeting(id), getMinutes(id)]);
      meeting = meetingRes.meeting;
      markdown = minutesRes.markdown;
      renderHeader();
      renderMinutes();
      setTab(tab === 'transcript' || tab === 'refs' ? tab : 'notes');
      const extra = q<HTMLElement>(root, '#extra-actions');
      extra.innerHTML = '';
      if (meeting.status !== 'ended') {
        if (meeting.status === 'ready') {
          const start = el('a', 'btn primary', '開始錄音');
          start.href = `#/live/${encodeURIComponent(id)}`;
          extra.appendChild(start);
        }
        const finish = el('button', 'btn', meeting.status === 'ready' ? '取消這場會議' : '標記為已結束');
        finish.type = 'button';
        finish.addEventListener('click', async () => {
          await finishMeeting(id);
          meetingsChanged();
          toast('已標記結束');
          await load();
        });
        extra.appendChild(finish);
      }
    } catch (err) {
      minutesHost.innerHTML = `<p class="error-text">載入失敗：${escapeHtml(errorText(err))}</p>`;
    }
  }

  btnSummarize.addEventListener('click', async () => {
    // 不用 setBusy：它會把按鈕內容換成純文字，圖示跟著不見
    btnSummarize.disabled = true;
    q<HTMLElement>(btnSummarize, 'span').textContent = '整理中，可能要一分鐘…';
    try {
      const res = await summarizeMeeting(id, Boolean(meeting?.minutes));
      markdown = res.markdown;
      meeting = res.meeting;
      renderMinutes();
      meetingsChanged();
      toast('會議紀錄已存到 minutes.md');
    } catch (err) {
      toast(errorText(err), 'error', 8000);
    } finally {
      renderHeader();
      if (!meeting) btnSummarize.disabled = false;
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
      toast('還沒有紀錄可以複製，先按「產生會議紀錄」', 'error');
      return;
    }
    await copyText(markdown);
    toast('已複製 Markdown');
  });

  function closeMenu(): void {
    menu.hidden = true;
    btnMore.setAttribute('aria-expanded', 'false');
  }
  btnMore.addEventListener('click', (event) => {
    event.stopPropagation();
    menu.hidden = !menu.hidden;
    btnMore.setAttribute('aria-expanded', String(!menu.hidden));
  });
  const onDocClick = (): void => closeMenu();
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closeMenu();
  };
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKey);

  q<HTMLButtonElement>(root, '#btn-delete').addEventListener('click', async () => {
    closeMenu();
    if (!confirm('確定刪除這場會議？逐字稿、筆記、截圖、紀錄和錄音檔都會一起刪掉，無法復原。')) return;
    try {
      await deleteMeeting(id);
      meetingsChanged();
      toast('已刪除');
      location.hash = '#/';
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });

  // ── 分隔線：拖曳調整右側素材欄寬，記住寬度 ─────────────
  function setWidth(px: number): number {
    const max = Math.max(280, body.clientWidth - 420);
    const w = Math.round(Math.min(Math.max(px, 280), max));
    body.style.setProperty('--tr-w', `${w}px`);
    fitAll();
    return w;
  }
  split.addEventListener('pointerdown', (event) => {
    split.setPointerCapture(event.pointerId);
    split.classList.add('drag');
    document.body.classList.add('resizing');
    const move = (ev: PointerEvent): void => {
      setWidth(body.getBoundingClientRect().right - ev.clientX);
    };
    const up = (): void => {
      split.classList.remove('drag');
      document.body.classList.remove('resizing');
      split.removeEventListener('pointermove', move);
      const w = parseInt(body.style.getPropertyValue('--tr-w'), 10);
      if (w) localStorage.setItem(WIDTH_KEY, String(w));
    };
    split.addEventListener('pointermove', move);
    split.addEventListener('pointerup', up, { once: true });
    split.addEventListener('pointercancel', up, { once: true });
  });
  split.addEventListener('dblclick', () => {
    body.style.removeProperty('--tr-w');
    localStorage.removeItem(WIDTH_KEY);
  });
  split.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const pane = q<HTMLElement>(root, '.pane-source');
    localStorage.setItem(WIDTH_KEY, String(setWidth(pane.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? 24 : -24))));
  });
  const savedWidth = Number(localStorage.getItem(WIDTH_KEY));
  if (savedWidth) requestAnimationFrame(() => setWidth(savedWidth));

  void load();

  return {
    node: root,
    destroy() {
      for (const index of [...drafts.keys()]) void saveSegment(index);
      for (const noteId of [...noteDrafts.keys()]) void saveNote(noteId);
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey);
    },
  };
}
