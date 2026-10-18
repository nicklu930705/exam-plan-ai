import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';
import { resolveAppleEnvironment } from '../lib/appleEnvironment';
import { getAppleServerApiClient } from '../lib/appleServerApi';
import { getRedisClient } from '../lib/redis';

/**
 * 考試計畫 AI - Apple Sandbox TEST Notification 專用受控診斷端點 (Phase 3.3c)
 *
 * 核心安全職責與規範：
 * 1. 嚴格鎖定環境：僅允許 APPLE_IAP_ENVIRONMENT=sandbox 且 APPLE_ALLOW_SANDBOX=true 下執行。正式環境一律 403 阻斷。
 * 2. 獨立管理密鑰：強制要求 SANDBOX_TEST_SECRET (至少 256-bit / 32 字元隨機值)，嚴禁重用 APP_SERVER_SECRET。
 * 3. 常數時間比對：使用 crypto.timingSafeEqual 與 SHA-256 哈希，杜絕時序攻擊與長度洩漏。
 * 4. 嚴格頻率限制：每分鐘最多允許 5 次呼叫，防範 Apple Server API 遭濫用或觸發限流。
 * 5. 機密零輸出：禁止於 HTTP Response 或 Logs 中輸出私鑰、完整 JWS 或管理憑證。
 * 6. 暫時性與清理：測試完成後可透過刪除環境變數即刻失效 (Fail-Closed 503)，並自程式碼完整刪除。
 */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // 1. CORS 標頭設定
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-Type, Authorization, X-Sandbox-Secret',
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      code: 'METHOD_NOT_ALLOWED',
      error: '僅支援 POST 方法。',
    });
  }

  // 2. 嚴格環境隔離檢驗：僅允許 Sandbox 後端且必須處於 Dry Run 保護模式下執行
  const envConfig = resolveAppleEnvironment();
  const isDryRun = process.env.APPLE_WEBHOOK_DRY_RUN !== 'false';

  if (!envConfig.valid || envConfig.targetRole !== 'sandbox' || !envConfig.allowSandbox) {
    return res.status(403).json({
      success: false,
      code: 'FORBIDDEN_ENVIRONMENT',
      error: '本診斷端點僅嚴格允許於 Apple Sandbox 環境執行，正式環境一律禁止。',
    });
  }

  if (!isDryRun) {
    return res.status(403).json({
      success: false,
      code: 'DRY_RUN_REQUIRED',
      error: '安全防護：診斷測試必須在 APPLE_WEBHOOK_DRY_RUN=true 乾跑模式下執行，以防非預期更動資料庫。',
    });
  }

  // 3. 管理密鑰驗證 (Fail-Closed: 嚴格要求 64 位元十六進位隨機字串，即 openssl rand -hex 32 產生之 256 位元金鑰)
  const configuredSecret = process.env.SANDBOX_TEST_SECRET?.trim();
  const HEX_64_REGEX = /^[0-9a-f]{64}$/i;

  if (!configuredSecret || !HEX_64_REGEX.test(configuredSecret)) {
    return res.status(503).json({
      success: false,
      code: 'DIAGNOSTIC_DISABLED',
      error: 'SANDBOX_TEST_SECRET 未配置或格式不符（必須為 64 個十六進位字元，即 openssl rand -hex 32 產生的 256 位元隨機金鑰），診斷功能處於安全關閉狀態。',
    });
  }

  const rawProvidedSecret =
    (req.headers['x-sandbox-secret'] as string) ||
    (req.headers['authorization'] as string)?.replace(/^Bearer\s+/i, '') ||
    '';
  const providedSecret = rawProvidedSecret.trim();

  if (!providedSecret) {
    return res.status(401).json({
      success: false,
      code: 'UNAUTHORIZED',
      error: '未提供 X-Sandbox-Secret 診斷授權金鑰。',
    });
  }

  if (!HEX_64_REGEX.test(providedSecret)) {
    return res.status(401).json({
      success: false,
      code: 'UNAUTHORIZED',
      error: '無效的 X-Sandbox-Secret 診斷授權金鑰格式（必須為 64 個十六進位字元）。',
    });
  }

  // 使用 SHA-256 哈希後進行常數時間比對，防止時序攻擊與長度洩漏
  const configuredHash = crypto.createHash('sha256').update(configuredSecret.toLowerCase()).digest();
  const providedHash = crypto.createHash('sha256').update(providedSecret.toLowerCase()).digest();
  const isMatch = crypto.timingSafeEqual(configuredHash, providedHash);

  if (!isMatch) {
    return res.status(401).json({
      success: false,
      code: 'UNAUTHORIZED',
      error: '無效的 X-Sandbox-Secret 診斷授權金鑰。',
    });
  }

  // 4. 速率限制 (每分鐘上限 5 次請求)
  try {
    const redis = getRedisClient();
    const minuteWindow = new Date().toISOString().slice(0, 16);
    const rateKey = `exam_ai:ratelimit:sandbox_test_api:${minuteWindow}`;
    const currentCount = await redis.incr(rateKey);
    if (currentCount === 1) {
      await redis.expire(rateKey, 65);
    }
    if (currentCount > 5) {
      return res.status(429).json({
        success: false,
        code: 'RATE_LIMIT_EXCEEDED',
        error: '診斷端點呼叫頻率過高（每分鐘上限 5 次），請稍候再試。',
      });
    }
  } catch (rateErr: any) {
    // Redis 異常時記錄警告，不中斷測試流程
    console.warn('[Sandbox Test API Rate Limit Warning]:', rateErr?.message || rateErr);
  }

  // 5. 執行診斷操作 (request 或 status)
  try {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>;
    const action = (body.action as string || '').trim().toLowerCase();

    const serverApiClient = getAppleServerApiClient();
    if (!serverApiClient.isConfigured()) {
      const status = serverApiClient.getStatus();
      return res.status(503).json({
        success: false,
        code: 'APPLE_API_NOT_CONFIGURED',
        error: status.reason || 'Apple App Store Server API 金鑰尚未配置。',
      });
    }

    if (action === 'request') {
      const result = await serverApiClient.requestTestNotification();
      return res.status(200).json({
        success: true,
        action: 'request',
        testNotificationToken: result.testNotificationToken,
        environment: 'sandbox',
        bundleId: envConfig.bundleId,
        message: '已向 Apple 成功請求發送 Sandbox TEST 通知，請觀察 Webhook Live Logs 或稍後以 status 查詢送達結果。',
      });
    }

    if (action === 'status') {
      const token = (body.testNotificationToken as string || '').trim();
      if (!token) {
        return res.status(400).json({
          success: false,
          code: 'MISSING_TEST_TOKEN',
          error: '查詢送達狀態時必須提供 testNotificationToken。',
        });
      }

      const statusResult = await serverApiClient.getTestNotificationStatus(token);
      const attempts = (statusResult.sendAttempts || []).map((attempt) => ({
        attemptDate: attempt.attemptDate,
        attemptDateISO: attempt.attemptDate ? new Date(attempt.attemptDate).toISOString() : null,
        sendAttemptResult: attempt.sendAttemptResult,
      }));

      return res.status(200).json({
        success: true,
        action: 'status',
        testNotificationToken: token,
        sendAttempts: attempts,
        hasSignedPayload: Boolean(statusResult.signedPayload),
        message: '已成功自 Apple 官方取得 TEST 通知送達狀態報告。',
      });
    }

    return res.status(400).json({
      success: false,
      code: 'INVALID_ACTION',
      error: '無效的操作項目，僅支援 action="request" 或 action="status"。',
    });
  } catch (error: any) {
    console.error('[Sandbox Test API Error]:', error?.message || '未知錯誤');
    return res.status(500).json({
      success: false,
      code: 'APPLE_API_ERROR',
      error: error?.message || '呼叫 Apple Server API 時發生未預期錯誤。',
    });
  }
}
