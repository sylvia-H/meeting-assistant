import type { MeetingSummary, SettingsView } from '../core/protocol.ts';
import { dayGroup, formatShortDay } from '../core/format.ts';
import { getSettings, getSetup, listMeetings } from './api.ts';
import { el, escapeHtml, q, toast } from './dom.ts';
import { renderHome, type View } from './home.ts';
import { icon } from './icons.ts';
import { renderLive } from './live.ts';
import { renderMeeting } from './result.ts';
import { renderSettings } from './settings.ts';
import { renderSetup } from './setup.ts';
import { initTheme, setThemeMode, themeMode, type ThemeMode } from './theme.ts';

/** 錄音中／暫停／未開始的會議點進錄音頁；結束的點進紀錄頁 */
export function meetingHref(m: { id: string; status: string }): string {
  return m.status === 'ended' ? `#/meeting/${encodeURIComponent(m.id)}` : `#/live/${encodeURIComponent(m.id)}`;
}

function statusText(m: MeetingSummary): string {
  if (m.status === 'recording') return '<span class="m-live">錄音中</span>';
  if (m.status === 'paused') return '已暫停';
  if (m.status === 'ready') return '未開始';
  return m.hasMinutes ? '已整理' : '待整理';
}

export async function mountApp(host: HTMLElement): Promise<void> {
  initTheme();
  // 第一次啟動：還沒選資料位置就先顯示引導頁，選完再進主畫面
  try {
    const setup = await getSetup();
    if (!setup.configured) {
      renderSetup(host, setup, () => void mountApp(host));
      return;
    }
  } catch {
    // 連不上伺服器時照常往下，由路由顯示「連不上本機伺服器」
  }
  host.innerHTML = `
    <aside class="sidebar" id="sidebar" aria-label="會議清單">
      <div class="side-head">
        <a class="brand" href="#/">會議助手</a>
        <button class="icon-btn side-close" id="side-close" type="button" title="收起側邊欄">${icon('close', '收起側邊欄')}</button>
      </div>
      <label class="search">
        ${icon('search')}
        <input id="meeting-search" type="search" placeholder="搜尋會議" autocomplete="off" aria-label="搜尋會議" />
      </label>
      <a class="side-row" id="nav-new" href="#/">${icon('plus')}<span>新會議</span></a>
      <nav class="side-list" id="meeting-list" aria-label="會議"><p class="side-empty">載入中…</p></nav>
      <div class="side-foot">
        <a class="side-row" id="nav-settings" href="#/settings">${icon('gear')}<span>設定</span><span class="side-warn" id="settings-warn" hidden>需要設定</span></a>
        <div class="seg-ctl theme-ctl" id="theme-ctl" role="radiogroup" aria-label="外觀">
          <button type="button" role="radio" data-mode="light">淺色</button>
          <button type="button" role="radio" data-mode="dark">深色</button>
          <button type="button" role="radio" data-mode="system">跟隨系統</button>
        </div>
      </div>
    </aside>
    <div class="scrim" id="scrim" hidden></div>
    <div class="workspace">
      <button class="icon-btn side-open" id="side-open" type="button" title="會議清單">${icon('menu', '打開會議清單')}</button>
      <div id="view" class="view"></div>
    </div>
    <div id="toasts" class="toasts" role="status" aria-live="polite"></div>
  `;

  const viewHost = q<HTMLElement>(host, '#view');
  const listHost = q<HTMLElement>(host, '#meeting-list');
  const search = q<HTMLInputElement>(host, '#meeting-search');
  const sidebar = q<HTMLElement>(host, '#sidebar');
  const scrim = q<HTMLElement>(host, '#scrim');
  const themeCtl = q<HTMLElement>(host, '#theme-ctl');
  const settingsWarn = q<HTMLElement>(host, '#settings-warn');

  let current: View | null = null;
  let settings: SettingsView | null = null;
  let meetings: MeetingSummary[] = [];

  // ── 外觀 ────────────────────────────────────────────────
  function paintTheme(): void {
    const mode = themeMode();
    for (const b of themeCtl.querySelectorAll<HTMLButtonElement>('button')) {
      const on = b.dataset.mode === mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
  }
  themeCtl.addEventListener('click', (event) => {
    const mode = (event.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.mode as ThemeMode | undefined;
    if (!mode) return;
    setThemeMode(mode);
    paintTheme();
  });
  paintTheme();

  // ── 窄螢幕：側邊欄改成抽屜 ─────────────────────────────
  function setDrawer(open: boolean): void {
    sidebar.classList.toggle('open', open);
    scrim.hidden = !open;
  }
  q<HTMLButtonElement>(host, '#side-open').addEventListener('click', () => setDrawer(true));
  q<HTMLButtonElement>(host, '#side-close').addEventListener('click', () => setDrawer(false));
  scrim.addEventListener('click', () => setDrawer(false));

  // ── 會議清單 ────────────────────────────────────────────
  function activeId(): string {
    const [name = '', id = ''] = location.hash.replace(/^#\/?/, '').split('/');
    return name === 'live' || name === 'meeting' ? decodeURIComponent(id) : '';
  }

  function paintList(): void {
    const term = search.value.trim().toLowerCase();
    const shown = term ? meetings.filter((m) => m.title.toLowerCase().includes(term)) : meetings;
    if (!shown.length) {
      listHost.innerHTML = `<p class="side-empty">${term ? '找不到符合的會議' : '還沒有會議。按上面的「新會議」開始。'}</p>`;
      return;
    }
    const active = activeId();
    const groups = new Map<string, MeetingSummary[]>();
    for (const m of shown) {
      const g = dayGroup(m.startedAt);
      groups.set(g, [...(groups.get(g) ?? []), m]);
    }
    listHost.innerHTML = ['今天', '這週', '更早']
      .filter((g) => groups.has(g))
      .map(
        (g) => `
        <div class="side-group">${g}</div>
        ${(groups.get(g) ?? [])
          .map(
            (m) => `
          <a class="side-meeting${m.id === active ? ' on' : ''}" href="${meetingHref(m)}" ${m.id === active ? 'aria-current="page"' : ''}>
            <b>${escapeHtml(m.title)}</b>
            <span>${formatShortDay(m.startedAt)}　${statusText(m)}</span>
          </a>`,
          )
          .join('')}`,
      )
      .join('');
  }

  async function loadList(): Promise<void> {
    try {
      const res = await listMeetings();
      meetings = res.meetings;
      paintList();
    } catch {
      listHost.innerHTML = '<p class="side-empty">會議清單載入失敗</p>';
    }
  }

  search.addEventListener('input', paintList);
  window.addEventListener('meetings:changed', () => void loadList());

  // ── 路由 ────────────────────────────────────────────────
  async function loadSettings(force = false): Promise<SettingsView> {
    if (settings && !force) return settings;
    settings = await getSettings();
    settingsWarn.hidden = settings.ready.transcriber && settings.ready.llm;
    return settings;
  }

  function paintNav(name: string): void {
    q<HTMLElement>(host, '#nav-new').classList.toggle('on', name === '');
    q<HTMLElement>(host, '#nav-settings').classList.toggle('on', name === 'settings');
    paintList();
  }

  async function route(): Promise<void> {
    current?.destroy();
    current = null;
    viewHost.innerHTML = '';
    setDrawer(false);

    const raw = location.hash.replace(/^#\/?/, '');
    const [name = '', id = ''] = raw.split('/');
    paintNav(name);

    try {
      let view: View;
      if (name === 'settings') {
        view = renderSettings(await loadSettings(true), (next) => {
          settings = next;
          settingsWarn.hidden = next.ready.transcriber && next.ready.llm;
        });
        document.title = '設定 · 會議助手';
      } else if (name === 'live' && id) {
        view = renderLive(decodeURIComponent(id));
      } else if (name === 'meeting' && id) {
        view = renderMeeting(decodeURIComponent(id));
      } else {
        view = renderHome(await loadSettings(true));
        document.title = '新會議 · 會議助手';
      }
      current = view;
      viewHost.appendChild(view.node);
      if (name !== 'settings' && name !== '') void loadSettings().catch(() => undefined);
    } catch (err) {
      const box = el('div', 'fatal');
      box.innerHTML = `
        <h1>連不上本機伺服器</h1>
        <p>請確認終端機裡的 <code>npm run dev</code> 還在跑，然後重新整理這一頁。</p>
        <pre>${escapeHtml(err instanceof Error ? err.message : String(err))}</pre>`;
      viewHost.appendChild(box);
      toast('載入失敗，請確認伺服器狀態', 'error');
    }
  }

  window.addEventListener('hashchange', () => void route());
  if (!location.hash) location.hash = '#/';
  await loadList();
  await route();
}
