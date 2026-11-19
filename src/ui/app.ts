import type { SettingsView } from '../core/protocol.ts';
import { getSettings } from './api.ts';
import { escapeHtml, toast } from './dom.ts';
import { renderHome, type View } from './home.ts';
import { renderLive } from './live.ts';
import { renderMeeting } from './result.ts';
import { renderSettings } from './settings.ts';

export async function mountApp(host: HTMLElement): Promise<void> {
  host.innerHTML = `
    <header class="topbar">
      <a class="brand" href="#/">會議助手</a>
      <nav>
        <a href="#/">會議</a>
        <a href="#/settings">設定</a>
      </nav>
      <span class="topbar-status" id="top-status"></span>
    </header>
    <main id="view"></main>
    <div id="toasts" class="toasts"></div>
  `;

  const viewHostEl = host.querySelector<HTMLElement>('#view');
  const statusHostEl = host.querySelector<HTMLElement>('#top-status');
  if (!viewHostEl || !statusHostEl) throw new Error('app shell 建立失敗');
  const viewHost: HTMLElement = viewHostEl;
  const statusHost: HTMLElement = statusHostEl;

  let current: View | null = null;
  let settings: SettingsView | null = null;

  async function loadSettings(force = false): Promise<SettingsView> {
    if (settings && !force) return settings;
    settings = await getSettings();
    return settings;
  }

  function paintStatus(): void {
    if (!settings) {
      statusHost.textContent = '';
      return;
    }
    if (!settings.ready.transcriber) {
      const label = settings.transcriber === 'gemini' ? 'Gemini' : 'Typeless';
      statusHost.innerHTML = `<span class="warn">${label} 未設定</span>`;
    } else if (!settings.ready.llm) {
      statusHost.innerHTML = '<span class="warn">LLM 未設定</span>';
    } else {
      statusHost.innerHTML = '<span class="ok">就緒</span>';
    }
  }

  async function route(): Promise<void> {
    current?.destroy();
    current = null;
    viewHost.innerHTML = '';

    const raw = location.hash.replace(/^#\/?/, '');
    const [name = '', id = ''] = raw.split('/');

    try {
      if (name === 'settings') {
        const view = renderSettings(await loadSettings(true), (next) => {
          settings = next;
          paintStatus();
        });
        current = view;
        viewHost.appendChild(view.node);
        document.title = '設定 · 會議助手';
        paintStatus();
        return;
      }

      if (name === 'live' && id) {
        const view = renderLive(id);
        current = view;
        viewHost.appendChild(view.node);
        await loadSettings().then(paintStatus).catch(() => undefined);
        return;
      }

      if (name === 'meeting' && id) {
        const view = renderMeeting(id);
        current = view;
        viewHost.appendChild(view.node);
        await loadSettings().then(paintStatus).catch(() => undefined);
        return;
      }

      const view = renderHome(await loadSettings(true));
      current = view;
      viewHost.appendChild(view.node);
      document.title = '會議助手';
      paintStatus();
    } catch (err) {
      viewHost.innerHTML = `
        <div class="page">
          <section class="card">
            <h1>連不上本機伺服器</h1>
            <p class="muted">請確認 <code>npm run dev</code> 還在跑。</p>
            <pre class="error-detail">${escapeHtml(err instanceof Error ? err.message : String(err))}</pre>
          </section>
        </div>`;
      toast('載入失敗，請確認伺服器狀態', 'error');
    }
  }

  window.addEventListener('hashchange', () => void route());
  if (!location.hash) location.hash = '#/';
  await route();
}
