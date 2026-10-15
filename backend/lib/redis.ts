import { Redis } from '@upstash/redis';
import { getAiConfig } from './config';
import {
  getSecondsUntilTaipeiMidnight,
  getSecondsUntilTaipeiMonthEnd,
  getTaipeiDateParts,
} from './timezone';

/**
 * 考試計畫 AI - Redis 用量與預算控制核心引擎 (Upstash Redis)
 *
 * 設計原則：
 * 1. 使用 Upstash Redis REST API，適用於 Vercel 無狀態 Serverless 環境。
 * 2. 採用 Lua 腳本實作原子預扣（Reserve）與結算（Settle），杜絕並行請求造成超額。
 * 3. 實作安全關閉（Fail-Closed）：若正式環境連不上 Redis，拒絕請求，絕不退回不可靠的記憶體計數。
 * 4. 內建測試專用 Mock Adapter，確保自動化單元測試在無網路/無實體金鑰時能 100% 驗證所有情境。
 */

export interface PreFlightCheckParams {
  userId: string;
  tier: 'free' | 'pro';
  reservedCostMicroUSD: number;
  idempotencyKey?: string;
  requestId: string;
}

export type PreFlightResult =
  | {
      status: 'OK';
      usedToday: number;
      remainingToday: number;
      dailyLimit: number;
      currentDailyBudgetMicroUSD: number;
      currentMonthlyBudgetMicroUSD: number;
    }
  | {
      status: 'CACHED';
      cachedResponse: string;
    }
  | {
      status: 'BLOCKED';
      code:
        | 'CONCURRENT_REQUEST'
        | 'RATE_LIMIT_EXCEEDED'
        | 'DAILY_QUOTA_EXCEEDED'
        | 'DAILY_BUDGET_EXCEEDED'
        | 'MONTHLY_BUDGET_EXCEEDED';
      message: string;
    };

export interface PostCallSettleSuccessParams {
  userId: string;
  requestId?: string;
  reservedCostMicroUSD: number;
  actualCostMicroUSD: number;
  idempotencyKey?: string;
  responsePayloadString?: string;
}

export interface PostCallSettleFailureParams {
  userId: string;
  requestId?: string;
  reservedCostMicroUSD: number;
}

