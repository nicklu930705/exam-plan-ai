import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getTransactionVerifier } from '../lib/appleIap';
import { getAppleServerApiClient } from '../lib/appleServerApi';
import { reconcileSubscriptionWithApple } from '../lib/appleSubscriptionSync';
import {
  generateEntitlementProofToken,
  getOriginalTransactionEntitlement,
  getUserEntitlement,
  saveVerifiedEntitlement,
  verifyEntitlementProofToken,
} from '../lib/entitlement';
import { resolveUserIdentity } from '../lib/identity';
import { getRedisClient } from '../lib/redis';
import { getTaipeiDateParts } from '../lib/timezone';

/**
 * 考試計畫 AI - 會員狀態查詢端點 (GET / POST /api/subscription-status)
 *
 * 核心安全職責：
 * 1. 提供 App 查詢當前可信任的會員方案 (Free, Pro, Lifetime)、有效期限及狀態 (active, expired, revoked, grace_period, none)。
 * 2. 嚴格防偽防冒充：
 *    - 不得僅憑可任意變造之 X-Client-Device-Id 就回傳或綁定他人付費權益（無憑證者安全回傳 Free）。
 *    - 不得接受單獨傳入 originalTransactionId 即授權付費權益。
 * 3. 雙軌安全身分憑證：
 *    - 軌道 A (Proof Token)：驗證 HMAC 數位簽章與效期，自 Redis 讀取該裝置即時權益。
 *    - 軌道 B (Apple JWS)：當 Proof Token 遺失或到期，以最新 Apple StoreKit 2 JWS 為權威依據進行官方驗證並自動重新簽發 Proof Token。
 * 4. 速率限制 (Rate Limit)：防止暴力撞庫或惡意刷 API (每分鐘上限 30 次)。
 * 5. 安全降級：伺服端或 Redis 例外時平滑降級，不回傳崩潰資訊或洩漏機密。
 */

