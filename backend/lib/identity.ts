import crypto from 'node:crypto';
import type { VercelRequest } from '@vercel/node';

/**
 * 考試計畫 AI - 使用者身分解析與 Apple 交易憑證驗證模組
 *
 * 【匿名身分方案說明與其安全邊界】：
 * 1. 現狀：專案目前無帳號密碼登入系統。
 * 2. 方案：客戶端於首次啟動時產生並持久化儲存「App 安裝 UUID」（X-Client-Device-Id）。
 * 3. 限制與防護警示：
 *    - 單靠此裝置 UUID 無法防禦惡意使用者「刪除 App 重新安裝」以獲取新額度。
 *    - 亦無法防禦具備逆向工程能力者偽造 HTTP 標頭更換隨機 UUID。
 *    - 配合 IP 每分鐘頻率限制（Rate Limit）與每日/每月伺服器總成本硬上限（Budget Limit），
 *      在無需使用者輸入帳密的前提下，保護 OpenAI 不被無限制盜刷。
 *
 * 【會員狀態防偽造原則】：
 * 1. 嚴格不信任前端傳來的 `plan="pro"` 或 `tier="pro"` 字串。
 * 2. 只有通過 Apple App Store 伺服端收據/JWS 驗證的請求，才賦予 Pro 每日 15 次額度。
 * 3. 尚未完成伺服端驗證的未授權請求，一律強制限制為 Free 免費版（每日 3 次）。
 */

export interface UserIdentity {
  userId: string;
  tier: 'free' | 'pro';
  isAnonymous: boolean;
  isVerifiedPro: boolean;
  identitySource: 'device_uuid' | 'ip_hash';
  appleTransactionId?: string;
}

import { getTransactionVerifier } from './appleIap';
import {
  getUserEntitlement,
  saveVerifiedEntitlement,
  verifyEntitlementProofToken,
} from './entitlement';

/**
 * Apple 伺服端交易驗證介面（支援 StoreKit 2 JWS 與 App Store Server API 擴充）
 */
export interface IAppleServerValidator {
  verify(transactionId?: string, jwsPayload?: string): Promise<{
    isValid: boolean;
    productId?: string;
    expiresAt?: string;
    reason?: string;
  }>;
}

/**
 * 官方 StoreKit 2 交易驗證器（嚴格模式）
 * 必須使用 Apple 官方 SignedDataVerifier 驗證 JWS 數位簽章。
 * 嚴禁信任未經簽章之明文交易 ID。
 */
export class AppleServerValidator implements IAppleServerValidator {
  async verify(transactionId?: string, jwsPayload?: string): Promise<{
    isValid: boolean;
    productId?: string;
    expiresAt?: string;
    reason?: string;
  }> {
    if (!jwsPayload && !transactionId) {
      return { isValid: false, reason: '未提供 Apple 交易識別碼或 JWS 憑證。' };
    }

    // 若有 JWS 簽章憑證，透過官方 StoreKit 2 驗證器進行嚴格驗證
    if (jwsPayload && typeof jwsPayload === 'string' && jwsPayload.trim().length > 0) {
      try {
        const verifier = getTransactionVerifier();
        const result = await verifier.verify(jwsPayload, { allowSandbox: true });
        if (result.isValid && result.status === 'active') {
          return {
            isValid: true,
            productId: result.productId,
            expiresAt: result.expiresDate ? new Date(result.expiresDate).toISOString() : undefined,
          };
        }
        return {
          isValid: false,
          reason: result.errorMessage || `Apple 交易狀態非有效（狀態：${result.status}）。`,
        };
      } catch (err: any) {
        return { isValid: false, reason: err?.message || 'Apple JWS 驗證過程發生未預期錯誤。' };
      }
    }

    // 單憑未簽章的明文 Transaction ID，無法防禦重放與偽造，予以拒絕
    return {
      isValid: false,
      reason: '單憑交易 ID 無法證明交易真實性，必須提供 Apple 簽署之 JWS 交易憑證。',
    };
  }
}

const appleValidator: IAppleServerValidator = new AppleServerValidator();

