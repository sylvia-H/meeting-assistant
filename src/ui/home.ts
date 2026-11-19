import type { MeetingSummary, SettingsView } from '../core/protocol.ts';
import { formatDateTime, formatDurationZh, toLocalInputValue } from '../core/format.ts';
import { addReferences, createMeeting, fileToBase64, listMeetings } from './api.ts';
import { el, escapeHtml, q, setBusy, toast } from './dom.ts';

export interface View {
  node: HTMLElement;
  destroy(): void;
}

export function renderHome(settings: SettingsView): View {
  const root = el('div', 'page home');

  const pending: File[] = [];

  root.innerHTML = `
    <section class="card">
      <h1>開始一場會議</h1>
      <p class="muted">填好標題與時間，需要的話把參考資料一起丟進來。開始錄音後就能一邊打筆記。</p>
      ${
        settings.ready.transcriber
          ? ''
          : settings.transcriber === 'gemini'
            ? '<div class="notice">還沒設定 Gemini API key，錄音不會有逐字稿。<a href="#/settings">去設定</a></div>'
            : '<div class="notice">還沒設定 Typeless API key，錄音不會有逐字稿。<a href="#/settings">去設定</a></div>'
      }
      <form id="create-form" class="form">
        <label class="field">
          <span>會議標題</span>
          <input id="title" type="text" required maxlength="80" placeholder="例如：Q4 產品路線圖討論" />
        </label>
        <div class="row">
          <label class="field">
            <span>開始時間</span>
            <input id="started-at" type="datetime-local" />
          </label>
          <label class="field">
            <span>轉錄模型（${settings.transcriber === 'gemini' ? '免費額度' : '付費'}）</span>
            <input id="model" type="text" value="${escapeHtml(settings.transcribeModel)}" readonly />
          </label>
        </div>
        <label class="field">
          <span>會議目的（選填，會一起給摘要模型）</span>
          <textarea id="agenda" rows="3" placeholder="這次要決定什麼？先寫下來，摘要會更準。"></textarea>
        </label>
        <label class="field">
          <span>參考資料（選填，文件、規格、上一次的會議紀錄都可以）</span>
          <input id="files" type="file" multiple />
        </label>
        <div id="file-list" class="file-list"></div>
        <div class="form-actions">
          <button class="primary" type="submit">建立會議</button>
          <span class="muted" id="hint">建立後會開啟錄音頁；資料夾在 ${escapeHtml(settings.meetingsPath)}</span>
        </div>
      </form>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>最近的會議</h2>
        <button class="ghost" id="refresh" type="button">重新整理</button>
      </div>
      <div id="meeting-list" class="meeting-list"><p class="muted">載入中…</p></div>
    </section>
  `;

  const form = q<HTMLFormElement>(root, '#create-form');
  const fileInput = q<HTMLInputElement>(root, '#files');
  const fileList = q<HTMLDivElement>(root, '#file-list');
  const startedAt = q<HTMLInputElement>(root, '#started-at');
  const listHost = q<HTMLDivElement>(root, '#meeting-list');

  startedAt.value = toLocalInputValue(new Date());

  fileInput.addEventListener('change', () => {
    pending.length = 0;
    if (fileInput.files) pending.push(...Array.from(fileInput.files));
    fileList.innerHTML = pending.map((f) => `<span class="chip">${escapeHtml(f.name)}</span>`).join('');
  });

  async function loadList(): Promise<void> {
    listHost.innerHTML = '<p class="muted">載入中…</p>';
    try {
      const { meetings } = await listMeetings();
      listHost.innerHTML = meetings.length
        ? meetings.map(renderRow).join('')
        : '<p class="muted">還沒有任何會議。上面填一填就開始吧。</p>';
    } catch (err) {
      listHost.innerHTML = `<p class="muted">載入失敗：${escapeHtml(errorText(err))}</p>`;
    }
  }

  q<HTMLButtonElement>(root, '#refresh').addEventListener('click', () => void loadList());
  void loadList();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = q<HTMLButtonElement>(form, 'button[type="submit"]');
    const title = q<HTMLInputElement>(root, '#title').value.trim();
    if (!title) {
      toast('請先給這場會議一個標題', 'error');
      return;
    }
    setBusy(button, true, '建立中…');
    try {
      const startedIso = startedAt.value ? new Date(startedAt.value).toISOString() : new Date().toISOString();
      const { meeting } = await createMeeting({
        title,
        startedAt: startedIso,
        agenda: q<HTMLTextAreaElement>(root, '#agenda').value,
      });

      if (pending.length) {
        const files = await Promise.all(
          pending.map(async (file) => ({ name: file.name, base64: await fileToBase64(file) })),
        );
        await addReferences(meeting.id, files);
      }

      location.hash = `#/live/${meeting.id}`;
    } catch (err) {
      toast(errorText(err), 'error');
      setBusy(button, false);
    }
  });

  return { node: root, destroy() {} };
}

function renderRow(meeting: MeetingSummary): string {
  const badge = meeting.status === 'ended' ? (meeting.hasMinutes ? '已整理' : '待整理') : '進行中';
  return `
    <a class="meeting-row" href="#/meeting/${encodeURIComponent(meeting.id)}">
      <div class="meeting-main">
        <strong>${escapeHtml(meeting.title)}</strong>
        <span class="muted">${formatDateTime(meeting.startedAt)} · ${formatDurationZh(meeting.durationSec)} · ${meeting.noteCount} 則筆記</span>
      </div>
      <span class="badge ${meeting.hasMinutes ? 'badge-done' : ''}">${badge}</span>
    </a>
  `;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
