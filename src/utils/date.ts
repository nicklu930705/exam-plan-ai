import type { ISODate, Weekday } from '../types/models';

/**
 * 日期工具
 * 全部以「本地日期」計算，不經過 UTC，避免台灣時區（UTC+8）造成日期跳動。
 */

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'] as const;

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function toISODate(d: Date): ISODate {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 把 'YYYY-MM-DD' 轉成當地午夜的 Date */
export function parseISODate(iso: ISODate): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function todayISO(now: Date = new Date()): ISODate {
  return toISODate(now);
}

export function addDays(iso: ISODate, days: number): ISODate {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

/** b - a 的天數差（以日曆日計算） */
export function diffDays(a: ISODate, b: ISODate): number {
  const ms = parseISODate(b).getTime() - parseISODate(a).getTime();
  return Math.round(ms / 86_400_000);
}

export function weekdayOf(iso: ISODate): Weekday {
  return parseISODate(iso).getDay() as Weekday;
}

export function weekdayLabel(day: Weekday): string {
  return WEEKDAY_LABELS[day];
}

/** 例：10月11日 */
export function formatMonthDay(iso: ISODate): string {
  const d = parseISODate(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 例：10月11日 星期日 */
export function formatFullDate(iso: ISODate): string {
  return `${formatMonthDay(iso)} 星期${weekdayLabel(weekdayOf(iso))}`;
}

/** 例：2026年10月11日 */
export function formatYearMonthDay(iso: ISODate): string {
  const d = parseISODate(iso);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 以星期一為一週的開始 */
export function startOfWeek(iso: ISODate): ISODate {
  const day = weekdayOf(iso);
  const offset = day === 0 ? -6 : 1 - day;
  return addDays(iso, offset);
}

/** 例：90 → 1 小時 30 分；45 → 45 分鐘 */
export function formatMinutes(total: number): string {
  if (total <= 0) return '0 分鐘';
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} 分鐘`;
  if (m === 0) return `${h} 小時`;
  return `${h} 小時 ${m} 分`;
}