const MAX_PAYLOAD_BYTES = 15 * 1024; // 15 KB
const MAX_REQUESTS_PER_MINUTE = 30;
const PROOF_TOKEN_REFRESH_THRESHOLD_MS = 2 * 86400 * 1000; // 小於 48 小時自動換發新 Token

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const now = Date.now();

  // 1. 設定通用 CORS 標頭
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-Type, Authorization, X-Client-Device-Id, X-Device-Id, X-Apple-Proof-Token, X-Apple-JWS, X-Original-Transaction-Id, X-Apple-Reconcile',
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      code: 'METHOD_NOT_ALLOWED',
      error: '僅支援 GET 或 POST 方法。',
      serverTime: now,
    });
  }

  // 檢查請求大小
  const contentLength = Number(req.headers['content-length'] ?? 0);
  if (contentLength > MAX_PAYLOAD_BYTES) {
    return res.status(413).json({
      success: false,
      code: 'PAYLOAD_TOO_LARGE',
      error: `請求內文過大 (超過 ${MAX_PAYLOAD_BYTES / 1024} KB 上限)。`,
      serverTime: now,
    });
  }

  try {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>;

    // 2. 解析使用者身分識別碼 (Device ID)
    const deviceIdHeader =
      (req.headers['x-client-device-id'] as string) ||
      (req.headers['x-device-id'] as string) ||
      (body.deviceId as string);
    const userId = (deviceIdHeader && typeof deviceIdHeader === 'string' && deviceIdHeader.trim().length >= 4)
      ? deviceIdHeader.trim()
      : 'anonymous_visitor';

    // 3. 速率限制檢查 (Rate Limiting: 30 次 / 分鐘)
    const redis = getRedisClient();
    const { minuteKey } = getTaipeiDateParts();
    const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    const rateLimitKey = `exam_ai:ratelimit:status:${userId !== 'anonymous_visitor' ? userId : clientIp}:${minuteKey}`;

    try {
      const count = await redis.incr(rateLimitKey);
      if (count === 1) {
        await redis.expire(rateLimitKey, 60);
      }
      if (count > MAX_REQUESTS_PER_MINUTE) {
        return res.status(429).json({
          success: false,
          code: 'RATE_LIMIT_EXCEEDED',
          error: '查詢過於頻繁（每分鐘上限 30 次），請於 1 分鐘後再試。',
          tier: 'free',
          status: 'none',
          serverTime: now,
        });
      }
    } catch {
      // 若 Redis 速率限制發生問題，不阻斷正常功能，平滑繼續
    }

    // 4. 擷取驗證憑證 (嚴格自 Header 或 POST 內文讀取，禁止透過 URL Query 傳輸以防出現在伺服器 Access Log)
    // A. Proof Token
    const authHeader = req.headers.authorization;
    let proofToken: string | undefined = undefined;
    if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      proofToken = authHeader.slice(7).trim();
    } else if (req.headers['x-apple-proof-token']) {
      proofToken = String(req.headers['x-apple-proof-token']).trim();
    } else if (body.proofToken) {
      proofToken = String(body.proofToken).trim();
    }

    // B. Apple StoreKit 2 Signed JWS
    const signedTransaction =
      (body.signedTransaction as string) ||
      (req.headers['x-apple-jws'] as string) ||
      (body.appleJws as string);

    // C. 查詢之 originalTransactionId (若有指定)
    const targetOriginalTxId =
      (req.headers['x-original-transaction-id'] as string) ||
      (body.originalTransactionId as string);

    // 5. 憑證驗證與身分授權評估

    // ────── 情境 1: 僅提供原始交易 ID，卻無任何 Proof Token 或 Apple JWS ──────
    if (targetOriginalTxId && !proofToken && !signedTransaction) {
      return res.status(401).json({
        success: false,
        code: 'UNAUTHORIZED_TRANSACTION_QUERY',
        error: '不得僅憑交易編號查詢會員狀態，請提供有效之 Proof Token 或 Apple 交易簽署憑證 (JWS)。',
        tier: 'free',
        status: 'none',
        isVerified: false,
        serverTime: now,
      });
    }

    // ────── 情境 2: 裝置提供 Proof Token ──────
    if (proofToken) {
      const proofValidation = await verifyEntitlementProofToken(proofToken, userId !== 'anonymous_visitor' ? userId : undefined);

      if ((proofValidation.valid || proofValidation.canRenew) && proofValidation.userId) {
        const authenticatedUserId = proofValidation.userId;
        const boundOriginalTxId = proofValidation.originalTransactionId;

        // 若呼叫者指定了 targetOriginalTxId，必須確認該交易屬於呼叫者 (防範跨用戶探測)
        if (targetOriginalTxId && targetOriginalTxId !== boundOriginalTxId) {
          const userTxns = (await redis.smembers(`exam_ai:user:${authenticatedUserId}:apple_txns`)) as string[];
          const hasTxn = Array.isArray(userTxns) && userTxns.includes(targetOriginalTxId);
          if (!hasTxn) {
            return res.status(403).json({
              success: false,
              code: 'FORBIDDEN_TRANSACTION',
              error: '此交易不屬於目前已驗證之身分。',
              tier: 'free',
              status: 'none',
              isVerified: false,
              serverTime: now,
            });
          }
        }

        const effectiveTxId = targetOriginalTxId || boundOriginalTxId;

        // 讀取該使用者的最新有效權限 (支援跨交易聚合與快取遺失自我修復)
        const userEntitlement = await getUserEntitlement(authenticatedUserId);
        const mainRecord = effectiveTxId ? await getOriginalTransactionEntitlement(effectiveTxId) : null;

        // 判斷狀態
        let responseTier: 'free' | 'pro' | 'lifetime' = 'free';
        let responseStatus: 'active' | 'expired' | 'revoked' | 'grace_period' | 'none' = 'none';

        if (userEntitlement.status === 'active' && userEntitlement.isVerified) {
          responseTier = userEntitlement.tier;
          responseStatus = 'active';

          // 檢查是否處於寬限期標記
          if (mainRecord && (mainRecord as any).inGracePeriod) {
            responseStatus = 'grace_period';
          }
        } else if (mainRecord?.status === 'revoked' || userEntitlement.status === 'revoked') {
          responseTier = 'free';
          responseStatus = 'revoked';
        } else if (mainRecord?.status === 'expired' || userEntitlement.status === 'expired') {
          responseTier = 'free';
          responseStatus = 'expired';
        } else {
          responseTier = 'free';
          responseStatus = 'none';
        }

        // 權杖自我輪轉 (Token Refresh)：若剩餘有效期限小於閾值 (48 小時) 或已標記為可續約換發 (canRenew)，主動發放新權杖
        let activeProofToken = proofToken;
        if (
          responseStatus === 'active' &&
          boundOriginalTxId &&
          (proofValidation.canRenew ||
            (proofValidation.expiresAt && proofValidation.expiresAt - now < PROOF_TOKEN_REFRESH_THRESHOLD_MS))
        ) {
          activeProofToken = generateEntitlementProofToken(
            authenticatedUserId,
            boundOriginalTxId,
            userEntitlement.expiresAt,
          );
        }

        const effectiveWillRenew =
          responseTier === 'lifetime'
            ? undefined
            : userEntitlement.willRenew !== undefined
            ? userEntitlement.willRenew
            : mainRecord?.willRenew !== undefined
            ? mainRecord.willRenew
            : undefined;

        return res.status(200).json({
          success: true,
          tier: responseTier,
          status: responseStatus,
          productId: userEntitlement.productId || mainRecord?.productId,
          originalTransactionId: effectiveTxId,
          expiresAt: userEntitlement.expiresAt || mainRecord?.expiresDate || null,
          willRenew: effectiveWillRenew,
          proofToken: responseStatus === 'active' ? activeProofToken : undefined,
          isVerified: responseTier !== 'free' && responseStatus === 'active',
          serverTime: now,
        });
      }

      // Proof Token 驗證未通過 (簽章無效、逾期或身分不符)
      // 若同時帶有 Apple JWS，讓其流向下方情境 3 進行憑證自我修復續期；否則直接安全回傳 Free
      if (!signedTransaction) {
        const isRevoked = proofValidation.isRevoked || proofValidation.reason?.includes('撤銷') || proofValidation.reason?.includes('退款');
        const isExpired = !isRevoked && (proofValidation.reason?.includes('逾期') || (proofValidation.expiresAt && proofValidation.expiresAt < now));
        return res.status(200).json({
          success: true,
          tier: 'free',
          status: isRevoked ? 'revoked' : isExpired ? 'expired' : 'none',
          isVerified: false,
          message: proofValidation.reason || '驗證權杖無效或已過期。',
          serverTime: now,
        });
      }
    }

    // ────── 情境 3: Proof Token 缺失或過期，但裝置提供最新 Apple JWS (自我修復與簽發新權杖) ──────
    if (signedTransaction && typeof signedTransaction === 'string' && signedTransaction.trim().length > 0) {
      const verifier = getTransactionVerifier();
      const verifyResult = await verifier.verify(signedTransaction.trim(), { allowSandbox: true });

      if (!verifyResult.isValid) {
        return res.status(400).json({
          success: false,
          code: 'INVALID_TRANSACTION',
          error: verifyResult.errorMessage || 'Apple 交易憑證數位簽章驗證失敗。',
          tier: 'free',
          status: 'none',
          isVerified: false,
          serverTime: now,
        });
      }

      // 檢查交易所有權 (若使用者帶有 targetOriginalTxId，比對是否一致)
      if (targetOriginalTxId && verifyResult.originalTransactionId !== targetOriginalTxId) {
        return res.status(403).json({
          success: false,
          code: 'FORBIDDEN_TRANSACTION',
          error: 'Apple 交易憑證與指定查詢的交易識別碼不符。',
          tier: 'free',
          status: 'none',
          isVerified: false,
          serverTime: now,
        });
      }

      // 1. 檢查 Redis 既有主記錄是否早已確認為撤銷/退款
      const existingRecord = await getOriginalTransactionEntitlement(verifyResult.originalTransactionId!);
      if (existingRecord?.status === 'revoked') {
        return res.status(200).json({
          success: true,
          tier: 'free',
          status: 'revoked',
          productId: verifyResult.productId,
          originalTransactionId: verifyResult.originalTransactionId,
          isVerified: false,
          serverTime: now,
        });
      }

      // 2. 若 Apple Server API 已配置，主動查詢 Apple 最新權威狀態 (解決單純依賴靜態 JWS 的盲區)
      const serverApiClient = getAppleServerApiClient();
      if (serverApiClient.isConfigured()) {
        try {
          const reconcileRes = await reconcileSubscriptionWithApple(verifyResult.originalTransactionId!);
          if (reconcileRes.success && reconcileRes.status === 'revoked') {
            return res.status(200).json({
              success: true,
              tier: 'free',
              status: 'revoked',
              productId: verifyResult.productId,
              originalTransactionId: verifyResult.originalTransactionId,
              isVerified: false,
              serverTime: now,
            });
          }
          if (reconcileRes.success && reconcileRes.status === 'expired') {
            return res.status(200).json({
              success: true,
              tier: 'free',
              status: 'expired',
              productId: verifyResult.productId,
              originalTransactionId: verifyResult.originalTransactionId,
              isVerified: false,
              serverTime: now,
            });
          }
        } catch (apiErr) {
          console.warn('[會員查詢] 呼叫 Apple Server API 主動補查失敗，依驗證憑證與 Redis 主記錄處理:', apiErr);
        }
      }

      // 3. 儲存至 Redis (整合防退款與到期時序保護)
      const saveRes = await saveVerifiedEntitlement(userId, verifyResult);

      if (verifyResult.status === 'revoked' || saveRes.effectiveStatus === 'revoked') {
        return res.status(200).json({
          success: true,
          tier: 'free',
          status: 'revoked',
          productId: verifyResult.productId,
          originalTransactionId: verifyResult.originalTransactionId,
          isVerified: false,
          serverTime: now,
        });
      }

      if (
        saveRes.effectiveStatus === 'expired' ||
        (verifyResult.status === 'expired' && saveRes.effectiveStatus !== 'active')
      ) {
        return res.status(200).json({
          success: true,
          tier: 'free',
          status: 'expired',
          productId: verifyResult.productId,
          originalTransactionId: verifyResult.originalTransactionId,
          expiresAt: verifyResult.expiresDate,
          isVerified: false,
          serverTime: now,
        });
      }

      // 簽發全新有效 Proof Token (採用最新有效續約到期日)
      const authoritativeExpiresDate =
        saveRes.effectiveExpiresDate || existingRecord?.expiresDate || verifyResult.expiresDate;
      const freshProofToken = generateEntitlementProofToken(
        userId,
        verifyResult.originalTransactionId!,
        authoritativeExpiresDate,
      );

      const effectiveWillRenew =
        verifyResult.tier === 'lifetime'
          ? undefined
          : saveRes.effectiveWillRenew !== undefined
          ? saveRes.effectiveWillRenew
          : existingRecord?.willRenew !== undefined
          ? existingRecord.willRenew
          : undefined;

      const effectiveTier = saveRes.effectiveTier !== 'free' ? saveRes.effectiveTier : verifyResult.tier;

      return res.status(200).json({
        success: true,
        tier: effectiveTier,
        status: 'active',
        productId: verifyResult.productId,
        originalTransactionId: verifyResult.originalTransactionId,
        expiresAt: authoritativeExpiresDate || null,
        willRenew: effectiveWillRenew,
        proofToken: freshProofToken,
        isVerified: effectiveTier !== 'free',
        serverTime: now,
      });
    }

    // ────── 情境 4: 完全未附帶任何憑據 (僅有或無 X-Client-Device-Id) ──────
    // 嚴格安全原則：絕不信任未附帶憑證的隨機 Device ID，安全回傳 Free，杜絕外洩其他付費使用者資料！
    return res.status(200).json({
      success: true,
      tier: 'free',
      status: 'none',
      isVerified: false,
      message: '未附帶會員憑據，回傳免費方案。',
      serverTime: now,
    });
  } catch (error: any) {
    console.error('[Subscription Status API Error]:', error?.message || error);
    return res.status(500).json({
      success: false,
      code: 'STATUS_SERVICE_ERROR',
      error: '伺服端處理會員狀態查詢時發生暫時性錯誤，請稍後重試。',
      serverTime: now,
    });
  }
}
