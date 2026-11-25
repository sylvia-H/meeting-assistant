import type { MeetingSummary, SettingsView } from '../core/protocol.ts';
import { formatBytes, formatShortDay, toLocalInputValue } from '../core/format.ts';
import { addReferences, createMeeting, fileToBase64, listMeetings } from './api.ts';
import { el, escapeHtml, meetingsChanged, q, setBusy, toast } from './dom.ts';
import { icon } from './icons.ts';

export interface View {
  node: HTMLElement;
  destroy(): void;
}

/** 錄音頁讀這個：從「建立並開始錄音」進來的那場會議，一連上就自動開始 */
export const AUTOSTART_KEY = 'meeting-assistant.autostart';
export const SOURCE_KEY = 'meeting-assistant.audio-source';

const PROVIDER_LABEL: Record<string, string> = { anthropic: 'Claude', openai: 'OpenAI', gemini: 'Gemini' };

export function renderHome(settings: SettingsView): View {
  const root = el('div', 'page home');
  const pending: File[] = [];

  const missing = [
    settings.ready.transcriber ? '' : `${settings.transcriber === 'gemini' ? 'Gemini' : 'Typeless'} 轉錄 key（沒有它就不會有逐字稿）`,
    settings.ready.llm ? '' : '摘要用的 LLM key（會議照常錄，產生紀錄前要補上）',
  ].filter(Boolean);

  const savedSource = localStorage.getItem(SOURCE_KEY) ?? 'mic';

  root.innerHTML = `
    <div class="toolbar"><span class="crumb"><b>新會議</b></span></div>
    <div class="scroll">
      <form id="create-form" class="sheet form-sheet" novalidate>
        ${
          missing.length
            ? `<div class="notice">${icon('gear')}<span>還沒設定：${missing.map(escapeHtml).join('；')}。</span><a href="#/settings">前往設定</a></div>`
            : ''
        }
        <input id="title" class="title-input" type="text" required maxlength="80" placeholder="會議主題，例如：Q4 產品路線圖週會" aria-label="會議主題" autocomplete="off" />
        <dl class="props">
          <dt><label for="started-at">開始時間</label></dt>
          <dd><input id="started-at" type="datetime-local" class="ghost-input" /></dd>
          <dt><label for="home-source">音訊來源</label></dt>
          <dd>
            <select id="home-source" class="ghost-input">
              <option value="mic" ${savedSource === 'mic' ? 'selected' : ''}>麥克風</option>
              <option value="mic+system" ${savedSource === 'mic+system' ? 'selected' : ''}>麥克風＋會議音訊</option>
              <option value="system" ${savedSource === 'system' ? 'selected' : ''}>只有會議音訊</option>
            </select>
            <span class="hint">線上會議選「麥克風＋會議音訊」</span>
          </dd>
          <dt>轉錄</dt>
          <dd><span class="prop-val">${settings.transcriber === 'gemini' ? 'Gemini' : 'Typeless'} · ${escapeHtml(settings.transcribeModel)}</span><a class="hint" href="#/settings">在設定裡改</a></dd>
          <dt>摘要</dt>
          <dd><span class="prop-val">${escapeHtml(PROVIDER_LABEL[settings.llmProvider] ?? settings.llmProvider)} · ${escapeHtml(settings.llmModel)}</span></dd>
        </dl>

        <label class="field-label" for="agenda">會議目的（選填）</label>
        <textarea id="agenda" rows="3" placeholder="這場要決定什麼……寫了會讓會議紀錄更準"></textarea>

        <label class="field-label" for="attendees">與會者（選填）</label>
        <textarea id="attendees" rows="2" placeholder="王小明（PM）、Amy（廠商 IT）、陳大文（RD）"></textarea>
        <p class="field-hint">一行一位或用頓號分隔，括號裡寫身分。會用來把逐字稿裡的人名寫對，也讓會議紀錄分清楚誰是誰；開會中、會後都能再改。</p>

        <span class="field-label">參考資料（選填）</span>
        <label class="dropzone" id="dropzone">
          <input id="files" type="file" multiple hidden />
          ${icon('upload')}
          <span>把上次紀錄、規格書、提案拖到這裡，或 <b>選擇檔案</b></span>
          <small>只用來校正人名與專有名詞、補背景，不會被轉錄</small>
        </label>
        <div id="file-list" class="file-chips"></div>

        <div class="form-actions">
          <button class="btn primary lg" id="btn-create-start" type="submit">建立並開始錄音</button>
          <button class="btn lg" id="btn-create" type="button">只建立</button>
          <span class="hint">只建立的話，開會時再從左側點進去開始</span>
        </div>

        <section class="todo-list" id="todo-list" hidden>
          <h2>還沒整理的會議</h2>
          <div id="todo-rows"></div>
        </section>
      </form>
    </div>
  `;

  const form = q<HTMLFormElement>(root, '#create-form');
  const fileInput = q<HTMLInputElement>(root, '#files');
  const fileList = q<HTMLDivElement>(root, '#file-list');
  const startedAt = q<HTMLInputElement>(root, '#started-at');
  const dropzone = q<HTMLElement>(root, '#dropzone');
  const titleInput = q<HTMLInputElement>(root, '#title');
  const sourceSelect = q<HTMLSelectElement>(root, '#home-source');

  startedAt.value = toLocalInputValue(new Date());
  queueMicrotask(() => titleInput.focus());

  sourceSelect.addEventListener('change', () => localStorage.setItem(SOURCE_KEY, sourceSelect.value));

  function paintFiles(): void {
    fileList.innerHTML = pending
      .map(
        (f, i) =>
          `<span class="file-chip">${escapeHtml(f.name)}<small>${formatBytes(f.size)}</small><button type="button" data-i="${i}" title="移除" aria-label="移除 ${escapeHtml(f.name)}">${icon('close')}</button></span>`,
      )
      .join('');
  }

  function addFiles(files: FileList | File[]): void {
    for (const file of Array.from(files)) {
      if (!pending.some((p) => p.name === file.name && p.size === file.size)) pending.push(file);
    }
    paintFiles();
  }

  fileInput.addEventListener('change', () => {
    if (fileInput.files) addFiles(fileInput.files);
    fileInput.value = '';
  });
  fileList.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-i]');
    if (!button) return;
    pending.splice(Number(button.dataset.i), 1);
    paintFiles();
  });
  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropzone.classList.add('over');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('over');
    if (event.dataTransfer?.files.length) addFiles(event.dataTransfer.files);
  });

  async function create(autostart: boolean, button: HTMLButtonElement): Promise<void> {
    const title = titleInput.value.trim();
    if (!title) {
      toast('請先給這場會議一個主題', 'error');
      titleInput.focus();
      return;
    }
    setBusy(button, true, '建立中…');
    try {
      const startedIso = startedAt.value ? new Date(startedAt.value).toISOString() : new Date().toISOString();
      const { meeting } = await createMeeting({
        title,
        startedAt: startedIso,
        agenda: q<HTMLTextAreaElement>(root, '#agenda').value,
        attendees: q<HTMLTextAreaElement>(root, '#attendees').value,
      });
      if (pending.length) {
        const files = await Promise.all(
          pending.map(async (file) => ({ name: file.name, base64: await fileToBase64(file) })),
        );
        await addReferences(meeting.id, files);
      }
      if (autostart) sessionStorage.setItem(AUTOSTART_KEY, meeting.id);
      meetingsChanged();
      location.hash = `#/live/${encodeURIComponent(meeting.id)}`;
    } catch (err) {
      toast(errorText(err), 'error');
      setBusy(button, false);
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void create(true, q<HTMLButtonElement>(root, '#btn-create-start'));
  });
  q<HTMLButtonElement>(root, '#btn-create').addEventListener('click', (event) => {
    void create(false, event.currentTarget as HTMLButtonElement);
  });

  void listMeetings()
    .then(({ meetings }) => {
      const todo = meetings.filter((m: MeetingSummary) => m.status === 'ended' && !m.hasMinutes && m.segmentCount + m.noteCount > 0);
      if (!todo.length) return;
      q<HTMLElement>(root, '#todo-rows').innerHTML = todo
        .slice(0, 5)
        .map(
          (m) => `
          <a class="todo-row" href="#/meeting/${encodeURIComponent(m.id)}">
            <span>${escapeHtml(m.title)}</span>
            <small>${formatShortDay(m.startedAt)} · ${m.segmentCount} 段逐字稿 · ${m.noteCount} 則筆記</small>
            <em>產生紀錄</em>
          </a>`,
        )
        .join('');
      q<HTMLElement>(root, '#todo-list').hidden = false;
    })
    .catch(() => undefined);

  return { node: root, destroy() {} };
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
