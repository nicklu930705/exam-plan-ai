/**
 * 考試計畫 AI - 台北時區 (Asia/Taipei) 日期與時間工具
 *
 * 確保每日 00:00:00 (台北時間) 準確重置額度，避免伺服器所在時區造成計算偏差。
 */

const TIMEZONE = 'Asia/Taipei';

/**
 * 取得指定 Date 或當前的台北時間物件細節
 */
export function getTaipeiDateParts(date: Date = new Date()): {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  second: number; // 0-59
  dateKey: string; // 'YYYY-MM-DD'
  monthKey: string; // 'YYYY-MM'
  minuteKey: string; // 'YYYY-MM-DDTHH:mm'
} {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = dtf.formatToParts(date);
  const partMap: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') {
      partMap[p.type] = p.value;
    }
  }

  const year = parseInt(partMap.year, 10);
  const month = parseInt(partMap.month, 10);
  const day = parseInt(partMap.day, 10);
  // hour12: false 可能輸出 '24'（在某些 Node 實作中），規範為 0-23
  let hour = parseInt(partMap.hour, 10);
  if (hour === 24) hour = 0;
  const minute = parseInt(partMap.minute, 10);
  const second = parseInt(partMap.second, 10);

  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  const hh = String(hour).padStart(2, '0');
  const min = String(minute).padStart(2, '0');

  const dateKey = `${year}-${mm}-${dd}`;
  const monthKey = `${year}-${mm}`;
  const minuteKey = `${dateKey}T${hh}:${min}`;

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    dateKey,
    monthKey,
    minuteKey,
  };
}

/**
 * 計算距離下一個台北時間 00:00:00 (明天凌晨) 的剩餘秒數
 * 用於設定每日 Redis Key 的過期時間 (TTL) 與前端倒數
 */
export function getSecondsUntilTaipeiMidnight(now: Date = new Date()): number {
  const parts = getTaipeiDateParts(now);
  // 當天已過去的秒數
  const passedSeconds = parts.hour * 3600 + parts.minute * 60 + parts.second;
  const totalSecondsInDay = 86400;
  const remaining = totalSecondsInDay - passedSeconds;
  return Math.max(1, remaining);
}

/**
 * 計算距離下個台北月份 1 日 00:00:00 的剩餘秒數
 */
export function getSecondsUntilTaipeiMonthEnd(now: Date = new Date()): number {
  const parts = getTaipeiDateParts(now);
  const daysInMonth = new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate();
  const remainingDays = daysInMonth - parts.day;
  const secondsInRemainingDays = remainingDays * 86400;
  return secondsInRemainingDays + getSecondsUntilTaipeiMidnight(now);
}

/**
 * 取得下個重置時間的 ISO 字串（格式：YYYY-MM-DDT00:00:00+08:00）
 */
export function getNextTaipeiResetIso(now: Date = new Date()): string {
  const parts = getTaipeiDateParts(now);
  // 明天日期
  const tomorrow = new Date(now.getTime() + (getSecondsUntilTaipeiMidnight(now) + 10) * 1000);
  const tomorrowParts = getTaipeiDateParts(tomorrow);
  return `${tomorrowParts.dateKey}T00:00:00+08:00`;
}
