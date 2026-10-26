import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getTransactionVerifier } from '../lib/appleIap';
import { generateEntitlementProofToken, saveVerifiedEntitlement } from '../lib/entitlement';
import { resolveUserIdentity } from '../lib/identity';
import { getRedisClient } from '../lib/redis';

/**
 * 考試計畫 AI - Apple StoreKit 2 交易驗證專用端點 (POST /api/verify-transaction)
 *
 * 職責：
 * 1. 接收客戶端上傳之 Apple StoreKit 2 JWS 簽署交易憑證。
 * 2. 透過 Apple 官方 App Store Server Library 驗證數位簽章、憑證鏈、Bundle ID 與方案。
 * 3. 檢查退款撤銷與訂閱過期狀態。
 * 4. 將驗證通過之付費權益與匿名使用者（X-Client-Device-Id）綁定並存入 Redis。
 * 5. 簽發防偽 HMAC-SHA256 Proof Token，阻絕任意偽造交易 ID。
 * 6. 支援請求冪等快取，不重複執行重複驗證。
 * 7. 錯誤回應安全過濾，嚴禁外洩私鑰或底層堆疊資訊。
 */

const MAX_PAYLOAD_BYTES = 15 * 1024; // 15 KB

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // 1. 設定通用 CORS 標頭
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-Type, Authorization, X-Client-Device-Id, X-Device-Id, X-Idempotency-Key, X-Apple-JWS, X-Apple-Transaction-Id, X-User-Tier',
  );

  // 預檢請求處理 (OPTIONS)
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 僅允許 POST 請求
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      code: 'METHOD_NOT_ALLOWED',
      error: '僅支援 POST 方法。',
    });
  }

  // 2. 請求內文大小限制
  const contentLength = Number(req.headers['content-length'] ?? 0);
  if (contentLength > MAX_PAYLOAD_BYTES) {
    return res.status(413).json({
      success: false,
      code: 'PAYLOAD_TOO_LARGE',
      error: `請求內文過大 (超過 ${MAX_PAYLOAD_BYTES / 1024} KB 上限)。`,
    });
  }

  try {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>;

    // 3. 取得 Apple 簽署交易 JWS
    const signedTransaction =
      (body.signedTransaction as string) ||
      (req.headers['x-apple-jws'] as string) ||
      (body.appleJws as string);

    if (!signedTransaction || typeof signedTransaction !== 'string' || signedTransaction.trim().length === 0) {
      return res.status(400).json({
        success: false,
        code: 'MISSING_TRANSACTION',
        error: '未提供 Apple 簽署交易憑證 (signedTransaction 或 X-Apple-JWS)。',
      });
    }

    // 4. 解析匿名使用者身分
    const identity = await resolveUserIdentity(req, { skipJwsVerification: true });
    const userId = identity.userId;

    // 5. 冪等鍵處理 (Idempotency Key)
    const idempotencyKey =
      (req.headers['x-idempotency-key'] as string) ||
      body.idempotencyKey;

    const redis = getRedisClient();
    const idempRedisKey = idempotencyKey ? `exam_ai:idempotency:verify:${idempotencyKey.trim()}` : null;

    if (idempRedisKey) {
      try {
        const cached = await redis.get(idempRedisKey);
        if (cached) {
          const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
          return res.status(200).json({ ...parsed, cached: true });
        }
      } catch {
        // 冪等快取讀取失敗時略過直接進行驗證
      }
    }

    // 6. 執行 Apple JWS 交易驗證
    const verifier = getTransactionVerifier();
    const result = await verifier.verify(signedTransaction, { allowSandbox: true });

    // 驗證失敗 (簽章偽造、Bundle ID 錯誤、未知商品等)
    if (!result.isValid) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_TRANSACTION',
        error: result.errorMessage || 'Apple 交易憑證驗證未通過。',
        tier: 'free',
        status: 'invalid',
      });
    }

    // 交易已被 Apple 撤銷或退款
    if (result.status === 'revoked') {
      try {
        await saveVerifiedEntitlement(userId, result);
      } catch (saveErr) {
        console.warn('[交易儲存警示] 撤銷記錄寫入失敗:', saveErr);
      }

      return res.status(200).json({
        success: false,
        code: 'TRANSACTION_REVOKED',
        error: '此交易已被 Apple 撤銷或退款。',
        tier: 'free',
        status: 'revoked',
        productId: result.productId,
        transactionId: result.transactionId,
        revocationDate: result.revocationDate,
      });
    }

    // 訂閱已過期
    if (result.status === 'expired') {
      try {
        await saveVerifiedEntitlement(userId, result);
      } catch (saveErr) {
        console.warn('[交易儲存警示] 到期記錄寫入失敗:', saveErr);
      }

      return res.status(200).json({
        success: false,
        code: 'SUBSCRIPTION_EXPIRED',
        error: '此訂閱方案已到期。',
        tier: 'free',
        status: 'expired',
        productId: result.productId,
        transactionId: result.transactionId,
        expiresDate: result.expiresDate,
      });
    }

    // 7. 驗證成功且有效 (active Pro / Lifetime)
    const saveResult = await saveVerifiedEntitlement(userId, result);

    // 若伺服端確認此交易已被退款或撤銷 (例如舊 JWS 嘗試重放已退款收據)
    if (saveResult.effectiveStatus === 'revoked') {
      return res.status(200).json({
        success: false,
        code: 'TRANSACTION_REVOKED',
        error: '此交易已被 Apple 撤銷或退款。',
        tier: 'free',
        status: 'revoked',
        productId: result.productId,
        transactionId: result.transactionId,
      });
    }

    // 產生防偽綁定權杖 (Proof Token)
    const proofToken = generateEntitlementProofToken(
      userId,
      result.originalTransactionId!,
      result.expiresDate,
      result.environment,
    );

    const responsePayload = {
      success: true,
      tier: result.tier,
      status: 'active',
      productId: result.productId,
      transactionId: result.transactionId,
      originalTransactionId: result.originalTransactionId,
      purchaseDate: result.purchaseDate,
      expiresDate: result.expiresDate,
      environment: result.environment,
      isSandbox: result.isSandbox ?? (result.environment?.toLowerCase() === 'sandbox'),
      proofToken,
      message: 'Apple 交易驗證成功，會員專屬權益已啟用。',
    };

    // 寫入冪等快取 (最長 10 分鐘，但絕不超過訂閱到期時間)
    if (idempRedisKey) {
      try {
        let idempTtl = 600;
        if (result.tier !== 'lifetime' && result.expiresDate) {
          const remainingSec = Math.ceil((result.expiresDate - Date.now()) / 1000);
          idempTtl = Math.max(1, Math.min(600, remainingSec));
        }
        await redis.set(idempRedisKey, responsePayload, { ex: idempTtl });
      } catch {
        // 忽略快取寫入失敗
      }
    }

    return res.status(200).json(responsePayload);
  } catch (error: any) {
    console.error('[Verify Transaction API Error]:', error?.message || error);
    return res.status(500).json({
      success: false,
      code: 'VERIFICATION_SERVICE_ERROR',
      error: '伺服端處理交易驗證時發生暫時性錯誤，請稍後重試。',
    });
  }
}
