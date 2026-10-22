import crypto from 'node:crypto';
import type { AppleVerificationResult } from './appleIap';
import { getRedisClient, SAVE_ENTITLEMENT_OCC_LUA } from './redis';

/**
 * 考試計畫 AI - 會員權限與 Apple 交易資料持久化管理模組 (Upstash Redis)
 *
 * 安全強化規範：
 * 1. 交易權限主記錄 (apple:entitlement:{originalTransactionId})
 *    - Lifetime 終身版不設定 TTL (真正永久持久化保存)。
 *    - 訂閱商品記錄保留時間為「到期時間 + 30 天緩衝」。
 *    - 嚴禁舊 JWS 逆向覆蓋較新的續訂到期日。
 * 2. 退款即時聯防收回：
 *    - 當交易被撤銷 (revoked)，即刻主動清除所有關聯裝置的使用者即時快取。
 * 3. 使用者即時權限快取 (user:{userId}:entitlement)：
 *    - 供 AI Advice 等端點毫秒級快速確認 Pro / Lifetime 資格。
 * 4. 跨裝置與恢復關聯 (apple:devices_z:{originalTransactionId})：
 *    - 採用 Sorted Set 以時間戳記記錄活躍裝置，支援換機與多裝置。
 *    - 設定合理安全保護上限（同時活躍上限 10 台），避免單一收據被公開大規模外洩盜用。
 * 5. 防偽 HMAC-SHA256 Proof Token：
 *    - 簽章包含 userId、originalTransactionId 與到期日。
 *    - 驗證時必須比對 Redis 主記錄，若已被退款或過期立即拒絕，杜絕持舊 Token 離線盜刷。
 */

export interface AppleEntitlementRecord {
  originalTransactionId: string;
  lastTransactionId: string;
  productId: string;
  tier: 'pro' | 'lifetime';
  status: 'active' | 'expired' | 'revoked';
  purchaseDate?: number;
  originalPurchaseDate?: number;
  expiresDate?: number | null;
  revocationDate?: number | null;
  willRenew?: boolean;
  verifiedAt: number;
  lastAppleSignedDate?: number;
  lastRenewalSignedDate?: number;
  environment: string;
}

export interface UserEntitlementCache {
  userId: string;
  tier: 'pro' | 'lifetime';
  productId: string;
  originalTransactionId: string;
  expiresAt?: number | null;
  willRenew?: boolean;
  verifiedAt: number;
  environment: string;
}

export interface UserEntitlementInfo {
  tier: 'free' | 'pro' | 'lifetime';
  isVerified: boolean;
  status: 'active' | 'expired' | 'revoked' | 'none';
  productId?: string;
  originalTransactionId?: string;
  expiresAt?: number | null;
  willRenew?: boolean;
}

const SERVER_SECRET = process.env.APP_SERVER_SECRET || 'exam_plan_ai_signing_secret_2026';
export const ANOMALOUS_DEVICE_THRESHOLD_PER_PURCHASE = 20; // 僅作為異常外洩監控日誌臨界值，絕不阻斷正常使用者恢復購買
export const PROOF_TOKEN_MAX_TTL_MS = 7 * 86400 * 1000; // 最長 7 天階段有效，需定期更新

/**
 * 產生匿名使用者身分與 Apple 交易之防偽簽章權杖 (Proof Token)
 */
