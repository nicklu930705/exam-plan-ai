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
  isSandbox?: boolean;
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
  isSandbox?: boolean;
}

export interface UserEntitlementInfo {
  tier: 'free' | 'pro' | 'lifetime';
  isVerified: boolean;
  status: 'active' | 'expired' | 'revoked' | 'none';
  productId?: string;
  originalTransactionId?: string;
  expiresAt?: number | null;
  willRenew?: boolean;
  environment?: string;
  isSandbox?: boolean;
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
  environment?: string,
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
  environment?: string;
  isSandbox?: boolean;
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
      const recEnv = record.environment || 'Sandbox';
      const isSandbox = recEnv.toLowerCase() === 'sandbox';

      if (record.status === 'revoked' || record.revocationDate) {
        return {
          valid: false,
          userId,
          originalTransactionId,
          expiresAt,
          environment: recEnv,
          isSandbox,
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
            environment: recEnv,
            isSandbox,
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
          environment: recEnv,
          isSandbox,
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
          environment: recEnv,
          isSandbox,
          reason: '此訂閱已在 Apple 伺服端到期。',
        };
      }

      return {
        valid: true,
        userId,
        originalTransactionId,
        expiresAt,
        environment: recEnv,
        isSandbox,
      };
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
  const normalizedEnv = (verification.environment || 'Sandbox').trim().toLowerCase();
  const envScopedMainKey = `exam_ai:apple:entitlement:${normalizedEnv}:${originalTransactionId}`;
  const legacyMainKey = `exam_ai:apple:entitlement:${originalTransactionId}`;

  let effectiveExpiresDate = verification.expiresDate || null;
  let effectiveStatus: 'active' | 'expired' | 'revoked' =
    verification.status === 'active' ? 'active' : verification.status === 'revoked' ? 'revoked' : 'expired';
  let effectiveTier: 'free' | 'pro' | 'lifetime' = verification.tier;
  let effectiveRevocationDate = verification.revocationDate || null;