// ───── Lua 腳本 1: 呼叫前原子檢查、鎖定與預扣 ─────
const PRE_FLIGHT_LUA = `
local lockKey = KEYS[1]
local rateKey = KEYS[2]
local dailyQuotaKey = KEYS[3]
local dailyBudgetKey = KEYS[4]
local monthlyBudgetKey = KEYS[5]
local idempotencyKey = KEYS[6]

local lockTtl = tonumber(ARGV[1])
local rateLimit = tonumber(ARGV[2])
local dailyLimit = tonumber(ARGV[3])
local dailyBudgetLimit = tonumber(ARGV[4])
local monthlyBudgetLimit = tonumber(ARGV[5])
local reservedCost = tonumber(ARGV[6])
local dayTtl = tonumber(ARGV[7])
local monthTtl = tonumber(ARGV[8])
local requestId = ARGV[9]
local hasIdempotency = ARGV[10]

-- 1. 冪等性檢查 (若有快取則直接回傳)
if hasIdempotency == '1' then
  local cached = redis.call('GET', idempotencyKey)
  if cached then
    return {'CACHED', cached}
  end
end

-- 2. 進行中請求鎖定 (Concurrency Lock: SET NX EX)
local lockAcquired = redis.call('SET', lockKey, requestId, 'NX', 'EX', lockTtl)
if not lockAcquired then
  return {'ERR_CONCURRENT_REQUEST', '同一使用者同時僅能執行一筆進行中的 AI 請求，請稍候完成再試。'}
end

-- 3. 使用者每日配額檢查 (User Daily Quota: 優先於速率限制，避免用戶因已達當日上限卻被誤判為頻率限制)
local currentUserCount = tonumber(redis.call('GET', dailyQuotaKey) or '0')
if currentUserCount >= dailyLimit then
  redis.call('DEL', lockKey)
  return {'ERR_DAILY_QUOTA_EXCEEDED', '您今日的 AI 建議額度已用完，將於明日 00:00 (台北時間) 自動重設。'}
end

-- 4. 每日總預算檢查 (Daily Budget)
local dailyBudget = tonumber(redis.call('GET', dailyBudgetKey) or '0')
if (dailyBudget + reservedCost) > dailyBudgetLimit then
  redis.call('DEL', lockKey)
  return {'ERR_DAILY_BUDGET_EXCEEDED', '本日系統 AI 服務總運算額度已達安全上限，將於明日 00:00 (台北時間) 自動恢復。'}
end

-- 5. 每月總預算檢查 (Monthly Budget)
local monthlyBudget = tonumber(redis.call('GET', monthlyBudgetKey) or '0')
if (monthlyBudget + reservedCost) > monthlyBudgetLimit then
  redis.call('DEL', lockKey)
  return {'ERR_MONTHLY_BUDGET_EXCEEDED', '本月系統 AI 服務總運算額度已達安全預算上限，請聯繫管理員或於下月恢復。'}
end

-- 6. 每分鐘頻率檢查 (Rate Limit)
local currentMinCount = redis.call('INCR', rateKey)
if currentMinCount == 1 then
  redis.call('EXPIRE', rateKey, 60)
end
if currentMinCount > rateLimit then
  redis.call('DEL', lockKey)
  return {'ERR_RATE_LIMIT_EXCEEDED', '請求頻率過於頻繁（每分鐘上限 3 次），請於 1 分鐘後再試。'}
end

-- 7. 全部通過！原子增加使用者每日計數與預留預算
local newUserCount = redis.call('INCR', dailyQuotaKey)
if newUserCount == 1 then
  redis.call('EXPIRE', dailyQuotaKey, dayTtl)
end

local newDailyBudget = redis.call('INCRBY', dailyBudgetKey, reservedCost)
if newDailyBudget == reservedCost then
  redis.call('EXPIRE', dailyBudgetKey, dayTtl)
end

local newMonthlyBudget = redis.call('INCRBY', monthlyBudgetKey, reservedCost)
if newMonthlyBudget == reservedCost then
  redis.call('EXPIRE', monthlyBudgetKey, monthTtl)
end

local remaining = dailyLimit - newUserCount
return {'OK', tostring(newUserCount), tostring(remaining), tostring(newDailyBudget), tostring(newMonthlyBudget)}
`;

// ───── Lua 腳本 2: 呼叫成功結算 ─────
const SETTLE_SUCCESS_LUA = `
local lockKey = KEYS[1]
local dailyBudgetKey = KEYS[2]
local monthlyBudgetKey = KEYS[3]
local idempotencyKey = KEYS[4]

local diffCost = tonumber(ARGV[1])
local idempotencyVal = ARGV[2]
local idempotencyTtl = tonumber(ARGV[3])
local dayTtl = tonumber(ARGV[4])
local monthTtl = tonumber(ARGV[5])
local requestId = ARGV[6]

-- 調整預算差額 (實際成本 - 預扣成本)
if diffCost ~= 0 then
  local newDaily = redis.call('INCRBY', dailyBudgetKey, diffCost)
  local newMonthly = redis.call('INCRBY', monthlyBudgetKey, diffCost)
  if newDaily < 0 then redis.call('SET', dailyBudgetKey, 0) end
  if newMonthly < 0 then redis.call('SET', monthlyBudgetKey, 0) end
end

-- 寫入冪等快取
if idempotencyVal ~= '' then
  redis.call('SET', idempotencyKey, idempotencyVal, 'EX', idempotencyTtl)
end

-- 釋放並行鎖 (僅在鎖的擁有者仍為當前 requestId 時釋放，避免因逾時過期後誤刪他人新取得的鎖)
if requestId and requestId ~= '' then
  local currentLock = redis.call('GET', lockKey)
  if currentLock == requestId then
    redis.call('DEL', lockKey)
  end
else
  redis.call('DEL', lockKey)
end
return 'OK'
`;

