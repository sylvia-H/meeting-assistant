import type { ClientMessage, LiveState, Meeting, MeetingNote, Segment } from '../core/protocol.ts';
import { TYPELESS_PRICE_PER_HOUR } from '../core/protocol.ts';
import { estimateCost, formatClock, formatDuration } from '../core/format.ts';
import { NOTE_KINDS, kindMeta, parseInput } from '../core/notes.ts';
import { startMic, type MicHandle } from './audio.ts';
import { getMeeting } from './api.ts';
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
        <div class="meter"><div id="meter-bar"></div></div>
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
      <input id="note-input" type="text" autocomplete="off" placeholder="直接打，或先用前綴：# 環節　! 待辦　? 待確認　> 決議　* 想法" />
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

  // ── 連線 ────────────────────────────────────────────────
  function connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws/live/${encodeURIComponent(id)}`);

    ws.addEventListener('open', () => {
      banner.hidden = true;
      setStatus('已連線');
    });

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as
        | { type: 'hello'; meeting: Meeting; state: LiveState }
        | { type: 'state'; state: LiveState }
        | { type: 'meeting'; meeting: Meeting }
        | { type: 'segment'; segment: Segment }
        | { type: 'note'; note: MeetingNote }
        | { type: 'ended'; meeting: Meeting }
        | { type: 'error'; message: string };

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
              ? 'Gemini 會在「切段」時送出音訊轉成文字；打 # 環節名稱 或按「切段」就會產出這一段。'
              : 'Typeless 只在「切段」時回傳文字；打 # 環節名稱 或按「切段」就會產出這一段。';
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
              ? 'Gemini 會在「切段」時送出音訊轉成文字；打 # 環節名稱 或按「切段」就會產出這一段。'
              : 'Typeless 只在「切段」時回傳文字；打 # 環節名稱 或按「切段」就會產出這一段。';
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

  // ── 麥克風 ──────────────────────────────────────────────
  async function armMic(): Promise<void> {
    if (mic) {
      mic.setEnabled(true);
      micEnabled = true;
      return;
    }
    mic = await startMic((frame) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(frame);
    });
    micEnabled = true;
    loopLevel();
  }

  function loopLevel(): void {
    cancelAnimationFrame(raf);
    const tick = (): void => {
      if (!mic || destroyed) return;
      const level = micEnabled ? mic.level() : 0;
      meterBar.style.width = `${Math.round(level * 100)}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  function teardownMic(): void {
    micEnabled = false;
    cancelAnimationFrame(raf);
    meterBar.style.width = '0%';
    mic?.stop();
    mic = null;
  }

  async function startRecording(): Promise<void> {
    try {
      await armMic();
    } catch (err) {
      toast(`拿不到麥克風：${errorText(err)}`, 'error', 6000);
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

  function renderSegments(): void {
    if (!meeting && !segments.length) return;
    const visible = segments.slice().sort((a, b) => a.index - b.index);
    if (!visible.length) {
      segmentsHost.innerHTML = `<p class="muted">還沒開始。按右上角「開始錄音」，第一段會在切段後出現。</p>`;
      return;
    }
    const html = visible
      .map((seg) => {
        const hasText = seg.transcript.trim().length > 0;
        if (!hasText && seg.status === 'done') return '';
        const label = seg.label?.trim() || '未標記環節';
        const duration = seg.durationSeconds ? ` · ${formatDuration(seg.durationSeconds)}` : '';
        const body = hasText
          ? `<p>${escapeHtml(seg.transcript).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br />')}</p>`
          : '';
        const placeholder =
          seg.status === 'open'
            ? `<p class="muted recording">收音中…（切段後才會出現逐字稿）</p>`
            : seg.status === 'finalizing'
              ? `<p class="muted">轉錄中…</p>`
              : seg.status === 'failed'
                ? `<p class="warn">這一段失敗：${escapeHtml(seg.error ?? '未知原因')}</p>`
                : '';
        return `
          <article class="seg">
            <header>
              <span class="seg-index">${String(seg.index + 1).padStart(2, '0')}</span>
              <strong>${escapeHtml(label)}</strong>
              <span class="muted small">${formatClock(seg.startedAt)}${duration}</span>
            </header>
            ${placeholder}${body}
          </article>`;
      })
      .join('');
    segmentsHost.innerHTML = html || `<p class="muted">錄音中，等第一個切段。</p>`;

    if (isNearBottom(segmentsHost)) segmentsHost.scrollTop = segmentsHost.scrollHeight;
  }

  function renderNotes(): void {
    if (!notes.length) {
      notesHost.innerHTML = `<p class="muted">用下面的輸入框打第一則。</p>`;
      return;
    }
    notesHost.innerHTML = notes
      .map((note) => {
        const meta = kindMeta(note.kind);
        return `
          <div class="note" style="--kind:${meta.color}">
            <span class="note-time">${formatDuration(note.elapsedSec)}</span>
            <span class="note-kind">${meta.label}</span>
            <span class="note-text">${escapeHtml(note.text)}</span>
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

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    const raw = input.value;
    if (!raw.trim()) return;
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
    send({ type: 'end' });
    void watchEnded();
  }

  /**
   * WebSocket 的 ended 訊息如果漏掉（連線抖一下就會發生），畫面會一直停在「收尾中」。
   * 這裡同時輪詢 API，伺服器說結束了就自己跳頁。
   */
  async function watchEnded(): Promise<void> {
    for (let i = 0; i < 150; i += 1) {
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

  connect();
  input.focus();

  return {
    node: root,
    destroy() {
      destroyed = true;
      document.removeEventListener('keydown', onGlobalKey);
      teardownMic();
      ws?.close();
    },
  };
}
