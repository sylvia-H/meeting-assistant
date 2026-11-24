import type { LlmProvider, SettingsView, TranscriberKind } from '../core/protocol.ts';
import { GEMINI_TRANSCRIBE_MODELS, LLM_MODEL_OPTIONS, TYPELESS_MODELS, type ModelOption } from '../core/protocol.ts';
import { el, escapeHtml, q, setBusy, toast } from './dom.ts';
import { errorText, type View } from './home.ts';
import { pingGemini, pingLlm, saveSettings } from './api.ts';

export function renderSettings(initial: SettingsView, onSaved: (next: SettingsView) => void): View {
  const root = el('div', 'page settings');
  let current = initial;

  /**
   * 模型下拉選單。以前用 <input list> + <datalist>，但瀏覽器只列出「跟目前內容相符」的建議：
   * 欄位已經有值時清單幾乎是空的，看起來就是一般輸入框。
   * 文字框 #id 仍是唯一的值來源（存檔、測試連線都讀它），選單只負責填它；
   * 選「其他」才把文字框露出來自己打。清單外的既有設定會多一個「目前設定」選項，不會被悄悄換掉。
   */
  const CUSTOM = '__custom__';
  function modelPicker(id: string, options: readonly ModelOption[], value: string, label: string): string {
    const known = options.some((o) => o.id === value);
    const items = options.map(
      (o) => `<option value="${escapeHtml(o.id)}" ${o.id === value ? 'selected' : ''}>${escapeHtml(o.label)}</option>`,
    );
    if (value && !known) items.push(`<option value="${escapeHtml(value)}" selected>${escapeHtml(value)}（目前設定）</option>`);
    items.push(`<option value="${CUSTOM}">其他（自行輸入）…</option>`);
    return `
      <select id="${id}-select" data-model-for="${id}" aria-label="${escapeHtml(label)}">${items.join('')}</select>
      <input id="${id}" type="text" class="model-custom" value="${escapeHtml(value)}" placeholder="輸入模型 ID" aria-label="${escapeHtml(label)}（自行輸入）" hidden />`;
  }

  root.addEventListener('change', (event) => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement) || !select.dataset.modelFor) return;
    const input = q<HTMLInputElement>(root, `#${select.dataset.modelFor}`);
    if (select.value === CUSTOM) {
      input.hidden = false;
      input.value = '';
      input.focus();
    } else {
      input.hidden = true;
      input.value = select.value;
    }
  });

  function transcriptionFields(s: SettingsView): string {
    if (s.transcriber === 'gemini') {
      return `
        <label class="field">
          <span>Gemini API key ${s.geminiKeySet ? `<em class="ok">已設定 ${escapeHtml(s.geminiKeyHint)}</em>` : '<em class="warn">尚未設定</em>'}</span>
          <input id="gemini-key" type="password" autocomplete="off" placeholder="${s.geminiKeySet ? '要換再填，留白代表不變' : 'AIza...'}" />
        </label>
        <div class="row">
          <label class="field">
            <span>轉錄模型</span>
            ${modelPicker('gemini-model', GEMINI_TRANSCRIBE_MODELS, s.transcribeModels.gemini, '轉錄模型')}
          </label>
          <div class="field">
            <span>測試 key</span>
            <div class="form-actions">
              <button class="ghost" id="btn-ping-gemini" type="button">測試 Gemini</button>
              <span class="muted small" id="ping-gemini-result"></span>
            </div>
          </div>
        </div>
      `;
    }
    return `
      <label class="field">
        <span>Typeless API key ${s.typelessKeySet ? `<em class="ok">已設定 ${escapeHtml(s.typelessKeyHint)}</em>` : '<em class="warn">尚未設定</em>'}</span>
        <input id="typeless-key" type="password" autocomplete="off" placeholder="${s.typelessKeySet ? '要換再填，留白代表不變' : 'tls_sk_...'}" />
      </label>
      <label class="field">
        <span>轉錄模型</span>
        <select id="typeless-model">
          ${TYPELESS_MODELS.map(
            (m) =>
              `<option value="${m.id}" ${m.id === s.transcribeModels.typeless ? 'selected' : ''}>${m.label}</option>`,
          ).join('')}
        </select>
      </label>
    `;
  }

  function transcribeNote(s: SettingsView): string {
    if (s.transcriber === 'gemini') {
      return `<p class="muted small">Gemini 有免費額度，但每日請求數與每分鐘次數以 Google 官方公告為準。免費層的內容可能被用於改善服務；敏感會議請改用付費 key。Key 申請：<a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Google AI Studio</a>。</p>`;
    }
    return `<p class="muted small">Key 申請：<a href="https://docs.typelessapi.com" target="_blank" rel="noreferrer">docs.typelessapi.com</a>。計價 Lite $0.25／小時、Pro $0.50、Max $2.50。</p>`;
  }

  function paint(): void {
    const s = current;
    const segmentHint =
      s.transcriber === 'gemini'
        ? '自動切段秒數（Gemini 單次音訊上限約 20 MB，建議 120–280）'
        : '自動切段秒數（Typeless 單次上限 300 秒，建議 120–240）';
    root.innerHTML = `
      <h1>設定</h1>
      <p class="muted">Key 只存在這台電腦的 <code>server/.data/settings.json</code>，不會送到瀏覽器以外的地方。</p>

      <section class="card">
        <h2>轉錄（語音 → 逐字稿）</h2>
        <div class="form">
          <label class="field">
            <span>轉錄引擎</span>
            <select id="transcriber">
              <option value="gemini" ${s.transcriber === 'gemini' ? 'selected' : ''}>Gemini（免費額度）</option>
              <option value="typeless" ${s.transcriber === 'typeless' ? 'selected' : ''}>Typeless（付費，中文品質好）</option>
            </select>
          </label>
          ${transcriptionFields(s)}
          <div class="row">
            <label class="field">
              <span>語言提示</span>
              <input id="language" type="text" value="${escapeHtml(s.language)}" placeholder="zh" />
            </label>
            <label class="field">
              <span>${segmentHint}</span>
              <input id="segment" type="number" min="60" max="280" value="${s.autoSegmentSeconds}" />
            </label>
          </div>
          <label class="check">
            <input id="keep-audio" type="checkbox" ${s.keepAudio ? 'checked' : ''} />
            <span>保留原始錄音（<code>audio/mic.wav</code>，1 小時約 110 MB）</span>
          </label>
        </div>
        ${transcribeNote(s)}
      </section>

      <section class="card">
        <h2>摘要用的 LLM</h2>
        <div class="form">
          <div class="row">
            <label class="field">
              <span>供應商</span>
              <select id="provider">
                ${(['anthropic', 'openai', 'gemini'] as LlmProvider[])
                  .map(
                    (p) =>
                      `<option value="${p}" ${p === s.llmProvider ? 'selected' : ''}>${p === 'anthropic' ? 'Anthropic Claude' : p === 'openai' ? 'OpenAI' : 'Google Gemini'}</option>`,
                  )
                  .join('')}
              </select>
            </label>
            <label class="field">
              <span>模型</span>
              ${modelPicker('llm-model', LLM_MODEL_OPTIONS[s.llmProvider], s.llmModel, '摘要模型')}
            </label>
          </div>
          <label class="field">
            <span>API key ${s.llmKeys[s.llmProvider].set ? `<em class="ok">已設定 ${escapeHtml(s.llmKeys[s.llmProvider].hint)}</em>` : '<em class="warn">尚未設定</em>'}</span>
            <input id="llm-key" type="password" autocomplete="off" placeholder="${s.llmKeys[s.llmProvider].set ? '要換再填' : '貼上 API key'}" />
          </label>
          ${
            s.llmProvider === 'gemini'
              ? '<p class="muted small">Gemini key 與轉錄共用：上方 Gemini 欄位填過的話，這裡可以留白。</p>'
              : ''
          }
          <div class="form-actions">
            <button class="ghost" id="btn-ping" type="button">測試連線</button>
            <span class="muted small" id="ping-result"></span>
          </div>
        </div>
      </section>

      <section class="card">
        <h2>資料</h2>
        <div class="form">
          <label class="field">
            <span>會議資料夾（相對專案根目錄）</span>
            <input id="meetings-dir" type="text" value="${escapeHtml(s.meetingsDir)}" />
          </label>
          <p class="muted small">目前位置：<code>${escapeHtml(s.meetingsPath)}</code>。每場會議一個資料夾：<code>meeting.json</code>、<code>transcript.md</code>、<code>notes.md</code>、<code>minutes.md</code>、<code>reference/</code>。</p>
        </div>
      </section>

      <div class="form-actions">
        <button class="primary" id="btn-save" type="button">儲存設定</button>
      </div>
    `;

    q<HTMLSelectElement>(root, '#transcriber').addEventListener('change', (event) => {
      const next = (event.target as HTMLSelectElement).value as TranscriberKind;
      current = {
        ...current,
        transcriber: next,
        transcribeModel: current.transcribeModels[next],
      };
      paint();
    });

    const provider = q<HTMLSelectElement>(root, '#provider');
    provider.addEventListener('change', () => {
      current = {
        ...current,
        llmProvider: provider.value as LlmProvider,
        llmModel: current.llmModels[provider.value as LlmProvider],
      };
      paint();
    });

    q<HTMLButtonElement>(root, '#btn-save').addEventListener('click', () => void save());
    q<HTMLButtonElement>(root, '#btn-ping').addEventListener('click', () => void ping());
    const geminiBtn = root.querySelector<HTMLButtonElement>('#btn-ping-gemini');
    if (geminiBtn) geminiBtn.addEventListener('click', () => void pingGeminiKey());
  }

  async function save(): Promise<void> {
    const btn = q<HTMLButtonElement>(root, '#btn-save');
    setBusy(btn, true, '儲存中…');
    try {
      const provider = q<HTMLSelectElement>(root, '#provider').value as LlmProvider;
      const transcriber = q<HTMLSelectElement>(root, '#transcriber').value as TranscriberKind;
      const payload: Record<string, unknown> = {
        transcriber,
        language: q<HTMLInputElement>(root, '#language').value.trim(),
        autoSegmentSeconds: Number(q<HTMLInputElement>(root, '#segment').value) || 180,
        keepAudio: q<HTMLInputElement>(root, '#keep-audio').checked,
        meetingsDir: q<HTMLInputElement>(root, '#meetings-dir').value.trim(),
        llmProvider: provider,
        llmModel: { provider, value: q<HTMLInputElement>(root, '#llm-model').value.trim() },
      };

      if (transcriber === 'gemini') {
        payload.transcribeModel = q<HTMLInputElement>(root, '#gemini-model').value.trim();
        const geminiKey = q<HTMLInputElement>(root, '#gemini-key').value.trim();
        if (geminiKey) payload.geminiApiKey = geminiKey;
      } else {
        payload.typelessModel = q<HTMLSelectElement>(root, '#typeless-model').value;
        const typelessKey = q<HTMLInputElement>(root, '#typeless-key').value.trim();
        if (typelessKey) payload.typelessApiKey = typelessKey;
      }

      const llmKey = q<HTMLInputElement>(root, '#llm-key').value.trim();
      if (llmKey) payload.llmKey = { provider, value: llmKey };

      const next = await saveSettings(payload);
      current = next;
      onSaved(next);
      toast('已儲存');
      paint();
    } catch (err) {
      toast(errorText(err), 'error');
      setBusy(btn, false);
    }
  }

  async function ping(): Promise<void> {
    const out = q<HTMLElement>(root, '#ping-result');
    const btn = q<HTMLButtonElement>(root, '#btn-ping');
    setBusy(btn, true, '測試中…');
    out.textContent = '';
    try {
      // 用畫面上目前的選擇測試，不必先儲存
      const res = await pingLlm({
        provider: q<HTMLSelectElement>(root, '#provider').value,
        model: q<HTMLInputElement>(root, '#llm-model').value.trim(),
        apiKey: q<HTMLInputElement>(root, '#llm-key').value.trim(),
      });
      out.innerHTML = `<span class="ok">${escapeHtml(res.message)}</span>`;
    } catch (err) {
      out.innerHTML = `<span class="warn">${escapeHtml(errorText(err))}</span>`;
    } finally {
      setBusy(btn, false);
    }
  }

  async function pingGeminiKey(): Promise<void> {
    const out = q<HTMLElement>(root, '#ping-gemini-result');
    const btn = q<HTMLButtonElement>(root, '#btn-ping-gemini');
    setBusy(btn, true, '測試中…');
    out.textContent = '';
    try {
      const res = await pingGemini(
        q<HTMLInputElement>(root, '#gemini-key').value.trim(),
        q<HTMLInputElement>(root, '#gemini-model').value.trim(),
      );
      out.innerHTML = `<span class="ok">${escapeHtml(res.message)}</span>`;
    } catch (err) {
      out.innerHTML = `<span class="warn">${escapeHtml(errorText(err))}</span>`;
    } finally {
      setBusy(btn, false);
    }
  }

  paint();
  return { node: root, destroy() {} };
}