// ───── Lua 腳本 3: 呼叫失敗/逾時釋放預扣 ─────
const SETTLE_FAILURE_LUA = `
local lockKey = KEYS[1]
local dailyQuotaKey = KEYS[2]
local dailyBudgetKey = KEYS[3]
local monthlyBudgetKey = KEYS[4]

local reservedCost = tonumber(ARGV[1])
local requestId = ARGV[2]

-- 退回當日呼叫次數
local currentCount = tonumber(redis.call('GET', dailyQuotaKey) or '0')
if currentCount > 0 then
  redis.call('DECR', dailyQuotaKey)
end

-- 退回預扣伺服端預算
local newDaily = redis.call('DECRBY', dailyBudgetKey, reservedCost)
local newMonthly = redis.call('DECRBY', monthlyBudgetKey, reservedCost)
if newDaily < 0 then redis.call('SET', dailyBudgetKey, 0) end
if newMonthly < 0 then redis.call('SET', monthlyBudgetKey, 0) end

-- 釋放並行鎖 (僅在鎖的擁有者仍為當前 requestId 時釋放，避免因逾時過期後誤刪他人新取得的鎖)
if requestId and requestId ~= '' then
  local currentLock = redis.call('GET', lockKey)
  if currentLock == requestId then
    redis.call('DEL', lockKey)
  end
else
  redis.call('DEL', lockKey)
end
return 'OK'
`;

// ───── 記憶體 Mock 轉接器 (測試專用) ─────
class InMemoryRedisMock {
  private store = new Map<string, { value: string; expireAt?: number }>();

  private getCleanKey(k: string): string | null {
    const entry = this.store.get(k);
    if (!entry) return null;
    if (entry.expireAt && entry.expireAt < Date.now()) {
      this.store.delete(k);
      return null;
    }
    return entry.value;
  }

