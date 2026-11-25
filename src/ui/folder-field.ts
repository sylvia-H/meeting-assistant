/**
 * 資料夾欄位：文字框＋「瀏覽…」按鈕（叫出系統的選資料夾視窗），
 * 需要時在下方用紅字提示「這個位置可能被同步到雲端」。引導頁與設定頁共用。
 */
import { checkFolder, pickFolder } from './api.ts';
import { escapeHtml, q, toast } from './dom.ts';
import { errorText } from './home.ts';

export function folderFieldHtml(id: string, value: string, label: string): string {
  return `
    <div class="folder-field">
      <input id="${id}" type="text" value="${escapeHtml(value)}" spellcheck="false" autocomplete="off" aria-label="${escapeHtml(label)}" />
      <button class="btn" type="button" data-pick="${id}">瀏覽…</button>
    </div>
    <p class="cloud-risk" id="${id}-risk" role="alert" hidden></p>`;
}

/**
 * 接上欄位的行為。warnCloud 為 true 時（含 API key 的設定資料夾）才顯示紅字。
 * 選到資料夾後會觸發 input 事件，讓設定頁的「未儲存」提示照常運作。
 */
export function wireFolderField(root: HTMLElement, id: string, title: string, warnCloud: boolean): void {
  const input = q<HTMLInputElement>(root, `#${id}`);
  const risk = q<HTMLElement>(root, `#${id}-risk`);
  const button = q<HTMLButtonElement>(root, `[data-pick="${id}"]`);

  const showRisk = (text: string | null): void => {
    if (!warnCloud) return;
    risk.hidden = !text;
    risk.textContent = text ? `${text}這裡會存完整的 API key，建議換到不會同步的位置（例如預設的 AppData 資料夾）。` : '';
  };

  let seq = 0;
  const refresh = async (): Promise<void> => {
    if (!warnCloud) return;
    const mine = ++seq;
    try {
      const res = await checkFolder(input.value.trim());
      if (mine === seq) showRisk(res.risk);
    } catch {
      // 檢查失敗不擋操作，存檔時伺服器會再驗一次
    }
  };

  let timer = 0;
  input.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void refresh(), 250);
  });

  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const res = await pickFolder(input.value.trim(), title);
      if (!res.path) return;
      input.value = res.path;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      showRisk(res.risk);
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      button.disabled = false;
    }
  });

  void refresh();
}
