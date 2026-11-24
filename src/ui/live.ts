import type { ClientMessage, LiveState, Meeting, MeetingNote, Segment } from '../core/protocol.ts';
import { MAX_NOTE_IMAGES, TYPELESS_PRICE_PER_HOUR } from '../core/protocol.ts';
import { estimateCost, formatClock, formatDuration } from '../core/format.ts';
import { NOTE_KINDS, kindMeta, parseInput } from '../core/notes.ts';
import { startCapture, type MicHandle } from './audio.ts';
import { deleteNoteImage, getMeeting, imageUrl, uploadNoteImage } from './api.ts';
import { shrinkImage } from './image.ts';
import { el, escapeHtml, q, toast } from './dom.ts';
import { errorText, type View } from './home.ts';

export function renderLive(id: string): View {
  const root = el('div', 'page live');

  root.innerHTML = `
    <section class="live-head">
      <div class="live-title">
        <h1 id="meeting-title">載入中…</h1>
        <div class="live-sub">
          <span id="status-dot" class="dot"></span>
          <span id="status-text">連線中</span>
          <span class="sep">·</span>
          <span id="segment-info">尚未開始</span>
          <span class="sep">·</span>
          <span id="cost-info">$0.000</span>
        </div>
      </div>
      <div class="live-clock">
        <span id="timer">0:00</span>
        <div class="meter" title="收音音量"><div id="meter-bar"></div></div>
      </div>
      <div class="live-source">
        <label class="sr-only" for="audio-source">音訊來源</label>
        <select id="audio-source" title="音訊來源">
          <option value="mic">麥克風</option>
          <option value="mic+system">麥克風＋會議音訊</option>
          <option value="system">只有會議音訊</option>
        </select>
        <span id="mic-label" class="source-label">尚未收音</span>
      </div>
      <div class="live-actions">
        <button class="primary" id="btn-start" type="button">開始錄音</button>
        <button class="ghost" id="btn-pause" type="button" hidden>暫停</button>
        <button class="ghost" id="btn-cut" type="button" hidden>切段</button>
        <button class="danger" id="btn-end" type="button" hidden>結束會議</button>
      </div>
    </section>

    <div id="banner" class="banner" hidden></div>

    <div class="live-body">
      <section class="panel">
        <header class="panel-head">
          <h2>逐字稿</h2>
          <span class="muted small" id="transcribe-note">逐字稿會在「切段」後出現。</span>
        </header>
        <div id="segments" class="segments"><p class="muted">還沒開始。</p></div>
      </section>

      <section class="panel">
        <header class="panel-head">
          <h2>即時筆記</h2>
          <span class="muted small">時間軸由下往上累積</span>
        </header>
        <div id="notes" class="notes"><p class="muted">用下面的輸入框打第一則。</p></div>
      </section>
    </div>

    <form id="composer" class="composer">
      <span class="kind-chip" id="kind-chip">筆記</span>
      <span class="attach" id="attach" hidden>
        <button type="button" class="attach-remove" id="attach-remove" title="不附這張" aria-label="不附這張截圖">×</button>
      </span>
      <input id="note-input" type="text" autocomplete="off" placeholder="直接打，或先用前綴：# 環節　! 待辦　? 待確認　> 決議　* 想法；截圖可以直接 Ctrl+V 貼上" />
      <button type="submit">送出</button>
    </form>
    <div class="legend">
      ${Object.entries(NOTE_KINDS)
        .map(
          ([, meta]) =>
            `<span class="legend-item" title="${escapeHtml(meta.hint)}"><code>${escapeHtml(meta.symbol)}</code>${escapeHtml(meta.label)}</span>`,
        )
        .join('')}
      <span class="legend-item"><code>/pause</code><code>/resume</code><code>/seg 名稱</code><code>/end</code>指令</span>
    </div>
  `;

  const titleEl = q<HTMLElement>(root, '#meeting-title');
  const dotEl = q<HTMLElement>(root, '#status-dot');
  const statusEl = q<HTMLElement>(root, '#status-text');
  const segmentInfo = q<HTMLElement>(root, '#segment-info');
  const costInfo = q<HTMLElement>(root, '#cost-info');
  const transcribeNote = q<HTMLElement>(root, '#transcribe-note');
  const timerEl = q<HTMLElement>(root, '#timer');
  const meterBar = q<HTMLElement>(root, '#meter-bar');
  const sourceSelect = q<HTMLSelectElement>(root, '#audio-source');
  const micLabel = q<HTMLElement>(root, '#mic-label');
  const btnStart = q<HTMLButtonElement>(root, '#btn-start');
  const btnPause = q<HTMLButtonElement>(root, '#btn-pause');
  const btnCut = q<HTMLButtonElement>(root, '#btn-cut');
  const btnEnd = q<HTMLButtonElement>(root, '#btn-end');
  const banner = q<HTMLElement>(root, '#banner');
  const segmentsHost = q<HTMLElement>(root, '#segments');
  const notesHost = q<HTMLElement>(root, '#notes');
  const composer = q<HTMLFormElement>(root, '#composer');
  const input = q<HTMLInputElement>(root, '#note-input');
  const chip = q<HTMLElement>(root, '#kind-chip');

  let meeting: Meeting | null = null;
  const notes: MeetingNote[] = [];
  const segments: Segment[] = [];
  let ws: WebSocket | null = null;
  let mic: MicHandle | null = null;
  let micEnabled = false;
  let raf = 0;
  let ending = false;
  let destroyed = false;
  let quietSince = 0;
  let quietWarned = false;

  // ── 連線 ────────────────────────────────────────────────
  function connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws/live/${encodeURIComponent(id)}`);

    ws.addEventListener('open', () => {
      banner.hidden = true;
      setStatus('已連線');
      flushDrafts();
    });

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as
        | { type: 'hello'; meeting: Meeting; state: LiveState }
        | { type: 'state'; state: LiveState }
        | { type: 'meeting'; meeting: Meeting }
        | { type: 'segment'; segment: Segment }
        | { type: 'note'; note: MeetingNote }
        | { type: 'note-removed'; id: string }
        | { type: 'ended'; meeting: Meeting }
        | { type: 'error'; message: string }
        | { type: 'notice'; message: string };

      switch (msg.type) {
        case 'hello':
          meeting = msg.meeting;
          segments.length = 0;
          segments.push(...msg.meeting.segments);
          notes.length = 0;
          notes.push(...msg.meeting.notes);
          titleEl.textContent = msg.meeting.title;
          document.title = `${msg.meeting.title} · 會議助手`;
          transcribeNote.textContent =
            msg.meeting.engine === 'gemini'
              ? 'Gemini 會在「切段」時把音訊轉成文字；出來的文字可以直接點進去改錯字、補充。'
              : 'Typeless 只在「切段」時回傳文字；出來的文字可以直接點進去改錯字、補充。';
          renderAll();
          applyState(msg.state);
          if (msg.meeting.status === 'paused' || msg.meeting.status === 'recording') {
            btnStart.textContent = '繼續收音';
            btnStart.hidden = false;
          }
          break;
        case 'state':
          applyState(msg.state);
          break;
        case 'meeting':
          meeting = msg.meeting;
          transcribeNote.textContent =
            msg.meeting.engine === 'gemini'
              ? 'Gemini 會在「切段」時把音訊轉成文字；出來的文字可以直接點進去改錯字、補充。'
              : 'Typeless 只在「切段」時回傳文字；出來的文字可以直接點進去改錯字、補充。';
          renderAll();
          break;
        case 'segment': {
          const index = segments.findIndex((s) => s.index === msg.segment.index);
          if (index >= 0) segments[index] = msg.segment;
          else segments.push(msg.segment);
          renderSegments();
          break;
        }
        case 'note':
          notes.push(msg.note);
          renderNotes();
          break;
        case 'note-removed': {
          const at = notes.findIndex((n) => n.id === msg.id);
          if (at >= 0) notes.splice(at, 1);
          renderNotes();
          break;
        }
        case 'ended':
          meeting = msg.meeting;
          ending = true;
          teardownMic();
          toast('會議已結束，正在開啟整理頁');
          location.hash = `#/meeting/${encodeURIComponent(id)}`;
          break;
        case 'error':
          toast(msg.message, 'error', 6000);
          break;
        case 'notice':
          toast(msg.message, 'info', 9000);
          break;
      }
    });

    ws.addEventListener('close', () => {
      if (destroyed || ending) return;
      setStatus('連線中斷');
      banner.hidden = false;
      banner.innerHTML = `與本機伺服器的連線斷了。錄音已自動存檔並暫停。<button class="ghost" id="btn-reconnect" type="button">重新連線</button>`;
      q<HTMLButtonElement>(banner, '#btn-reconnect').addEventListener('click', () => {
        banner.hidden = true;
        connect();
      });
      teardownMic();
    });
  }

  function send(msg: ClientMessage): void {
    if (ws?.readyState !== WebSocket.OPEN) {
      toast('還沒連上伺服器，稍等一下再試', 'error');
      return;
    }
    ws.send(JSON.stringify(msg));
  }

  // ── 音訊來源 ────────────────────────────────────────────
  const SOURCE_KEY = 'meeting-assistant.audio-source';
  type SourceMode = 'mic' | 'mic+system' | 'system';

  function savedSource(): SourceMode {
    const raw = localStorage.getItem(SOURCE_KEY);
    return raw === 'mic+system' || raw === 'system' ? raw : 'mic';
  }

  function setSource(mode: SourceMode, persist: boolean): void {
    sourceSelect.value = mode;
    if (persist) localStorage.setItem(SOURCE_KEY, mode);
  }

  function openCapture(mode: SourceMode): Promise<MicHandle> {
    return startCapture(
      { mic: mode !== 'system', system: mode !== 'mic' },
      (frame) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(frame);
      },
      onCaptureEnded,
    );
  }

  /** 使用者在 Chrome 的分享列按「停止分享」，只有分享的那條音軌會結束，麥克風還在。 */
  function onCaptureEnded(label: string, kind: 'mic' | 'system'): void {
    if (destroyed) return;
    if (kind === 'mic') {
      micLabel.textContent = '麥克風已中斷';
      toast(`麥克風斷了（${label}）：確認裝置有沒有被拔掉，或換一個輸入裝置後重新開始錄音。`, 'error', 10_000);
      return;
    }
    micLabel.textContent = '分享已停止';
    if (sourceSelect.value !== 'mic') {
      setSource('mic', true);
      toast(`會議音訊已停止分享（${label}），之後只會收到麥克風。`, 'info', 9000);
    }
  }

  async function armMic(): Promise<void> {
    if (mic) {
      mic.setEnabled(true);
      micEnabled = true;
      return;
    }
    const mode = sourceSelect.value as SourceMode;
    try {
      mic = await openCapture(mode);
    } catch (err) {
      if (mode === 'mic') throw err;
      // 分享被取消、或分享時沒勾音訊：退回只收麥克風，至少還錄得到自己的聲音
      const reason = errorText(err);
      try {
        mic = await openCapture('mic');
      } catch (micErr) {
        throw new Error(`會議音訊：${reason}；麥克風：${errorText(micErr)}`);
      }
      setSource('mic', true);
      toast(`沒拿到會議音訊（${reason}），這場先只收麥克風。`, 'error', 10_000);
    }
    micEnabled = true;
    sourceSelect.disabled = true;
    micLabel.textContent = mic.label;
    micLabel.title = mic.label;
    loopLevel();
  }

  function loopLevel(): void {
    cancelAnimationFrame(raf);
    const tick = (): void => {
      if (!mic || destroyed) return;
      const level = micEnabled ? mic.level() : 0;
      meterBar.style.width = `${Math.round(level * 100)}%`;
      // 連續 20 秒幾乎沒聲音就提醒一次：靜音送出去 Gemini 會自己編一份假逐字稿
      if (micEnabled) {
        if (level < 0.01) {
          if (!quietSince) quietSince = performance.now();
          else if (!quietWarned && performance.now() - quietSince > 20_000) {
            quietWarned = true;
            toast(
              '已經 20 秒幾乎沒有收到聲音：確認麥克風有沒有選錯或靜音；分享會議音訊時要勾「分享音訊」。',
              'error',
              10_000,
            );
          }
        } else {
          quietSince = 0;
          quietWarned = false;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  function teardownMic(): void {
    micEnabled = false;
    quietSince = 0;
    quietWarned = false;
    cancelAnimationFrame(raf);
    meterBar.style.width = '0%';
    mic?.stop();
    mic = null;
    sourceSelect.disabled = false;
    micLabel.textContent = '尚未收音';
    micLabel.title = '';
  }

  async function startRecording(): Promise<void> {
    try {
      await armMic();
    } catch (err) {
      toast(`拿不到音訊：${errorText(err)}`, 'error', 6000);
      return;
    }
    const status = meeting?.status;
    if (status === 'paused') send({ type: 'resume' });
    else send({ type: 'start' });
    btnStart.hidden = true;
    btnPause.hidden = false;
    btnCut.hidden = false;
    btnEnd.hidden = false;
    input.focus();
  }

  function applyState(state: LiveState): void {
    if (meeting) meeting.status = state.status;
    timerEl.textContent = formatDuration(state.elapsedSec);
    statusEl.textContent =
      state.status === 'recording'
        ? '錄音中'
        : state.status === 'paused'
          ? '已暫停'
          : state.status === 'ended'
            ? '已結束'
            : '待開始';
    dotEl.dataset.status = state.status;
    segmentInfo.textContent =
      state.segmentIndex >= 0
        ? `第 ${state.segmentIndex + 1} 段${state.segmentLabel ? ` · ${state.segmentLabel}` : ''} · ${formatDuration(state.segmentElapsedSec)}${state.pendingSegments ? ` · ${state.pendingSegments} 段整理中` : ''}`
        : '尚未開始';
    costInfo.textContent =
      meeting?.engine === 'gemini'
        ? 'Gemini 免費額度'
        : `$${estimateCost(state.billedSeconds, meeting?.transcribeModel ?? '', TYPELESS_PRICE_PER_HOUR).toFixed(3)}`;
    renderSegments();
  }

  // ── 畫面 ────────────────────────────────────────────────
  function setStatus(text: string): void {
    statusEl.textContent = text;
  }

  function renderAll(): void {
    renderSegments();
    renderNotes();
  }

  // 逐字稿可以直接改：每段一個 article，用 index 當 key 增量更新。
  // state 訊息每秒都會觸發重畫，整塊 innerHTML 重寫會把正在打字的游標與內容洗掉。
  const segEls = new Map<number, { el: HTMLElement; sig: string }>();
  /** 還沒存到伺服器的修改（打字中、或斷線時改的），重新連上後補送 */
  const drafts = new Map<number, string>();
  const saveTimers = new Map<number, number>();

  function segSignature(seg: Segment): string {
    return JSON.stringify([seg.status, seg.transcript, seg.label, seg.durationSeconds, seg.error, seg.startedAt, seg.edited]);
  }

  function isEditing(index: number): boolean {
    const active = document.activeElement;
    return (
      drafts.has(index) ||
      (active instanceof HTMLTextAreaElement && active.dataset.index === String(index))
    );
  }

  function segHtml(seg: Segment): string {
    const label = seg.label?.trim() || '未標記環節';
    const duration = seg.durationSeconds ? ` · ${formatDuration(seg.durationSeconds)}` : '';
    const editable = seg.status === 'done' || seg.status === 'failed';
    const status =
      seg.status === 'open'
        ? `<p class="muted recording">收音中…（切段後才會出現逐字稿）</p>`
        : seg.status === 'finalizing'
          ? `<p class="muted">轉錄中…</p>`
          : seg.status === 'failed'
            ? `<p class="warn">這一段失敗：${escapeHtml(seg.error ?? '未知原因')}</p>`
            : '';
    const placeholder =
      seg.status === 'failed' ? '轉錄失敗。記得這段在談什麼的話，可以直接打在這裡補上。' : '這段沒有文字，可以直接補上。';
    // 用 innerHTML 放初始文字（不是設 .value）：textContent 才找得到逐字稿，e2e 靠它判斷
    const body = editable
      ? `<textarea class="seg-text" data-index="${seg.index}" rows="1" spellcheck="false" aria-label="第 ${seg.index + 1} 段逐字稿" placeholder="${placeholder}">${escapeHtml(seg.transcript)}</textarea>`
      : '';
    return `
      <header>
        <span class="seg-index">${String(seg.index + 1).padStart(2, '0')}</span>
        <strong>${escapeHtml(label)}</strong>
        <span class="muted small">${formatClock(seg.startedAt)}${duration}</span>
        ${seg.edited ? `<span class="seg-edited small">已校正</span>` : ''}
        <span class="seg-save small" aria-live="polite"></span>
      </header>
      ${status}${body}`;
  }

  function fitTextarea(area: HTMLTextAreaElement): void {
    area.style.height = 'auto';
    area.style.height = `${area.scrollHeight}px`;
  }

  function setSaveState(index: number, text: string): void {
    const node = segEls.get(index)?.el.querySelector<HTMLElement>('.seg-save');
    if (node) node.textContent = text;
  }

  function saveEdit(index: number): void {
    window.clearTimeout(saveTimers.get(index));
    saveTimers.delete(index);
    const text = drafts.get(index);
    if (text === undefined) return;
    if (ws?.readyState !== WebSocket.OPEN) {
      setSaveState(index, '未連線，重新連上後會自動存');
      return;
    }
    ws.send(JSON.stringify({ type: 'edit', index, transcript: text } satisfies ClientMessage));
    drafts.delete(index);
    setSaveState(index, '已儲存');
  }

  function flushDrafts(): void {
    for (const index of [...drafts.keys()]) saveEdit(index);
  }

  segmentsHost.addEventListener('input', (event) => {
    const area = event.target;
    if (!(area instanceof HTMLTextAreaElement) || !area.dataset.index) return;
    const index = Number(area.dataset.index);
    drafts.set(index, area.value);
    fitTextarea(area);
    setSaveState(index, '編輯中…');
    window.clearTimeout(saveTimers.get(index));
    saveTimers.set(index, window.setTimeout(() => saveEdit(index), 800));
  });

  segmentsHost.addEventListener('focusout', (event) => {
    const area = event.target;
    if (!(area instanceof HTMLTextAreaElement) || !area.dataset.index) return;
    saveEdit(Number(area.dataset.index));
    // 編輯期間伺服器送來的更新先擱著，離開輸入框再補畫
    queueMicrotask(renderSegments);
  });

  function renderSegments(): void {
    if (!meeting && !segments.length) return;
    const visible = segments
      .slice()
      .sort((a, b) => a.index - b.index)
      .filter((seg) => seg.transcript.trim().length > 0 || seg.status !== 'done' || isEditing(seg.index));
    if (!visible.length) {
      segEls.clear();
      segmentsHost.innerHTML = segments.length
        ? `<p class="muted">錄音中，等第一個切段。</p>`
        : `<p class="muted">還沒開始。按右上角「開始錄音」，第一段會在切段後出現。</p>`;
      return;
    }

    const stick = isNearBottom(segmentsHost);
    const keep = new Set(visible.map((seg) => seg.index));
    for (const [index, entry] of segEls) {
      if (!keep.has(index)) {
        entry.el.remove();
        segEls.delete(index);
      }
    }
    // 拿掉「還沒開始」之類的提示文字
    for (const child of [...segmentsHost.children]) {
      if (!(child as HTMLElement).dataset.segIndex) child.remove();
    }

    let added = false;
    let prev: Element | null = null;
    for (const seg of visible) {
      const sig = segSignature(seg);
      let entry = segEls.get(seg.index);
      if (!entry) {
        const article = document.createElement('article');
        article.className = 'seg';
        article.dataset.segIndex = String(seg.index);
        article.innerHTML = segHtml(seg);
        entry = { el: article, sig };
        segEls.set(seg.index, entry);
        added = true;
      } else if (entry.sig !== sig && !isEditing(seg.index)) {
        entry.el.innerHTML = segHtml(seg);
        entry.sig = sig;
      }
      // 只在位置不對時才搬動節點，搬動會讓正在編輯的輸入框失焦
      const expected: Element | null = prev ? prev.nextElementSibling : segmentsHost.firstElementChild;
      if (expected !== entry.el) {
        if (prev) prev.after(entry.el);
        else segmentsHost.prepend(entry.el);
      }
      prev = entry.el;
    }

    for (const area of segmentsHost.querySelectorAll<HTMLTextAreaElement>('textarea.seg-text')) {
      if (area.style.height === '' || area.dataset.fitted !== String(area.value.length)) {
        fitTextarea(area);
        area.dataset.fitted = String(area.value.length);
      }
    }

    if (added && stick) segmentsHost.scrollTop = segmentsHost.scrollHeight;
  }

  function renderNotes(): void {
    if (!notes.length) {
      notesHost.innerHTML = `<p class="muted">用下面的輸入框打第一則。</p>`;
      return;
    }
    notesHost.innerHTML = notes
      .map((note) => {
        const meta = kindMeta(note.kind);
        // 一行寫完：.note-text 是 pre-wrap，模板裡的換行會變成空白行
        const shot = note.image
          ? `<a class="note-shot" href="${imageUrl(id, note.image)}" target="_blank" rel="noopener" title="開新分頁看大圖"><img src="${imageUrl(id, note.image)}" alt="截圖${note.text ? `：${escapeHtml(note.text)}` : ''}" loading="lazy" /></a>` +
            `<button type="button" class="note-del" data-note-id="${escapeHtml(note.id)}" title="刪掉這則截圖筆記">刪除截圖</button>`
          : '';
        return `
          <div class="note${note.image ? ' has-shot' : ''}" style="--kind:${meta.color}">
            <span class="note-time">${formatDuration(note.elapsedSec)}</span>
            <span class="note-kind">${meta.label}</span>
            <span class="note-text">${escapeHtml(note.text)}${shot}</span>
          </div>`;
      })
      .join('');
    notesHost.scrollTop = notesHost.scrollHeight;
  }

  function isNearBottom(node: HTMLElement): boolean {
    return node.scrollHeight - node.scrollTop - node.clientHeight < 120;
  }

  // ── 輸入 ────────────────────────────────────────────────
  function updateChip(): void {
    const parsed = parseInput(input.value);
    if (parsed.type === 'command') {
      chip.textContent = `指令 · ${parsed.command}`;
      chip.style.color = '#94a3b8';
      return;
    }
    const meta = kindMeta(parsed.kind);
    chip.textContent = meta.label;
    chip.style.color = meta.color;
  }

  // ── 截圖 ────────────────────────────────────────────────
  // 貼上 → 瀏覽器縮圖 → 上傳存檔 → 輸入框旁顯示預覽；按送出時跟文字一起變成一則筆記。
  const attach = q<HTMLElement>(root, '#attach');
  let pendingImage: string | null = null;
  let uploading = false;

  function setPending(name: string | null): void {
    pendingImage = name;
    attach.hidden = !name;
    // 沒有圖時不留空的 <img>（會顯示成破圖框）
    attach.querySelector('img')?.remove();
    if (name) {
      const img = document.createElement('img');
      img.alt = '準備附上的截圖';
      img.src = imageUrl(id, name);
      attach.prepend(img);
    }
    input.placeholder = name
      ? '幫這張截圖寫一句說明（可留白），按 Enter 送出'
      : '直接打，或先用前綴：# 環節　! 待辦　? 待確認　> 決議　* 想法；截圖可以直接 Ctrl+V 貼上';
  }

  function discardPending(): void {
    const name = pendingImage;
    setPending(null);
    if (name) void deleteNoteImage(id, name).catch(() => undefined);
  }

  async function attachImage(file: File): Promise<void> {
    if (uploading) {
      toast('上一張還在上傳，稍等一下', 'info');
      return;
    }
    if (notes.filter((n) => n.image).length >= MAX_NOTE_IMAGES) {
      toast(`這場會議已經有 ${MAX_NOTE_IMAGES} 張截圖（上限）。刪掉用不到的再貼。`, 'error', 8000);
      return;
    }
    uploading = true;
    attach.hidden = false;
    attach.classList.add('loading');
    try {
      const shrunk = await shrinkImage(file);
      const name = await uploadNoteImage(id, shrunk);
      if (pendingImage) discardPending(); // 再貼一張就換掉前一張
      setPending(name);
      input.focus();
    } catch (err) {
      if (!pendingImage) attach.hidden = true;
      toast(`截圖沒有附上：${errorText(err)}`, 'error', 8000);
    } finally {
      uploading = false;
      attach.classList.remove('loading');
    }
  }

  function onPaste(event: ClipboardEvent): void {
    const target = event.target as HTMLElement | null;
    // 在逐字稿輸入框裡貼東西是在改逐字稿，不攔
    if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
    const file = [...(event.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
    if (!file) return;
    event.preventDefault();
    void attachImage(file);
  }
  document.addEventListener('paste', onPaste);

  q<HTMLButtonElement>(root, '#attach-remove').addEventListener('click', () => {
    discardPending();
    input.focus();
  });

  notesHost.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.note-del');
    if (!button?.dataset.noteId) return;
    if (!confirm('刪掉這則截圖筆記？圖片也會一併刪除，不會送進會議紀錄。')) return;
    send({ type: 'delete-note', id: button.dataset.noteId });
  });

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    const raw = input.value;
    if (uploading) {
      toast('截圖還在上傳，稍等一下再送', 'info');
      return;
    }
    if (!raw.trim() && !pendingImage) return;
    const parsed = parseInput(raw);

    if (parsed.type === 'command') {
      if (parsed.command === 'pause') {
        send({ type: 'pause' });
        mic?.setEnabled(false);
        micEnabled = false;
      } else if (parsed.command === 'resume') {
        send({ type: 'resume' });
        mic?.setEnabled(true);
        micEnabled = true;
      } else if (parsed.command === 'seg') {
        send({ type: 'section', label: parsed.arg });
      } else {
        void endMeeting();
        return;
      }
    } else if (parsed.kind === 'section') {
      if (!parsed.text) {
        toast('環節需要名稱，例如「# 需求確認」', 'error');
        return;
      }
      send({ type: 'section', label: parsed.text });
    } else if (pendingImage) {
      if (ws?.readyState !== WebSocket.OPEN) {
        toast('還沒連上伺服器，截圖先留著，連上後再送', 'error');
        return;
      }
      send({ type: 'note', kind: parsed.kind, text: parsed.text, image: pendingImage });
      setPending(null);
    } else {
      if (!parsed.text) return;
      send({ type: 'note', kind: parsed.kind, text: parsed.text });
    }

    input.value = '';
    updateChip();
    input.focus();
  });

  input.addEventListener('input', updateChip);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      input.value = '';
      updateChip();
    }
  });

  document.addEventListener('keydown', onGlobalKey);
  function onGlobalKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.length === 1) {
      input.focus();
    }
  }

  async function endMeeting(): Promise<void> {
    if (!confirm('結束這場會議？結束後會停止錄音並儲存逐字稿。')) return;
    ending = true;
    btnEnd.disabled = true;
    btnEnd.textContent = '收尾中…';
    teardownMic();
    flushDrafts(); // 還在改的逐字稿先送出，再收尾
    send({ type: 'end' });
    void watchEnded();
  }

  /**
   * WebSocket 的 ended 訊息如果漏掉（連線抖一下就會發生），畫面會一直停在「收尾中」。
   * 這裡同時輪詢 API，伺服器說結束了就自己跳頁。
   */
  async function watchEnded(): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (destroyed || location.hash.startsWith('#/meeting/')) return;
      try {
        const { meeting: latest } = await getMeeting(id);
        if (latest.status === 'ended') {
          location.hash = `#/meeting/${encodeURIComponent(id)}`;
          return;
        }
      } catch {
        // 伺服器正在收尾，下一輪再試
      }
    }
    if (!destroyed) toast('收尾時間比預期久，稍後重新整理就會看到結果', 'error', 8000);
  }

  btnStart.addEventListener('click', () => void startRecording());
  btnPause.addEventListener('click', () => {
    const paused = meeting?.status === 'paused';
    if (paused) {
      send({ type: 'resume' });
      mic?.setEnabled(true);
      micEnabled = true;
      btnPause.textContent = '暫停';
    } else {
      send({ type: 'pause' });
      mic?.setEnabled(false);
      micEnabled = false;
      btnPause.textContent = '繼續';
    }
    input.focus();
  });
  btnCut.addEventListener('click', () => {
    send({ type: 'cut' });
    toast('已切段，逐字稿幾秒後出現');
    input.focus();
  });
  btnEnd.addEventListener('click', () => void endMeeting());
  sourceSelect.addEventListener('change', () => {
    setSource(sourceSelect.value as SourceMode, true);
  });

  setSource(savedSource(), false);
  connect();
  input.focus();

  return {
    node: root,
    destroy() {
      destroyed = true;
      document.removeEventListener('keydown', onGlobalKey);
      document.removeEventListener('paste', onPaste);
      teardownMic();
      flushDrafts();
      ws?.close();
    },
  };
}