  async eval(script: string, keys: string[], args: (string | number)[]): Promise<any> {
    if (script === PRE_FLIGHT_LUA) {
      const [lockKey, rateKey, dailyQuotaKey, dailyBudgetKey, monthlyBudgetKey, idempotencyKey] = keys;
      const [
        lockTtl,
        rateLimit,
        dailyLimit,
        dailyBudgetLimit,
        monthlyBudgetLimit,
        reservedCost,
        dayTtl,
        monthTtl,
        requestId,
        hasIdempotency,
      ] = args;

      if (String(hasIdempotency) === '1') {
        const cached = this.getCleanKey(idempotencyKey);
        if (cached) return ['CACHED', cached];
      }

      // Concurrency lock
      if (this.getCleanKey(lockKey)) {
        return ['ERR_CONCURRENT_REQUEST', '同一使用者同時僅能執行一筆進行中的 AI 請求，請稍候完成再試。'];
      }
      this.store.set(lockKey, {
        value: String(requestId),
        expireAt: Date.now() + Number(lockTtl) * 1000,
      });

      // User daily quota
      const userCount = parseInt(this.getCleanKey(dailyQuotaKey) || '0', 10);
      if (userCount >= Number(dailyLimit)) {
        this.store.delete(lockKey);
        return ['ERR_DAILY_QUOTA_EXCEEDED', '您今日的 AI 建議額度已用完，將於明日 00:00 (台北時間) 自動重設。'];
      }

      // Daily budget
      const dailyB = parseInt(this.getCleanKey(dailyBudgetKey) || '0', 10);
      if (dailyB + Number(reservedCost) > Number(dailyBudgetLimit)) {
        this.store.delete(lockKey);
        return ['ERR_DAILY_BUDGET_EXCEEDED', '本日系統 AI 服務總運算額度已達安全上限，將於明日 00:00 (台北時間) 自動恢復。'];
      }

      // Monthly budget
      const monthlyB = parseInt(this.getCleanKey(monthlyBudgetKey) || '0', 10);
      if (monthlyB + Number(reservedCost) > Number(monthlyBudgetLimit)) {
        this.store.delete(lockKey);
        return ['ERR_MONTHLY_BUDGET_EXCEEDED', '本月系統 AI 服務總運算額度已達安全預算上限，請聯繫管理員或於下月恢復。'];
      }

      // Rate limit
      const currentMin = parseInt(this.getCleanKey(rateKey) || '0', 10) + 1;
      this.store.set(rateKey, { value: String(currentMin), expireAt: Date.now() + 60000 });
      if (currentMin > Number(rateLimit)) {
        this.store.delete(lockKey);
        return ['ERR_RATE_LIMIT_EXCEEDED', '請求頻率過於頻繁（每分鐘上限 3 次），請於 1 分鐘後再試。'];
      }

      // Reserve
      const newUserCount = userCount + 1;
      this.store.set(dailyQuotaKey, {
        value: String(newUserCount),
        expireAt: Date.now() + Number(dayTtl) * 1000,
      });

      const newDailyB = dailyB + Number(reservedCost);
      this.store.set(dailyBudgetKey, {
        value: String(newDailyB),
        expireAt: Date.now() + Number(dayTtl) * 1000,
      });

      const newMonthlyB = monthlyB + Number(reservedCost);
      this.store.set(monthlyBudgetKey, {
        value: String(newMonthlyB),
        expireAt: Date.now() + Number(monthTtl) * 1000,
      });

      const rem = Number(dailyLimit) - newUserCount;
      return ['OK', String(newUserCount), String(rem), String(newDailyB), String(newMonthlyB)];
    }

    if (script === SETTLE_SUCCESS_LUA) {
      const [lockKey, dailyBudgetKey, monthlyBudgetKey, idempotencyKey] = keys;
      const [diffCost, idempotencyVal, idempotencyTtl, _dayTtl, _monthTtl, requestId] = args;

      if (Number(diffCost) !== 0) {
        const d = parseInt(this.getCleanKey(dailyBudgetKey) || '0', 10) + Number(diffCost);
        const m = parseInt(this.getCleanKey(monthlyBudgetKey) || '0', 10) + Number(diffCost);
        this.store.set(dailyBudgetKey, { value: String(Math.max(0, d)) });
        this.store.set(monthlyBudgetKey, { value: String(Math.max(0, m)) });
      }

      if (String(idempotencyVal) !== '') {
        this.store.set(idempotencyKey, {
          value: String(idempotencyVal),
          expireAt: Date.now() + Number(idempotencyTtl) * 1000,
        });
      }

      if (requestId && String(requestId) !== '') {
        if (this.getCleanKey(lockKey) === String(requestId)) {
          this.store.delete(lockKey);
        }
      } else {
        this.store.delete(lockKey);
      }
      return 'OK';
    }

    if (script === SETTLE_FAILURE_LUA) {
      const [lockKey, dailyQuotaKey, dailyBudgetKey, monthlyBudgetKey] = keys;
      const [reservedCost, requestId] = args;

      const c = parseInt(this.getCleanKey(dailyQuotaKey) || '0', 10);
      if (c > 0) {
        this.store.set(dailyQuotaKey, { value: String(c - 1) });
      }

      const d = parseInt(this.getCleanKey(dailyBudgetKey) || '0', 10) - Number(reservedCost);
      const m = parseInt(this.getCleanKey(monthlyBudgetKey) || '0', 10) - Number(reservedCost);
      this.store.set(dailyBudgetKey, { value: String(Math.max(0, d)) });
      this.store.set(monthlyBudgetKey, { value: String(Math.max(0, m)) });

      if (requestId && String(requestId) !== '') {
        if (this.getCleanKey(lockKey) === String(requestId)) {
          this.store.delete(lockKey);
        }
      } else {
        this.store.delete(lockKey);
      }
      return 'OK';
    }

    return 'OK';
  }

