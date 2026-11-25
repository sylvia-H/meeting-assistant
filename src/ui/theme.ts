/**
 * 深淺色模式：淺色／深色／跟隨系統，記在 localStorage。
 * 第一次繪製前由 index.html 的行內腳本先套上，避免深色使用者看到一閃白底；
 * 這裡負責之後的切換與「跟隨系統」時跟著作業系統變。
 */
export type ThemeMode = 'light' | 'dark' | 'system';

const KEY = 'meeting-assistant.theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

export function themeMode(): ThemeMode {
  const raw = localStorage.getItem(KEY);
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

function apply(mode: ThemeMode): void {
  const dark = mode === 'dark' || (mode === 'system' && media.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

export function setThemeMode(mode: ThemeMode): void {
  if (mode === 'system') localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, mode);
  apply(mode);
}

export function initTheme(): void {
  apply(themeMode());
  media.addEventListener('change', () => {
    if (themeMode() === 'system') apply('system');
  });
}