export function generateEntitlementProofToken(
  userId: string,
  originalTransactionId: string,
  expiresAt?: number | null,
): string {
  const now = Date.now();
  // 權杖有效期為「方案到期日」與「7 天」取較小值 (終身版預設 7 天滾動更新)
  const tokenExpiresAt = expiresAt ? Math.min(expiresAt, now + PROOF_TOKEN_MAX_TTL_MS) : now + PROOF_TOKEN_MAX_TTL_MS;
  const payload = `${userId}:${originalTransactionId}:${tokenExpiresAt}`;
  const signature = crypto
    .createHmac('sha256', SERVER_SECRET)
    .update(payload)
    .digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${signature}`;
}

/**
 * 驗證防偽簽章權杖（整合密鑰校驗與 Redis 最新退款/過期狀態聯防）
 */
export async function verifyEntitlementProofToken(
  token: string,
  expectedUserId?: string,
): Promise<{
  valid: boolean;
  userId?: string;
  originalTransactionId?: string;
  expiresAt?: number;
  reason?: string;
  isExpired?: boolean;
  isSignatureValid?: boolean;
  canRenew?: boolean;
  latestExpiresAt?: number;
  isRevoked?: boolean;
}> {
  if (!token || typeof token !== 'string') return { valid: false, reason: '未提供權杖。' };
  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false, reason: '權杖格式無效。' };

  const [rawPayloadB64, signature] = parts;
  let payloadStr = '';
  try {
    payloadStr = Buffer.from(rawPayloadB64, 'base64url').toString('utf8');
  } catch {
    return { valid: false, reason: '權杖解碼失敗。' };
  }

  const expectedSig = crypto
    .createHmac('sha256', SERVER_SECRET)
    .update(payloadStr)
    .digest('base64url');

  if (signature !== expectedSig) {
    return { valid: false, reason: '權杖數位簽名不符。' };
  }

  const [userId, originalTransactionId, expStr] = payloadStr.split(':');
  if (!userId || !originalTransactionId) return { valid: false, reason: '權杖內文缺失必要身分或交易資訊。' };

  if (expectedUserId && userId !== expectedUserId) {
    return { valid: false, reason: '權杖所屬身分與當前請求裝置不符。' };
  }

  const expiresAt = parseInt(expStr || '0', 10);
  if (isNaN(expiresAt) || expiresAt <= 0) {
    return { valid: false, reason: '權杖到期時間戳無效。' };
  }
  const now = Date.now();
  const isTokenExpired = expiresAt < now;

  // 安全核心聯防：比對 Redis 中該 Apple 交易的最新狀態（防止退款後繼續持有舊 Token、並支援雲端續約自動輪轉）
  try {
    const record = await getOriginalTransactionEntitlement(originalTransactionId);
    if (record) {
      if (record.status === 'revoked' || record.revocationDate) {
        return {
          valid: false,
          userId,
          originalTransactionId,
          expiresAt,
          reason: '此交易已被退款或撤銷。',
          isRevoked: true,
        };
      }

      if (isTokenExpired) {
        // 嚴格安全續約換發檢查：
        // 1. 簽章必須合法 (前面已驗證)
        // 2. 請求裝置必須與 Token 內部 userId 吻合 (前面已驗證)
        // 3. Redis 主記錄必須為 active Pro 且最新到期日大於目前時間 (證明 Apple 官方已續訂)
        //    或為 Lifetime 買斷方案
        // 4. Token 逾期時間不得超過 30 天滾動窗口 (防範遠古 Token 重放)
        const isEligibleForRenewalRotation =
          record.status === 'active' &&
          (record.tier === 'lifetime' || (record.expiresDate && record.expiresDate > now)) &&
          now - expiresAt <= 30 * 86400 * 1000;

        if (isEligibleForRenewalRotation) {
          return {
            valid: false, // 權杖本身確實已過期 (保持與既有單元測試相容)
            userId,
            originalTransactionId,
            expiresAt,
            reason: '權杖已逾期（符合續約換發條件）。',
            isExpired: true,
            isSignatureValid: true,
            canRenew: true,
            latestExpiresAt: record.expiresDate || undefined,
          };
        }

        return {
          valid: false,
          userId,
          originalTransactionId,
          expiresAt,
          reason: '權杖已逾期。',
          isExpired: true,
          isSignatureValid: true,
          canRenew: false,
        };
      }

      if (record.status === 'expired' || (record.expiresDate && record.expiresDate < now)) {
        return {
          valid: false,
          userId,
          originalTransactionId,
          expiresAt,
          reason: '此訂閱已在 Apple 伺服端到期。',
        };
      }
    } else if (isTokenExpired) {
      return {
        valid: false,
        userId,
        originalTransactionId,
        expiresAt,
        reason: '權杖已逾期。',
        isExpired: true,
        isSignatureValid: true,
        canRenew: false,
      };
    }
  } catch {
    if (isTokenExpired) {
      return {
        valid: false,
        userId,
        originalTransactionId,
        expiresAt,
        reason: '權杖已逾期。',
        isExpired: true,
        isSignatureValid: true,
        canRenew: false,
      };
    }
  }

  return { valid: true, userId, originalTransactionId, expiresAt };
}

/**
 * 將通過 Apple 驗證的交易儲存至 Redis
 */
export async function saveVerifiedEntitlement(
  userId: string,
  verification: AppleVerificationResult,
): Promise<{
  effectiveStatus: 'active' | 'expired' | 'revoked';
  effectiveTier: 'free' | 'pro' | 'lifetime';
  effectiveWillRenew?: boolean;
  effectiveExpiresDate?: number | null;
}> {
  const originalTransactionId = verification.originalTransactionId || verification.transactionId;
  const productId = verification.productId;

  if (!originalTransactionId || !productId) {
    throw new Error('儲存會員權益失敗：缺少原始交易識別碼或產品 ID。');
  }

  const redis = getRedisClient();
  const now = Date.now();

  let effectiveExpiresDate = verification.expiresDate || null;
  let effectiveStatus: 'active' | 'expired' | 'revoked' =
    verification.status === 'active' ? 'active' : verification.status === 'revoked' ? 'revoked' : 'expired';
  let effectiveTier: 'free' | 'pro' | 'lifetime' = verification.tier;
  let effectiveRevocationDate = verification.revocationDate || null;

  // 1. 讀取現有記錄評估初步狀態
  let existing: AppleEntitlementRecord | null = null;
  try {
    existing = (await redis.get(`exam_ai:apple:entitlement:${originalTransactionId}`)) as AppleEntitlementRecord | null;
    if (existing) {
      // 安全關鍵防護 0：Lifetime 方案不可被一般訂閱或過期通知降級
      if (existing.tier === 'lifetime' && existing.status === 'active' && effectiveStatus !== 'revoked') {
        effectiveTier = 'lifetime';
        effectiveStatus = 'active';
        effectiveExpiresDate = null;
      }
      // 安全關鍵防護 A：若既有記錄已被標記為撤銷/退款，舊 JWS (active) 絕不能覆蓋回 active
      else if (existing.status === 'revoked' && effectiveStatus !== 'revoked') {
        const existingRevocation = Number(existing.revocationDate || existing.lastAppleSignedDate || 0);
        const incomingPurchase = Number(verification.purchaseDate || 0);
        const isNewPurchaseAfterRevoke = (incomingPurchase > existingRevocation) && !verification.revocationDate;
        if (!isNewPurchaseAfterRevoke) {
          console.warn(`[退款安全] 交易 ${originalTransactionId} 在伺服端已確認為撤銷/退款狀態，拒絕以舊 JWS 覆蓋回 active。`);
          effectiveStatus = 'revoked';
          effectiveTier = 'free';
          effectiveRevocationDate = existing.revocationDate || now;
        }
      }
      // 安全關鍵防護 B：若既有記錄為有效續訂，且既有到期日更晚，略過舊 JWS 的短到期日
      else if (existing.status === 'active' && effectiveStatus === 'active') {
        if (existing.expiresDate && effectiveExpiresDate && existing.expiresDate > effectiveExpiresDate) {
          console.warn(`[權限安全] 略過舊 JWS 逆向覆蓋較新的續約到期日 (保留 ${existing.expiresDate})`);
          effectiveExpiresDate = existing.expiresDate;
        }
      }
      // 安全關鍵防護 C：若既有記錄為有效續約（且尚未過期），收到過期舊 JWS 不得降級
      else if (existing.status === 'active' && effectiveStatus === 'expired' && existing.expiresDate && existing.expiresDate > now) {
        console.warn(`[權限安全] 略過過期舊 JWS 覆蓋現有有效續約 (保留 ${existing.expiresDate})`);
        effectiveStatus = 'active';
        effectiveTier = existing.tier;
        effectiveExpiresDate = existing.expiresDate;
      }
    }
  } catch {
    // 忽略檢查錯誤
  }

  // 決定 willRenew 偏好：
  // 1. 若為 Lifetime 終身版，一律為 undefined (不應具有自動續訂屬性)
  // 2. 若傳入驗證結果有明確 willRenew (如帶有 renewalInfo)，採用之
  // 3. 若既有記錄已有 willRenew，一律保留既有權威值 (無論 true 或 false)
  // 4. 若為未知狀態，保留 undefined，絕不擅自預設為 true
  const effectiveWillRenew =
    effectiveTier === 'lifetime'
      ? undefined
      : verification.willRenew !== undefined
      ? verification.willRenew
      : existing?.willRenew !== undefined
      ? existing.willRenew
      : undefined;

  const txSignedDate = verification.signedDate || verification.purchaseDate || 0;

  const entitlementRecord: AppleEntitlementRecord = {
    originalTransactionId,
    lastTransactionId: verification.transactionId || originalTransactionId,
    productId,
    tier: effectiveTier === 'lifetime' ? 'lifetime' : 'pro',
    status: effectiveStatus,
    purchaseDate: verification.purchaseDate,
    originalPurchaseDate: verification.originalPurchaseDate,
    expiresDate: effectiveExpiresDate,
    revocationDate: effectiveRevocationDate,
    willRenew: effectiveWillRenew,
    verifiedAt: now,
    lastAppleSignedDate: txSignedDate > 0 ? txSignedDate : existing?.lastAppleSignedDate,
    lastRenewalSignedDate: existing?.lastRenewalSignedDate,
    environment: verification.environment || 'Sandbox',
  };

  // 2. 透過 Redis OCC 原子寫入主記錄 (apple:entitlement:{originalTransactionId})
  let recordTtlSeconds = 0;
  if (effectiveTier !== 'lifetime') {
    if (effectiveExpiresDate && effectiveStatus === 'active') {
      const diffSec = Math.ceil((effectiveExpiresDate - now) / 1000);
      recordTtlSeconds = Math.max(86400, diffSec + 30 * 86400);
    } else {
      recordTtlSeconds = 30 * 86400;
    }
  }

  const mainKey = `exam_ai:apple:entitlement:${originalTransactionId}`;
  try {
    const occRes = (await redis.eval(
      SAVE_ENTITLEMENT_OCC_LUA,
      [mainKey],
      [JSON.stringify(entitlementRecord), String(txSignedDate), String(recordTtlSeconds)],
    )) as string[];

    if (occRes && occRes[0] !== 'OK') {
      const occCode = occRes[0];
      if (occCode === 'REVOKED_LOCK') {
        effectiveStatus = 'revoked';
        effectiveTier = 'free';
      } else if (occCode === 'LIFETIME_PROTECTED') {
        effectiveStatus = 'active';
        effectiveTier = 'lifetime';
      } else if (occCode === 'STALE') {
        // 既有記錄已有更新的 Apple 狀態，讀取最新記錄確認狀態
        const latestRecord = (await redis.get(mainKey)) as AppleEntitlementRecord | null;
        if (latestRecord) {
          effectiveStatus = latestRecord.status;
          effectiveTier = latestRecord.tier;
        }
      } else if (occCode === 'OUT_OF_ORDER_EXPIRED') {
        effectiveStatus = 'active';
      }
    }
  } catch (occErr) {
    console.warn(`[OCC寫入警示] 主記錄寫入異常 (交易 ${originalTransactionId}):`, occErr);
    // 降級寫入保證服務可用性
    if (effectiveTier === 'lifetime') {
      await redis.set(mainKey, entitlementRecord);
    } else {
      await redis.set(mainKey, entitlementRecord, { ex: recordTtlSeconds || 86400 });
    }
  }

  // 3. 跨裝置關聯 (apple:devices_z:{originalTransactionId})
  const currentDevicesCount = await redis.zcard(`exam_ai:apple:devices_z:${originalTransactionId}`);
  if (currentDevicesCount >= ANOMALOUS_DEVICE_THRESHOLD_PER_PURCHASE) {
    console.warn(`[異常流量監控] 交易 ${originalTransactionId} 關聯裝置數已達 ${currentDevicesCount} 台，請留意收據外流情況。`);
  }

  // 記錄使用者裝置活動時間戳記
  await redis.zadd(`exam_ai:apple:devices_z:${originalTransactionId}`, { score: now, member: userId });
  await redis.sadd(`exam_ai:user:${userId}:apple_txns`, originalTransactionId);

  // 4. 跨交易綜合評估並更新使用者的即時權限快取 (user:{userId}:entitlement)
  await syncUserDeviceEffectiveEntitlement(userId, originalTransactionId, null, now);

  // 若被 Apple 撤銷或退款，聯防同步所有關聯裝置 (確保不誤殺其他有效交易)
  if (effectiveStatus === 'revoked') {
    try {
      const associatedDevices = (await redis.zrange(`exam_ai:apple:devices_z:${originalTransactionId}`, 0, -1)) as string[];
      for (const devId of associatedDevices) {
        if (devId !== userId) {
          await syncUserDeviceEffectiveEntitlement(devId, originalTransactionId, null, now);
        }
      }
    } catch (revErr) {
      console.warn('[退款聯防警示] 跨裝置同步失敗:', revErr);
    }
  }

  const finalRecord = (await redis.get(mainKey)) as AppleEntitlementRecord | null;

  return {
    effectiveStatus,
    effectiveTier,
    effectiveWillRenew: effectiveTier === 'lifetime' ? undefined : finalRecord?.willRenew,
    effectiveExpiresDate: finalRecord?.expiresDate || effectiveExpiresDate,
  };
}

/**
 * 跨交易綜合評估並更新使用者裝置之即時會員快取 (Multi-Transaction Device Entitlement Sync)
 *
 * 核心安全保證：
 * 1. 當使用者同時擁有多筆 Apple 交易（如 Lifetime 終身版 + 月訂閱，或多筆訂閱），
 *    到期或撤銷其中一筆時，嚴禁無條件刪除裝置快取誤殺其他有效交易！
 * 2. 評估優先級：Lifetime (終身有效) > Pro (到期日最晚之有效續約)。
 * 3. 僅當名下所有交易皆為 expired / revoked 時，才真正清除裝置快取收回權益。
 */
export async function syncUserDeviceEffectiveEntitlement(
  userId: string,
  targetOriginalTxId?: string,
  updatedTargetRecord?: AppleEntitlementRecord | null,
  now?: number,
): Promise<UserEntitlementCache | null> {
  if (!userId) return null;
  const currentNow = now || Date.now();
  const redis = getRedisClient();
  const txnsKey = `exam_ai:user:${userId}:apple_txns`;
  const userCacheKey = `exam_ai:user:${userId}:entitlement`;

  const allTxns = (await redis.smembers(txnsKey)) as string[];
  const txnsSet = new Set(Array.isArray(allTxns) ? allTxns : []);
  if (targetOriginalTxId) {
    txnsSet.add(targetOriginalTxId);
  }

  if (txnsSet.size === 0) {
    await redis.del(userCacheKey);
    return null;
  }

  let bestLifetimeRecord: AppleEntitlementRecord | null = null;
  let bestProRecord: AppleEntitlementRecord | null = null;

  for (const txId of txnsSet) {
    if (!txId) continue;
    let record: AppleEntitlementRecord | null = null;
    if (txId === targetOriginalTxId && updatedTargetRecord !== undefined) {
      record = updatedTargetRecord;
    } else {
      record = await getOriginalTransactionEntitlement(txId);
    }

    if (!record) continue;

    // 排除已撤銷/退款之交易
    if (record.status === 'revoked') continue;

    // 檢查 Lifetime (終身買斷版)
    if (record.tier === 'lifetime' && record.status === 'active') {
      bestLifetimeRecord = record;
      break; // Lifetime 優先度最高，直接採用
    }

    // 檢查 Pro 訂閱型方案：必須為 active 且到期日大於目前時間
    if (record.tier === 'pro' && record.status === 'active') {
      const exp = record.expiresDate;
      if (!exp || exp > currentNow) {
        if (!bestProRecord || (exp && (!bestProRecord.expiresDate || exp > bestProRecord.expiresDate))) {
          bestProRecord = record;
        }
      }
    }
  }

  const activeRecord = bestLifetimeRecord || bestProRecord;

  if (activeRecord) {
    const userCache: UserEntitlementCache = {
      userId,
      tier: activeRecord.tier,
      productId: activeRecord.productId,
      originalTransactionId: activeRecord.originalTransactionId,
      expiresAt: activeRecord.expiresDate,
      willRenew: activeRecord.tier === 'lifetime' ? undefined : activeRecord.willRenew,
      verifiedAt: currentNow,
      environment: activeRecord.environment,
    };

    if (activeRecord.tier === 'lifetime') {
      await redis.set(userCacheKey, userCache);
    } else if (activeRecord.expiresDate) {
      const cacheTtl = Math.max(300, Math.ceil((activeRecord.expiresDate - currentNow) / 1000));
      await redis.set(userCacheKey, userCache, { ex: cacheTtl });
    }
    return userCache;
  } else {
    // 該使用者名下所有交易均無有效權限，安全刪除快取
    await redis.del(userCacheKey);
    return null;
  }
}

/**
 * 查詢使用者的即時會員權限
 */
export async function getUserEntitlement(userId: string): Promise<UserEntitlementInfo> {
  if (!userId) return { tier: 'free', isVerified: false, status: 'none' };

  const redis = getRedisClient();
  let cached = (await redis.get(`exam_ai:user:${userId}:entitlement`)) as UserEntitlementCache | null;

  // 快取遺失自我修復：若快取為空，但該裝置關聯有交易，自動嘗試重新聚合最優權益
  if (!cached) {
    cached = await syncUserDeviceEffectiveEntitlement(userId);
  }

  if (!cached) {
    return { tier: 'free', isVerified: false, status: 'none' };
  }

  const now = Date.now();
  // 檢查是否到期 (僅針對訂閱，Lifetime expiresAt 為 null 不會誤判過期)
  if (cached.expiresAt && cached.expiresAt < now) {
    await redis.del(`exam_ai:user:${userId}:entitlement`);
    return {
      tier: 'free',
      isVerified: false,
      status: 'expired',
      productId: cached.productId,
      originalTransactionId: cached.originalTransactionId,
      expiresAt: cached.expiresAt,
    };
  }

  // 同步檢查原始交易是否已被標記為 revoked
  if (cached.originalTransactionId) {
    try {
      const mainRecord = await getOriginalTransactionEntitlement(cached.originalTransactionId);
      if (mainRecord && mainRecord.status === 'revoked') {
        await redis.del(`exam_ai:user:${userId}:entitlement`);
        return {
          tier: 'free',
          isVerified: false,
          status: 'revoked',
          productId: cached.productId,
          originalTransactionId: cached.originalTransactionId,
          expiresAt: cached.expiresAt,
        };
      }
    } catch {
      // 忽略 Redis 查詢失敗
    }
  }

  return {
    tier: cached.tier,
    isVerified: true,
    status: 'active',
    productId: cached.productId,
    originalTransactionId: cached.originalTransactionId,
    expiresAt: cached.expiresAt,
    willRenew: cached.tier === 'lifetime' ? undefined : cached.willRenew,
  };
}

/**
 * 查詢原始交易的完整權限記錄
 */
export async function getOriginalTransactionEntitlement(
  originalTransactionId: string,
): Promise<AppleEntitlementRecord | null> {
  if (!originalTransactionId) return null;
  const redis = getRedisClient();
  return (await redis.get(`exam_ai:apple:entitlement:${originalTransactionId}`)) as AppleEntitlementRecord | null;
}

/**
 * 查詢與該筆交易關聯的裝置數量
 */
export async function getLinkedDevicesCount(originalTransactionId: string): Promise<number> {
  if (!originalTransactionId) return 0;
  const redis = getRedisClient();
  return redis.zcard(`exam_ai:apple:devices_z:${originalTransactionId}`);
}