  clear() {
    this.store.clear();
  }
}

export const inMemoryRedisMockInstance = new InMemoryRedisMock();

/**
 * 取得 Redis 客戶端實例
 */
export function getRedisClient(): { eval: (script: string, keys: string[], args: any[]) => Promise<any> } {
  // 若明確標記使用 Mock（單元測試時），直接回傳記憶體 Mock
  if (process.env.MOCK_REDIS === 'true') {
    return inMemoryRedisMockInstance;
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    // 正式環境無配置 Redis 憑證時，拋出明確錯誤以實作 Fail-Closed
    throw new Error('REDIS_NOT_CONFIGURED');
  }

  return new Redis({
    url,
    token,
  });
}

/**
 * 執行呼叫前原子檢查、請求鎖定與預算預扣
 */
export async function preFlightQuotaAndBudgetCheck(params: PreFlightCheckParams): Promise<PreFlightResult> {
  const config = getAiConfig();
  const { dateKey, monthKey, minuteKey } = getTaipeiDateParts();
  const dayTtl = getSecondsUntilTaipeiMidnight() + 3600; // 額外多留 1 小時安全緩衝
  const monthTtl = getSecondsUntilTaipeiMonthEnd() + 86400;

  const client = getRedisClient();

  const lockKey = `exam_ai:lock:${params.userId}`;
  const rateKey = `exam_ai:ratelimit:min:${params.userId}:${minuteKey}`;
  const dailyQuotaKey = `exam_ai:usage:day:${dateKey}:${params.userId}`;
  const dailyBudgetKey = `exam_ai:budget:day:${dateKey}`;
  const monthlyBudgetKey = `exam_ai:budget:month:${monthKey}`;
  const idempotencyKey = params.idempotencyKey ? `exam_ai:idempotency:${params.idempotencyKey}` : 'exam_ai:none';

  const dailyLimit = params.tier === 'pro' ? config.PRO_DAILY_LIMIT : config.FREE_DAILY_LIMIT;
  const dailyBudgetMicroUSD = Math.round(config.DAILY_BUDGET_USD * 1_000_000);
  const monthlyBudgetMicroUSD = Math.round(config.MONTHLY_BUDGET_USD * 1_000_000);

  const keys = [lockKey, rateKey, dailyQuotaKey, dailyBudgetKey, monthlyBudgetKey, idempotencyKey];
  const args = [
    config.CONCURRENCY_LOCK_TTL_SECONDS,
    config.RATE_LIMIT_PER_MINUTE,
    dailyLimit,
    dailyBudgetMicroUSD,
    monthlyBudgetMicroUSD,
    params.reservedCostMicroUSD,
    dayTtl,
    monthTtl,
    params.requestId,
    params.idempotencyKey ? '1' : '0',
  ];

  try {
    const res = (await client.eval(PRE_FLIGHT_LUA, keys, args)) as string[];
    const status = res[0];

    if (status === 'CACHED') {
      return {
        status: 'CACHED',
        cachedResponse: res[1],
      };
    }

    if (status === 'OK') {
      const usedToday = parseInt(res[1], 10);
      const remainingToday = parseInt(res[2], 10);
      const currentDailyBudgetMicroUSD = parseInt(res[3], 10);
      const currentMonthlyBudgetMicroUSD = parseInt(res[4], 10);

      // 預算警戒線檢查
      const warningThreshold = monthlyBudgetMicroUSD * (config.BUDGET_WARNING_PERCENT / 100);
      if (currentMonthlyBudgetMicroUSD >= warningThreshold) {
        console.warn(
          `[預算警戒] 當前月累計支出已達 $${(currentMonthlyBudgetMicroUSD / 1_000_000).toFixed(4)} USD（超過警戒線 ${config.BUDGET_WARNING_PERCENT}%）。`,
        );
      }

      return {
        status: 'OK',
        usedToday,
        remainingToday,
        dailyLimit,
        currentDailyBudgetMicroUSD,
        currentMonthlyBudgetMicroUSD,
      };
    }

    // 處理被阻擋狀態
    let code:
      | 'CONCURRENT_REQUEST'
      | 'RATE_LIMIT_EXCEEDED'
      | 'DAILY_QUOTA_EXCEEDED'
      | 'DAILY_BUDGET_EXCEEDED'
      | 'MONTHLY_BUDGET_EXCEEDED';
    if (status === 'ERR_CONCURRENT_REQUEST') code = 'CONCURRENT_REQUEST';
    else if (status === 'ERR_RATE_LIMIT_EXCEEDED') code = 'RATE_LIMIT_EXCEEDED';
    else if (status === 'ERR_DAILY_BUDGET_EXCEEDED') code = 'DAILY_BUDGET_EXCEEDED';
    else if (status === 'ERR_MONTHLY_BUDGET_EXCEEDED') code = 'MONTHLY_BUDGET_EXCEEDED';
    else code = 'DAILY_QUOTA_EXCEEDED';

    return {
      status: 'BLOCKED',
      code,
      message: res[1] || '請求被伺服端配額或預算規則攔截。',
    };
  } catch (err: any) {
    console.error('[Redis 錯誤] 執行預檢 Lua 失敗：', err?.message || err);
    throw err;
  }
}