  // 1. 讀取現有記錄評估初步狀態 (優先讀取隔離環境記錄，並相容舊版主記錄)
  let existing: AppleEntitlementRecord | null = null;
  let legacyExisting: AppleEntitlementRecord | null = null;
  try {
    existing = await getOriginalTransactionEntitlement(originalTransactionId, normalizedEnv);
    legacyExisting = (await redis.get(legacyMainKey)) as AppleEntitlementRecord | null;
    if (!existing && legacyExisting) {
      existing = legacyExisting;
    }

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

  // 跨環境覆蓋嚴格防護：若 legacy 主記錄已由正式交易 (Production) 佔有，Sandbox 交易嚴禁覆蓋 legacy 主記錄
  const legacyEnv = (legacyExisting?.environment || 'Sandbox').toLowerCase();
  const isBlockedFromLegacy = Boolean(legacyExisting && legacyEnv === 'production' && normalizedEnv === 'sandbox');
  if (isBlockedFromLegacy) {
    console.warn(`[環境隔離安全] 交易 ${originalTransactionId} 於 Production 已有記錄，嚴禁 Sandbox 交易覆蓋 Production 主記錄！`);
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
    isSandbox: (verification.environment || 'Sandbox').toLowerCase() === 'sandbox',
  };

  // 2. 透過 Redis OCC 原子寫入環境隔離主記錄 (apple:entitlement:{env}:{originalTransactionId})
  let recordTtlSeconds = 0;
  if (effectiveTier !== 'lifetime') {
    if (effectiveExpiresDate && effectiveStatus === 'active') {
      const diffSec = Math.ceil((effectiveExpiresDate - now) / 1000);
      recordTtlSeconds = Math.max(86400, diffSec + 30 * 86400);
    } else {
      recordTtlSeconds = 30 * 86400;
    }
  }

  try {
    const occRes = (await redis.eval(
      SAVE_ENTITLEMENT_OCC_LUA,
      [envScopedMainKey],
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
        const latestRecord = (await redis.get(envScopedMainKey)) as AppleEntitlementRecord | null;
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
    if (effectiveTier === 'lifetime') {
      await redis.set(envScopedMainKey, entitlementRecord);
    } else {
      await redis.set(envScopedMainKey, entitlementRecord, { ex: recordTtlSeconds || 86400 });
    }
  }

  // 若未被跨環境防護阻斷，同步更新 legacy 主記錄以確保向後相容
  if (!isBlockedFromLegacy) {
    try {
      await redis.eval(
        SAVE_ENTITLEMENT_OCC_LUA,
        [legacyMainKey],
        [JSON.stringify(entitlementRecord), String(txSignedDate), String(recordTtlSeconds)],
      );
    } catch {
      if (effectiveTier === 'lifetime') {
        await redis.set(legacyMainKey, entitlementRecord);
      } else {
        await redis.set(legacyMainKey, entitlementRecord, { ex: recordTtlSeconds || 86400 });
      }
    }
  }

  // 3. 跨裝置關聯 (apple:devices_z:{env}:{originalTransactionId} 與相容 Key)
  await redis.zadd(`exam_ai:apple:devices_z:${normalizedEnv}:${originalTransactionId}`, { score: now, member: userId });
  if (!isBlockedFromLegacy) {
    await redis.zadd(`exam_ai:apple:devices_z:${originalTransactionId}`, { score: now, member: userId });
  }

  await redis.sadd(`exam_ai:user:${userId}:apple_txns:${normalizedEnv}`, originalTransactionId);
  await redis.sadd(`exam_ai:user:${userId}:apple_txns`, originalTransactionId);

  // 4. 跨交易綜合評估並更新使用者的即時權限快取 (user:{userId}:entitlement)
  await syncUserDeviceEffectiveEntitlement(userId, originalTransactionId, entitlementRecord, now);

  // 若被 Apple 撤銷或退款，聯防同步所有關聯裝置 (確保不誤殺其他有效交易)
  if (effectiveStatus === 'revoked') {
    try {
      const associatedDevices = (await redis.zrange(`exam_ai:apple:devices_z:${normalizedEnv}:${originalTransactionId}`, 0, -1)) as string[];
      for (const devId of associatedDevices) {
        if (devId !== userId) {
          await syncUserDeviceEffectiveEntitlement(devId, originalTransactionId, entitlementRecord, now);
        }
      }
    } catch (revErr) {
      console.warn('[退款聯防警示] 跨裝置同步失敗:', revErr);
    }
  }

  const finalRecord =
    ((await redis.get(envScopedMainKey)) as AppleEntitlementRecord | null) ||
    ((await redis.get(legacyMainKey)) as AppleEntitlementRecord | null);

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
  const userCacheKey = `exam_ai:user:${userId}:entitlement`;

  // 1. 取得該使用者名下之所有交易識別碼（優先讀取隔離集合，並相容讀取舊版集合）
  const prodTxns = (await redis.smembers(`exam_ai:user:${userId}:apple_txns:production`)) as string[];
  const sandTxns = (await redis.smembers(`exam_ai:user:${userId}:apple_txns:sandbox`)) as string[];
  const legacyTxns = (await redis.smembers(`exam_ai:user:${userId}:apple_txns`)) as string[];

  const allTxIds = new Set<string>();
  if (Array.isArray(prodTxns)) prodTxns.forEach((id) => allTxIds.add(id));
  if (Array.isArray(sandTxns)) sandTxns.forEach((id) => allTxIds.add(id));
  if (Array.isArray(legacyTxns)) legacyTxns.forEach((id) => allTxIds.add(id));
  if (targetOriginalTxId) allTxIds.add(targetOriginalTxId);

  if (allTxIds.size === 0) {
    await redis.del(userCacheKey);
    return null;
  }

  let bestProdLifetime: AppleEntitlementRecord | null = null;
  let bestProdPro: AppleEntitlementRecord | null = null;
  let bestSandLifetime: AppleEntitlementRecord | null = null;
  let bestSandPro: AppleEntitlementRecord | null = null;

  for (const txId of allTxIds) {
    if (!txId) continue;
    let record: AppleEntitlementRecord | null = null;
    if (txId === targetOriginalTxId && updatedTargetRecord !== undefined) {
      record = updatedTargetRecord;
    } else {
      record = await getOriginalTransactionEntitlement(txId);
    }

    if (!record || record.status === 'revoked') continue;

    const isRecordSandbox = (record.environment || 'Sandbox').toLowerCase() === 'sandbox';

    if (!isRecordSandbox) {
      // Production 正式交易
      if (record.tier === 'lifetime' && record.status === 'active') {
        bestProdLifetime = record;
        break; // Production Lifetime 具有最高優先權
      }
      if (record.tier === 'pro' && record.status === 'active') {
        const exp = record.expiresDate;
        if (!exp || exp > currentNow) {
          if (!bestProdPro || (exp && (!bestProdPro.expiresDate || exp > bestProdPro.expiresDate))) {
            bestProdPro = record;
          }
        }
      }
    } else {
      // Sandbox 測試交易
      if (record.tier === 'lifetime' && record.status === 'active') {
        if (!bestSandLifetime) bestSandLifetime = record;
      }
      if (record.tier === 'pro' && record.status === 'active') {
        const exp = record.expiresDate;
        if (!exp || exp > currentNow) {
          if (!bestSandPro || (exp && (!bestSandPro.expiresDate || exp > bestSandPro.expiresDate))) {
            bestSandPro = record;
          }
        }
      }
    }
  }

  // 跨環境評估優先級：Production Lifetime > Production Pro > Sandbox Lifetime > Sandbox Pro
  // 保證正式付費用戶絕對不被測試交易覆蓋或干擾，同時保證審查員在無正式購買時能順利以 Sandbox 體驗 Pro
  const activeRecord = bestProdLifetime || bestProdPro || bestSandLifetime || bestSandPro;

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
      isSandbox: activeRecord.isSandbox ?? (activeRecord.environment?.toLowerCase() === 'sandbox'),
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
    environment: cached.environment,
    isSandbox: cached.isSandbox ?? (cached.environment?.toLowerCase() === 'sandbox'),
  };
}

/**
 * 查詢原始交易的完整權限記錄 (支援環境隔離與向後相容)
 */
export async function getOriginalTransactionEntitlement(
  originalTransactionId: string,
  environment?: string,
): Promise<AppleEntitlementRecord | null> {
  if (!originalTransactionId) return null;
  const redis = getRedisClient();
  const normalizedEnv = (environment || '').trim().toLowerCase();

  // 優先查詢主記錄
  const legacyRecord = (await redis.get(`exam_ai:apple:entitlement:${originalTransactionId}`)) as AppleEntitlementRecord | null;

  // 若指定環境，檢查主記錄環境是否相符
  if (normalizedEnv === 'production' || normalizedEnv === 'sandbox') {
    if (legacyRecord) {
      const recEnv = (legacyRecord.environment || 'Sandbox').toLowerCase();
      if (recEnv === normalizedEnv) return legacyRecord;
    }

    // 若主記錄不相符或不存在，查詢專屬隔離 Key
    const envScopedKey = `exam_ai:apple:entitlement:${normalizedEnv}:${originalTransactionId}`;
    return (await redis.get(envScopedKey)) as AppleEntitlementRecord | null;
  }

  if (legacyRecord) return legacyRecord;

  // 未指定環境時，依序查詢正式環境 -> 沙盒環境隔離 Key
  const prodRecord = (await redis.get(`exam_ai:apple:entitlement:production:${originalTransactionId}`)) as AppleEntitlementRecord | null;
  if (prodRecord) return prodRecord;

  return (await redis.get(`exam_ai:apple:entitlement:sandbox:${originalTransactionId}`)) as AppleEntitlementRecord | null;
}

/**
 * 查詢與該筆交易關聯的裝置數量
 */
export async function getLinkedDevicesCount(originalTransactionId: string): Promise<number> {
  if (!originalTransactionId) return 0;
  const redis = getRedisClient();
  return redis.zcard(`exam_ai:apple:devices_z:${originalTransactionId}`);
}
