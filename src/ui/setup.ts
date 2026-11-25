/**
 * 第一次啟動的引導頁：選「會議資料」與「設定（含完整 API key）」各要存在哪裡。
 * 選完才進入主畫面；之後要換位置到設定頁。
 */
import type { SetupView } from '../core/protocol.ts';
import { completeSetup } from './api.ts';
import { el, q, setBusy, toast } from './dom.ts';
import { folderFieldHtml, wireFolderField } from './folder-field.ts';
import { errorText } from './home.ts';

export function renderSetup(host: HTMLElement, setup: SetupView, onDone: () => void): void {
  const root = el('div', 'setup');
  root.innerHTML = `
    <div class="setup-card">
      <h1>選擇資料存放位置</h1>
      <p class="lead">第一次使用，先決定兩種資料要存在這台電腦的哪裡。之後可以在「設定」頁更改。</p>

      <section class="setup-item">
        <label class="setup-label" for="setup-meetings">會議資料</label>
        <p class="setup-hint">錄音、逐字稿、筆記、截圖、會議紀錄（markdown）。每場會議一個資料夾，可以用檔案總管或 Obsidian 打開。</p>
        ${folderFieldHtml('setup-meetings', setup.defaults.meetingsDir, '會議資料夾')}
      </section>

      <section class="setup-item">
        <label class="setup-label" for="setup-settings">設定（含完整 API key）</label>
        <p class="setup-hint">settings.json 與 .env。裡面是完整的 API key，請放在不會被同步到雲端的位置。</p>
        ${folderFieldHtml('setup-settings', setup.defaults.settingsDir, '設定資料夾')}
      </section>

      <div class="setup-actions">
        <button class="btn primary lg" id="setup-save" type="button">開始使用</button>
      </div>
    </div>
    <div id="toasts" class="toasts" role="status" aria-live="polite"></div>`;
  host.replaceChildren(root);

  wireFolderField(root, 'setup-meetings', '選擇會議資料要存放的資料夾', false);
  wireFolderField(root, 'setup-settings', '選擇設定（含 API key）要存放的資料夾', true);

  const save = q<HTMLButtonElement>(root, '#setup-save');
  save.addEventListener('click', async () => {
    setBusy(save, true, '建立資料夾中…');
    try {
      await completeSetup({
        meetingsDir: q<HTMLInputElement>(root, '#setup-meetings').value.trim(),
        settingsDir: q<HTMLInputElement>(root, '#setup-settings').value.trim(),
      });
      onDone();
    } catch (err) {
      toast(errorText(err), 'error');
      setBusy(save, false);
    }
  });
}