/**
 * API 成功時結算實際 Token 成本，寫入冪等快取並釋放並行鎖
 */
export async function postCallSettleSuccess(params: PostCallSettleSuccessParams): Promise<void> {
  const config = getAiConfig();
  const { dateKey, monthKey } = getTaipeiDateParts();
  const dayTtl = getSecondsUntilTaipeiMidnight() + 3600;
  const monthTtl = getSecondsUntilTaipeiMonthEnd() + 86400;

  const client = getRedisClient();

  const lockKey = `exam_ai:lock:${params.userId}`;
  const dailyBudgetKey = `exam_ai:budget:day:${dateKey}`;
  const monthlyBudgetKey = `exam_ai:budget:month:${monthKey}`;
  const idempotencyKey = params.idempotencyKey ? `exam_ai:idempotency:${params.idempotencyKey}` : 'exam_ai:none';

  const diffCost = params.actualCostMicroUSD - params.reservedCostMicroUSD;

  const keys = [lockKey, dailyBudgetKey, monthlyBudgetKey, idempotencyKey];
  const args = [
    diffCost,
    params.responsePayloadString || '',
    config.IDEMPOTENCY_TTL_SECONDS,
    dayTtl,
    monthTtl,
    params.requestId || '',
  ];

  try {
    await client.eval(SETTLE_SUCCESS_LUA, keys, args);
  } catch (err: any) {
    console.error('[Redis 錯誤] 執行成功結算 Lua 失敗：', err?.message || err);
  }
}

/**
 * API 失敗或逾時時退還預扣額度，並釋放並行鎖
 */
export async function postCallSettleFailure(params: PostCallSettleFailureParams): Promise<void> {
  const { dateKey, monthKey } = getTaipeiDateParts();
  const client = getRedisClient();

  const lockKey = `exam_ai:lock:${params.userId}`;
  const dailyQuotaKey = `exam_ai:usage:day:${dateKey}:${params.userId}`;
  const dailyBudgetKey = `exam_ai:budget:day:${dateKey}`;
  const monthlyBudgetKey = `exam_ai:budget:month:${monthKey}`;

  const keys = [lockKey, dailyQuotaKey, dailyBudgetKey, monthlyBudgetKey];
  const args = [params.reservedCostMicroUSD, params.requestId || ''];

  try {
    await client.eval(SETTLE_FAILURE_LUA, keys, args);
  } catch (err: any) {
    console.error('[Redis 錯誤] 執行失敗退款 Lua 失敗：', err?.message || err);
  }
}
