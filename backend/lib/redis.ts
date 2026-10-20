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

// ───── Lua 腳本 4: Apple 訂閱與交易權限主記錄原子樂觀並行更新 (OCC) ─────
export const SAVE_ENTITLEMENT_OCC_LUA = `
local mainKey = KEYS[1]
local recordStr = ARGV[1]
local incomingTimestamp = tonumber(ARGV[2] or 0)
local ttlSeconds = tonumber(ARGV[3] or 0)

local existing = redis.call('GET', mainKey)
if existing then
  local okExisting, existingData = pcall(cjson.decode, existing)
  local okIncoming, incomingData = pcall(cjson.decode, recordStr)

  if okExisting and existingData and okIncoming and incomingData then
    -- 0. 終身方案保護 (Lifetime Protection):
    -- 若既有記錄為 Lifetime active，且傳入記錄並非同商品退款，不可被一般訂閱或過期通知降級
    if existingData.tier == 'lifetime' and existingData.status == 'active' and incomingData.status ~= 'revoked' then
      if incomingData.tier ~= 'lifetime' then
        return {'LIFETIME_PROTECTED', '既有終身方案不可被一般訂閱或過期通知降級'}
      end
    end

    -- 1. 退款撤銷鎖定防護 (Revocation Lock)：
    -- 若既有記錄已被撤銷/退款，新寫入者若非更晚購買的全新合法交易，嚴禁逆向覆蓋為 active
    if existingData.status == 'revoked' and incomingData.status ~= 'revoked' then
      local existingRevocation = tonumber(existingData.revocationDate or existingData.lastAppleSignedDate or 0)
      local incomingPurchase = tonumber(incomingData.purchaseDate or 0)
      local isNewPurchaseAfterRevoke = (incomingPurchase > existingRevocation) and (not incomingData.revocationDate)
      if not isNewPurchaseAfterRevoke then
        return {'REVOKED_LOCK', tostring(existingRevocation)}
      end
    end

    -- 2. 交易生命週期時間戳記 (Apple Transaction Signed Date / Purchase Date)
    local existingTxTime = tonumber(existingData.lastAppleSignedDate or existingData.purchaseDate or 0)
    local incomingTxTime = tonumber(incomingData.lastAppleSignedDate or incomingTimestamp or incomingData.purchaseDate or 0)

    -- 3. 續約偏好時間戳記 (Apple Renewal Signed Date)
    local existingRenewalTime = tonumber(existingData.lastRenewalSignedDate or 0)
    local incomingRenewalTime = tonumber(incomingData.lastRenewalSignedDate or 0)

    -- 4. 判斷是否為「續約偏好獨立更新」事件 (如 DID_CHANGE_RENEWAL_STATUS，交易時間戳記未推進但續約時間戳記更新)
    local isRenewalUpdateOnly = (incomingRenewalTime > 0 and incomingRenewalTime >= existingRenewalTime and incomingData.willRenew ~= nil and incomingTxTime <= existingTxTime)

    -- 5. 處理退款/撤銷寫入 (最高優先級)
    if incomingData.status == 'revoked' then
      -- 允許寫入退款撤銷
    elseif isRenewalUpdateOnly then
      -- 續約狀態明確更新：保留既有交易生命週期資料 (status, expiresDate, tier 等)，僅更新 willRenew 與 lastRenewalSignedDate
      existingData.willRenew = incomingData.willRenew
      existingData.lastRenewalSignedDate = incomingRenewalTime
      if incomingData.verifiedAt then
        existingData.verifiedAt = incomingData.verifiedAt
      end
      incomingData = existingData
      recordStr = cjson.encode(incomingData)
    else
      -- 6. 一般交易生命週期比較：
      -- A. 既有交易時間明確晚於傳入交易時間：
      if existingTxTime > incomingTxTime and incomingTxTime > 0 then
        return {'STALE', tostring(existingTxTime)}
      end

      -- B. 亂序過期保護 (Out-of-order Expired Protection)：
      if existingData.status == 'active' and incomingData.status == 'expired' then
        local existingExpires = tonumber(existingData.expiresDate or 0)
        local incomingExpires = tonumber(incomingData.expiresDate or 0)
        if existingExpires > 0 and incomingExpires > 0 and existingExpires > incomingExpires then
          return {'OUT_OF_ORDER_EXPIRED', tostring(existingExpires)}
        end
      end

      -- C. 時間戳記完全相同但狀態不同衝突防護：
      if incomingTxTime == existingTxTime then
        if existingData.status == 'revoked' and incomingData.status ~= 'revoked' then
          return {'REVOKED_LOCK', tostring(existingTxTime)}
        end
        if existingData.status == 'active' and incomingData.status == 'expired' then
          local existingExpires = tonumber(existingData.expiresDate or 0)
          if existingExpires > 0 and incomingData.expiresDate and existingExpires >= tonumber(incomingData.expiresDate) then
            return {'OUT_OF_ORDER_EXPIRED', tostring(existingExpires)}
          end
        end
      end

      -- D. 續約欄位 willRenew 與 lastRenewalSignedDate 合併保護：
      if incomingData.tier == 'lifetime' then
        incomingData.willRenew = nil
        incomingData.lastRenewalSignedDate = nil
      elseif incomingData.willRenew == nil then
        if existingData.willRenew ~= nil then
          incomingData.willRenew = existingData.willRenew
          incomingData.lastRenewalSignedDate = existingData.lastRenewalSignedDate
        end
      else
        if existingData.willRenew ~= nil and existingRenewalTime > incomingRenewalTime and incomingRenewalTime > 0 then
          incomingData.willRenew = existingData.willRenew
          incomingData.lastRenewalSignedDate = existingData.lastRenewalSignedDate
        end
      end

      -- E. 到期日逆向縮短保護 (若既有為 active 且到期日更長，不允許被較短的 active 縮短)
      if existingData.status == 'active' and incomingData.status == 'active' then
        local existingExpires = tonumber(existingData.expiresDate or 0)
        local incomingExpires = tonumber(incomingData.expiresDate or 0)
        if existingExpires > 0 and incomingExpires > 0 and existingExpires > incomingExpires then
          incomingData.expiresDate = existingExpires
        end
      end

      recordStr = cjson.encode(incomingData)
    end
  end
end

if ttlSeconds and ttlSeconds > 0 then
  redis.call('SET', mainKey, recordStr, 'EX', ttlSeconds)
else
  redis.call('SET', mainKey, recordStr)
end

return {'OK'}
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

    if (script === SAVE_ENTITLEMENT_OCC_LUA) {
      const [mainKey] = keys;
      const [recordStr, incomingTimestampStr, ttlSecondsStr] = args;
      const incomingTimestamp = Number(incomingTimestampStr || 0);
      const ttlSeconds = Number(ttlSecondsStr || 0);

      const existingRaw = this.getCleanKey(mainKey);
      let recordToStore = String(recordStr);

      if (existingRaw) {
        try {
          const existingData = JSON.parse(existingRaw);
          let incomingData = JSON.parse(String(recordStr));

          // 0. 終身方案保護 (Lifetime Protection)
          if (existingData.tier === 'lifetime' && existingData.status === 'active' && incomingData.status !== 'revoked') {
            if (incomingData.tier !== 'lifetime') {
              return ['LIFETIME_PROTECTED', '既有終身方案不可被一般訂閱或過期通知降級'];
            }
          }

          // 1. 退款撤銷鎖定防護
          if (existingData.status === 'revoked' && incomingData.status !== 'revoked') {
            const existingRevocation = Number(existingData.revocationDate || existingData.lastAppleSignedDate || 0);
            const incomingPurchase = Number(incomingData.purchaseDate || 0);
            const isNewPurchaseAfterRevoke = (incomingPurchase > existingRevocation) && !incomingData.revocationDate;
            if (!isNewPurchaseAfterRevoke) {
              return ['REVOKED_LOCK', String(existingRevocation)];
            }
          }

          // 2. 交易時間戳記比對
          const existingTxTime = Number(existingData.lastAppleSignedDate || existingData.purchaseDate || 0);
          const incomingTxTime = Number(incomingData.lastAppleSignedDate || incomingTimestamp || incomingData.purchaseDate || 0);

          // 3. 續約時間戳記比對
          const existingRenewalTime = Number(existingData.lastRenewalSignedDate || 0);
          const incomingRenewalTime = Number(incomingData.lastRenewalSignedDate || 0);

          // 4. 判斷是否為續約偏好獨立更新 (交易時間戳記未推進但續約時間戳記更新)
          const isRenewalUpdateOnly = (incomingRenewalTime > 0 && incomingRenewalTime >= existingRenewalTime && incomingData.willRenew !== undefined && incomingTxTime <= existingTxTime);

          // 5. 處理退款/撤銷
          if (incomingData.status === 'revoked') {
            // 允許寫入退款
            recordToStore = JSON.stringify(incomingData);
          } else if (isRenewalUpdateOnly) {
            existingData.willRenew = incomingData.willRenew;
            existingData.lastRenewalSignedDate = incomingRenewalTime;
            if (incomingData.verifiedAt) {
              existingData.verifiedAt = incomingData.verifiedAt;
            }
            recordToStore = JSON.stringify(existingData);
          } else {
            // 6. 一般交易生命週期比較
            if (existingTxTime > incomingTxTime && incomingTxTime > 0) {
              return ['STALE', String(existingTxTime)];
            }

            // 亂序過期保護
            if (existingData.status === 'active' && incomingData.status === 'expired') {
              const existingExpires = Number(existingData.expiresDate || 0);
              const incomingExpires = Number(incomingData.expiresDate || 0);
              if (existingExpires > 0 && incomingExpires > 0 && existingExpires > incomingExpires) {
                return ['OUT_OF_ORDER_EXPIRED', String(existingExpires)];
              }
            }

            // 時間戳記完全相同衝突防護
            if (incomingTxTime === existingTxTime) {
              if (existingData.status === 'revoked' && incomingData.status !== 'revoked') {
                return ['REVOKED_LOCK', String(existingTxTime)];
              }
              if (existingData.status === 'active' && incomingData.status === 'expired') {
                const existingExpires = Number(existingData.expiresDate || 0);
                if (existingExpires > 0 && incomingData.expiresDate && existingExpires >= Number(incomingData.expiresDate)) {
                  return ['OUT_OF_ORDER_EXPIRED', String(existingExpires)];
                }
              }
            }

            // 續約欄位 willRenew 與 lastRenewalSignedDate 合併保護
            if (incomingData.tier === 'lifetime') {
              delete incomingData.willRenew;
              delete incomingData.lastRenewalSignedDate;
            } else if (incomingData.willRenew === undefined) {
              if (existingData.willRenew !== undefined) {
                incomingData.willRenew = existingData.willRenew;
                incomingData.lastRenewalSignedDate = existingData.lastRenewalSignedDate;
              }
            } else {
              if (existingData.willRenew !== undefined && existingRenewalTime > incomingRenewalTime && incomingRenewalTime > 0) {
                incomingData.willRenew = existingData.willRenew;
                incomingData.lastRenewalSignedDate = existingData.lastRenewalSignedDate;
              }
            }

            // 到期日逆向縮短保護
            if (existingData.status === 'active' && incomingData.status === 'active') {
              const existingExpires = Number(existingData.expiresDate || 0);
              const incomingExpires = Number(incomingData.expiresDate || 0);
              if (existingExpires > 0 && incomingExpires > 0 && existingExpires > incomingExpires) {
                incomingData.expiresDate = existingExpires;
              }
            }

            recordToStore = JSON.stringify(incomingData);
          }
        } catch {
          // 忽略格式解析例外
        }
      }

      if (ttlSeconds > 0) {
        this.store.set(mainKey, {
          value: recordToStore,
          expireAt: Date.now() + ttlSeconds * 1000,
        });
      } else {
        this.store.set(mainKey, {
          value: recordToStore,
        });
      }
      return ['OK'];
    }

    return 'OK';
  }

  async incr(key: string): Promise<number> {
    const raw = this.getCleanKey(key);
    const num = (raw ? parseInt(raw, 10) : 0) + 1;
    const existing = this.store.get(key);
    this.store.set(key, { value: String(num), expireAt: existing?.expireAt });
    return num;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const existing = this.store.get(key);
    if (!existing) return 0;
    existing.expireAt = Date.now() + seconds * 1000;
    return 1;
  }

  async ttl(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return -2;
    if (entry.expireAt === undefined) return -1;
    const remainingMs = entry.expireAt - Date.now();
    if (remainingMs <= 0) {
      this.store.delete(key);
      return -2;
    }
    return Math.ceil(remainingMs / 1000);
  }

  async get<T = any>(key: string): Promise<T | null> {
    const val = this.getCleanKey(key);
    if (val === null) return null;
    try {
      return JSON.parse(val);
    } catch {
      return val as any;
    }
  }

  async set(key: string, value: any, opts?: { ex?: number }): Promise<'OK'> {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    const expireAt = opts?.ex ? Date.now() + opts.ex * 1000 : undefined;
    this.store.set(key, { value: str, expireAt });
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const k of keys) {
      if (this.store.delete(k)) count++;
    }
    return count;
  }

  async sadd(key: string, ...members: any[]): Promise<number> {
    const raw = this.getCleanKey(key);
    let existing: string[] = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) existing = parsed;
      } catch {}
    }
    const set = new Set(existing);
    let added = 0;
    for (const m of members) {
      const sm = String(m);
      if (!set.has(sm)) {
        set.add(sm);
        added++;
      }
    }
    this.store.set(key, { value: JSON.stringify(Array.from(set)) });
    return added;
  }

  async smembers(key: string): Promise<string[]> {
    const raw = this.getCleanKey(key);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async zadd(key: string, scoreOrObj: any, maybeMember?: string): Promise<number> {
    const scoreMember: { score: number; member: string } =
      typeof scoreOrObj === 'object' && scoreOrObj !== null
        ? scoreOrObj
        : { score: Number(scoreOrObj), member: String(maybeMember) };
    const raw = this.getCleanKey(key);
    let existing: Array<{ score: number; member: string }> = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) existing = parsed;
      } catch {}
    }
    const list = existing.filter((x) => x.member !== scoreMember.member);
    list.push(scoreMember);
    this.store.set(key, { value: JSON.stringify(list) });
    return 1;
  }

  async zcard(key: string): Promise<number> {
    const raw = this.getCleanKey(key);
    if (!raw) return 0;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      return 0;
    }
  }

  async zrange(key: string, min: number, max: number): Promise<string[]> {
    const raw = this.store.get(key);
    if (!raw) return [];
    let parsed: any;
    try {
      parsed = JSON.parse(raw.value);
    } catch {
      throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    }
    if (!Array.isArray(parsed)) {
      throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    }
    const sorted = [...parsed].sort((a, b) => a.score - b.score);
    return sorted.map((x) => x.member).slice(min, max === -1 ? undefined : max + 1);
  }

  clear() {
    this.store.clear();
  }

  clearAll() {
    this.store.clear();
  }
}

export const inMemoryRedisMockInstance = new InMemoryRedisMock();

/**
 * 取得 Redis 客戶端實例
 */
export function getRedisClient(): any {
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
      const payloadStr = typeof res[1] === 'string' ? res[1] : JSON.stringify(res[1]);
      return {
        status: 'CACHED',
        cachedResponse: payloadStr,
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
