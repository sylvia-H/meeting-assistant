const PAD = (n: number): string => String(n).padStart(2, '0');

/** 0:07 / 12:34 / 1:02:03 */
export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${PAD(m)}:${PAD(sec)}`;
  return `${m}:${PAD(sec)}`;
}

/** 12 分 08 秒 / 45 分鐘 / 1 小時 04 分 */
export function formatDurationZh(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return m > 0 ? `${h} 小時 ${PAD(m)} 分` : `${h} 小時`;
  if (m > 0) return sec > 0 ? `${m} 分 ${PAD(sec)} 秒` : `${m} 分鐘`;
  return `${sec} 秒`;
}

/** ISO → 14:30（本地時區） */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  return `${PAD(d.getHours())}:${PAD(d.getMinutes())}`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '---- -- --';
  return `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())}`;
}

export function formatDateTime(iso: string): string {
  return `${formatDate(iso)} ${formatClock(iso)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** datetime-local input 用的本地格式 2026-11-18T14:30 */
export function toLocalInputValue(d: Date): string {
  return `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())}T${PAD(d.getHours())}:${PAD(d.getMinutes())}`;
}

export function fromLocalInputValue(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

export function estimateCost(billedSeconds: number, model: string, prices: Record<string, number>): number {
  const rate = prices[model] ?? 0;
  return (billedSeconds / 3600) * rate;
}

/** 2026 年 11 月 24 日 14:00（標題上方的日期行） */
export function formatDateLong(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 ${PAD(d.getHours())}:${PAD(d.getMinutes())}`;
}

const WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

/** 側邊欄用：今天的顯示時間，這週內顯示星期幾，更早顯示 11/18 */
export function formatShortDay(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diffDays = Math.floor((startOfToday - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
  if (diffDays <= 0) return formatClock(iso);
  if (diffDays < 7) return WEEKDAYS[d.getDay()] ?? '';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 側邊欄分組：今天／這週／更早（未來的會議算今天） */
export function dayGroup(iso: string, now = new Date()): '今天' | '這週' | '更早' {
  const d = new Date(iso);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (Number.isNaN(d.getTime()) || d.getTime() >= startOfToday) return '今天';
  return startOfToday - d.getTime() < 6 * 86_400_000 ? '這週' : '更早';
}
