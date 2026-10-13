/**
 * 簡易記憶體 Rate Limiting (防刷防禦機制)
 * 限制單一 IP 每分鐘最多請求 10 次，保護 Gemini 免費額度不被惡意刷爆。
 */

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

const ipRecords = new Map<string, RateLimitRecord>();

const WINDOW_MS = 60 * 1000; // 1 分鐘
const MAX_REQUESTS_PER_WINDOW = 10; // 每分鐘最多 10 次

export function checkRateLimit(ip: string): { allowed: boolean; remaining: number; resetInSeconds: number } {
  const now = Date.now();
  const record = ipRecords.get(ip);

  // 清除久未訪問的過期記錄防止記憶體膨脹 (超過 1000 筆時掃描一次)
  if (ipRecords.size > 1000) {
    for (const [key, val] of ipRecords.entries()) {
      if (val.resetAt < now) {
        ipRecords.delete(key);
      }
    }
  }

  if (!record || record.resetAt < now) {
    ipRecords.set(ip, {
      count: 1,
      resetAt: now + WINDOW_MS,
    });
    return {
      allowed: true,
      remaining: MAX_REQUESTS_PER_WINDOW - 1,
      resetInSeconds: Math.ceil(WINDOW_MS / 1000),
    };
  }

  if (record.count >= MAX_REQUESTS_PER_WINDOW) {
    return {
      allowed: false,
      remaining: 0,
      resetInSeconds: Math.max(1, Math.ceil((record.resetAt - now) / 1000)),
    };
  }

  record.count += 1;
  return {
    allowed: true,
    remaining: MAX_REQUESTS_PER_WINDOW - record.count,
    resetInSeconds: Math.max(1, Math.ceil((record.resetAt - now) / 1000)),
  };
}
