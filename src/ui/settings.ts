import type { LlmProvider, SettingsView, TranscriberKind } from '../core/protocol.ts';
import { GEMINI_TRANSCRIBE_MODELS, LLM_MODEL_OPTIONS, TYPELESS_MODELS, type ModelOption } from '../core/protocol.ts';
import { el, escapeHtml, q, setBusy, toast } from './dom.ts';
import { errorText, type View } from './home.ts';
import { moveSettingsDir, pingGemini, pingLlm, saveSettings } from './api.ts';
import { folderFieldHtml, wireFolderField } from './folder-field.ts';

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

  function markDirty(event: Event): void {
    const target = event.target as HTMLElement;
    // 設定資料夾是按「搬到這裡」立即生效，不算進「儲存設定」的未儲存變更
    if (!target.closest('.group') || target.closest('.settings-dir-group')) return;
    const name = target.closest('.r')?.querySelector('.r-label')?.textContent?.trim();
    if (name) dirty.add(name);
    paintSaveBar();
  }
  root.addEventListener('input', markDirty);
  root.addEventListener('change', markDirty);

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

  function keyState(set: boolean, hint: string, source?: string): string {
    return set
      ? `<span class="key-state ok">已設定 <b>${escapeHtml(hint)}</b>${source ? `<small>${escapeHtml(source)}</small>` : ''}</span>`
      : '<span class="key-state missing">尚未設定</span>';
  }

  function row(label: string, control: string, hint = '', forId = ''): string {
    const name = forId ? `<label class="r-label" for="${forId}">${label}</label>` : `<span class="r-label">${label}</span>`;
    return `<div class="r"><div class="r-name">${name}${hint ? `<small>${hint}</small>` : ''}</div><div class="r-ctl">${control}</div></div>`;
  }

  function transcriptionRows(s: SettingsView): string {
    if (s.transcriber === 'gemini') {
      return [
        row(
          'Gemini API key',
          `${keyState(s.geminiKeySet, s.geminiKeyHint)}<input id="gemini-key" type="password" autocomplete="off" placeholder="${s.geminiKeySet ? '要換再貼，留白代表不變' : '貼上 AIza… 開頭的 key'}" />`,
          '到 <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Google AI Studio</a> 申請；免費層內容可能被用於改善服務',
          'gemini-key',
        ),
        row('轉錄模型', modelPicker('gemini-model', GEMINI_TRANSCRIBE_MODELS, s.transcribeModels.gemini, '轉錄模型')),
        row(
          '測試連線',
          `<span class="ping-out" id="ping-gemini-result" aria-live="polite"></span><button class="btn" id="btn-ping-gemini" type="button">測試 Gemini</button>`,
          '用畫面上的 key 與模型，不必先儲存',
        ),
      ].join('');
    }
    return [
      row(
        'Typeless API key',
        `${keyState(s.typelessKeySet, s.typelessKeyHint)}<input id="typeless-key" type="password" autocomplete="off" placeholder="${s.typelessKeySet ? '要換再貼，留白代表不變' : '貼上 tls_sk_… 開頭的 key'}" />`,
        '到 <a href="https://docs.typelessapi.com" target="_blank" rel="noreferrer">docs.typelessapi.com</a> 申請；Lite $0.25／小時、Pro $0.50、Max $2.50',
        'typeless-key',
      ),
      row(
        '轉錄模型',
        `<select id="typeless-model">${TYPELESS_MODELS.map(
          (m) => `<option value="${m.id}" ${m.id === s.transcribeModels.typeless ? 'selected' : ''}>${m.label}</option>`,
        ).join('')}</select>`,
        '',
        'typeless-model',
      ),
    ].join('');
  }

  let dirty = new Set<string>();
  let saved = initial;

  function paintSaveBar(): void {
    const bar = root.querySelector<HTMLElement>('#save-bar');
    if (!bar) return;
    const note = q<HTMLElement>(bar, '#dirty-note');
    bar.classList.toggle('dirty', dirty.size > 0);
    note.textContent = dirty.size ? `有未儲存的變更：${[...dirty].join('、')}` : '設定都已儲存';
    q<HTMLButtonElement>(bar, '#btn-revert').disabled = dirty.size === 0;
  }

  function paint(): void {
    const s = current;
    const segmentHint =
      s.transcriber === 'gemini' ? 'Gemini 一段上限約 280 秒，建議 120–280' : 'Typeless 一段上限 300 秒，建議 120–240';
    root.innerHTML = `
      <div class="toolbar"><span class="crumb"><b>設定</b></span></div>
      <div class="scroll">
        <div class="sheet settings-sheet">
          <h1>設定</h1>
          <p class="lead">API key 只存在這台電腦的設定資料夾（<code>${escapeHtml(s.settingsPath)}</code>），不會送到瀏覽器。</p>
          ${s.portNote ? `<p class="port-note">${escapeHtml(s.portNote)}</p>` : ''}

          <h2 class="group-title">轉錄（語音 → 逐字稿）</h2>
          <div class="group">
            ${row(
              '轉錄引擎',
              `<select id="transcriber">
                <option value="gemini" ${s.transcriber === 'gemini' ? 'selected' : ''}>Gemini（免費額度）</option>
                <option value="typeless" ${s.transcriber === 'typeless' ? 'selected' : ''}>Typeless（付費，中文品質好）</option>
              </select>`,
              '',
              'transcriber',
            )}
            ${transcriptionRows(s)}
          </div>

          <h2 class="group-title">錄音</h2>
          <div class="group">
            ${row('自動切段', `<input id="segment" class="num" type="number" min="60" max="280" value="${s.autoSegmentSeconds}" /><span class="unit">秒</span>`, segmentHint, 'segment')}
            ${row('語言提示', `<input id="language" class="num" type="text" value="${escapeHtml(s.language)}" placeholder="zh" />`, '例如 zh、en；給轉錄模型參考', 'language')}
            ${row('保留原始錄音', `<input id="keep-audio" class="switch" type="checkbox" role="switch" ${s.keepAudio ? 'checked' : ''} />`, '<code>audio/mic.wav</code>，1 小時約 110 MB', 'keep-audio')}
          </div>

          <h2 class="group-title">摘要用的 LLM</h2>
          <div class="group">
            ${row(
              '供應商',
              `<select id="provider">
                ${(['anthropic', 'openai', 'gemini'] as LlmProvider[])
                  .map(
                    (p) =>
                      `<option value="${p}" ${p === s.llmProvider ? 'selected' : ''}>${p === 'anthropic' ? 'Anthropic Claude' : p === 'openai' ? 'OpenAI' : 'Google Gemini'}</option>`,
                  )
                  .join('')}
              </select>`,
              '',
              'provider',
            )}
            ${row('模型', modelPicker('llm-model', LLM_MODEL_OPTIONS[s.llmProvider], s.llmModel, '摘要模型'))}
            ${row(
              'API key',
              `${keyState(s.llmKeys[s.llmProvider].set, s.llmKeys[s.llmProvider].hint)}<input id="llm-key" type="password" autocomplete="off" placeholder="${s.llmKeys[s.llmProvider].set ? '要換再貼，留白代表不變' : '貼上 API key'}" />`,
              s.llmProvider === 'gemini' ? '與轉錄共用：上面填過 Gemini key 的話可以留白' : '',
              'llm-key',
            )}
            ${row(
              '測試連線',
              `<span class="ping-out" id="ping-result" aria-live="polite"></span><button class="btn" id="btn-ping" type="button">測試連線</button>`,
              '用畫面上的選擇，不必先儲存',
            )}
          </div>

          <h2 class="group-title">資料</h2>
          <div class="group">
            ${row(
              '會議資料夾',
              folderFieldHtml('meetings-dir', s.meetingsPath, '會議資料夾'),
              '每場會議一個資料夾（meeting.json、transcript.md、notes.md、minutes.md、images/、reference/）。換位置後舊會議不會跟著搬',
              'meetings-dir',
            )}
          </div>
          <div class="group settings-dir-group">
            ${row(
              '設定資料夾',
              `${folderFieldHtml('settings-dir', s.settingsPath, '設定資料夾')}<button class="btn" id="btn-move-settings" type="button">搬到這裡</button>`,
              '存 settings.json 與 .env（含完整 API key）。按「搬到這裡」會把這兩個檔搬過去，不用重填 key；不需要按「儲存設定」',
              'settings-dir',
            )}
          </div>
        </div>
      </div>
      <div class="save-bar" id="save-bar">
        <span class="dirty-note" id="dirty-note" aria-live="polite"></span>
        <button class="btn" id="btn-revert" type="button">還原</button>
        <button class="btn primary" id="btn-save" type="button">儲存設定</button>
      </div>
    `;
    paintSaveBar();

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

    wireFolderField(root, 'meetings-dir', '選擇會議資料要存放的資料夾', false);
    wireFolderField(root, 'settings-dir', '選擇設定（含 API key）要存放的資料夾', true);
    q<HTMLButtonElement>(root, '#btn-move-settings').addEventListener('click', () => void moveSettings());

    q<HTMLButtonElement>(root, '#btn-save').addEventListener('click', () => void save());
    q<HTMLButtonElement>(root, '#btn-revert').addEventListener('click', () => {
      current = saved;
      dirty = new Set();
      paint();
    });
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

      const before = saved.meetingsPath;
      const next = await saveSettings(payload);
      if (next.meetingsPath !== before) {
        toast(`會議資料夾已換到 ${next.meetingsPath}。舊會議沒有搬，還在 ${before}；要沿用就用檔案總管把會議資料夾拖過去。`, 'info', 12000);
        window.dispatchEvent(new Event('meetings:changed'));
      }
      current = next;
      saved = next;
      dirty = new Set();
      onSaved(next);
      toast('已儲存');
      paint();
    } catch (err) {
      toast(errorText(err), 'error');
      setBusy(btn, false);
    }
  }

  async function moveSettings(): Promise<void> {
    const btn = q<HTMLButtonElement>(root, '#btn-move-settings');
    const target = q<HTMLInputElement>(root, '#settings-dir').value.trim();
    if (!target || target === saved.settingsPath) {
      toast('設定資料夾沒有變更');
      return;
    }
    setBusy(btn, true, '搬移中…');
    try {
      const res = await moveSettingsDir(target);
      // 只更新路徑相關欄位，畫面上其他還沒儲存的修改保留
      saved = { ...saved, settingsPath: res.settings.settingsPath, settingsCloudRisk: res.settings.settingsCloudRisk };
      current = { ...current, settingsPath: res.settings.settingsPath, settingsCloudRisk: res.settings.settingsCloudRisk };
      onSaved(res.settings);
      toast(res.moved.length ? `已把 ${res.moved.join('、')} 搬到 ${res.settings.settingsPath}` : `設定資料夾已換到 ${res.settings.settingsPath}`);
      // 不重畫整頁（會清掉還沒儲存的 key），只改路徑文字
      q<HTMLInputElement>(root, '#settings-dir').value = res.settings.settingsPath;
      const leadPath = root.querySelector<HTMLElement>('.lead code');
      if (leadPath) leadPath.textContent = res.settings.settingsPath;
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
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