/**
 * 從 HTTP 請求中解析使用者身分與會員權限
 */
export async function resolveUserIdentity(
  req: VercelRequest,
  options: { skipJwsVerification?: boolean } = {},
): Promise<UserIdentity> {
  const headers = req.headers || {};
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>;

  // 1. 取得裝置 UUID
  const rawDeviceId =
    (headers['x-client-device-id'] as string) ||
    (headers['x-device-id'] as string) ||
    body.deviceId ||
    body.userId;

  let userId = '';
  let identitySource: 'device_uuid' | 'ip_hash' = 'device_uuid';

  if (rawDeviceId && typeof rawDeviceId === 'string') {
    // 過濾非法字元，僅保留英數字、連字號與底線（長度 8 到 64）
    const sanitized = rawDeviceId.trim().replace(/[^a-zA-Z0-9_-]/g, '');
    if (sanitized.length >= 8 && sanitized.length <= 64) {
      userId = sanitized.startsWith('dev_') ? sanitized : `dev_${sanitized}`;
    }
  }

  // 2. 若無有效裝置 UUID，使用 IP + User-Agent 之 SHA-256 雜湊值做為暫時識別碼
  if (!userId) {
    const forwardedFor = headers['x-forwarded-for'];
    const ip = typeof forwardedFor === 'string'
      ? forwardedFor.split(',')[0].trim()
      : req.socket?.remoteAddress || 'unknown-ip';
    const ua = (headers['user-agent'] as string) || '';
    const hash = crypto.createHash('sha256').update(`${ip}:${ua}`).digest('hex').slice(0, 24);
    userId = `ip_${hash}`;
    identitySource = 'ip_hash';
  }

  // 3. 檢查使用者是否已在 Redis 具備經伺服端驗證的付費權益
  let tier: 'free' | 'pro' = 'free';
  let isVerifiedPro = false;

  try {
    const existingEntitlement = await getUserEntitlement(userId);
    if (existingEntitlement.isVerified && existingEntitlement.status === 'active') {
      tier = 'pro';
      isVerifiedPro = true;
    }
  } catch {
    // Redis 暫時異常時繼續後續檢查
  }

  // 4. 若尚未解鎖，檢查請求是否帶有有效的防偽 Proof Token
  const proofToken = (headers['x-apple-proof-token'] as string) || body.proofToken;
  if (!isVerifiedPro && proofToken) {
    const proofCheck = await verifyEntitlementProofToken(proofToken, userId);
    if (proofCheck.valid) {
      tier = 'pro';
      isVerifiedPro = true;
    }
  }

  // 5. 驗證直接隨請求發送的 Apple JWS 交易憑證 (若未略過)
  const appleTransactionId =
    (headers['x-apple-transaction-id'] as string) ||
    body.appleTransactionId ||
    body.transactionId;
  const appleJws =
    (headers['x-apple-jws'] as string) ||
    body.appleJws ||
    body.signedTransaction;

  if (!isVerifiedPro && appleJws && !options.skipJwsVerification) {
    try {
      const verifier = getTransactionVerifier();
      const vRes = await verifier.verify(appleJws, { allowSandbox: true });
      if (vRes.isValid && vRes.status === 'active') {
        tier = 'pro';
        isVerifiedPro = true;
        await saveVerifiedEntitlement(userId, vRes);
      }
    } catch {
      // 忽略快取更新失敗
    }
  }

  // 6. 宣告 Pro 但無法提供有效驗證憑證者，強制鎖定為 Free 額度
  if (!isVerifiedPro) {
    if (body.tier === 'pro' || body.plan === 'pro' || headers['x-user-tier'] === 'pro' || appleTransactionId) {
      console.warn(`[身分安全] 用戶「${userId}」自稱 Pro 但無有效 Apple 伺服端憑證，強制鎖定為 Free 額度。`);
    }
    tier = 'free';
    isVerifiedPro = false;
  }

  return {
    userId,
    tier,
    isAnonymous: true,
    isVerifiedPro,
    identitySource,
    appleTransactionId,
  };
}
