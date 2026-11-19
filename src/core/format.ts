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
