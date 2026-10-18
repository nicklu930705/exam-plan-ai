import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  acquireWebhookIdempotency,
  completeWebhookIdempotency,
  getAppleNotificationVerifier,
  releaseWebhookIdempotency,
  getAppleWebhookEventHandler,
} from '../lib/appleWebhookHandler';
import '../lib/appleSubscriptionSync';

/**
 * 考試計畫 AI - Apple App Store Server Notifications V2 Webhook 端點
 *
 * 路徑：POST /api/apple-webhook
 *
 * 核心原則與防護：
 * 1. 僅允許 POST 方法，限制 30 KB Payload 避免阻斷服務。
 * 2. 嚴禁接受未簽章或未通過 Apple 官方根憑證鏈檢驗之通知。
 * 3. 實作 notificationUUID 冪等狀態機 (processing / completed / released)，防範重複推播與並行競爭。
 * 4. 處理失敗時主動釋放 processing 鎖，確保 Apple 在 36 小時重試窗口內能安全重新處理。
 * 5. Phase 3.1 採用受控 Dry-Run 處理器，不直接寫入真實會員資料庫。
 */

const MAX_PAYLOAD_BYTES = 30 * 1024; // 30 KB

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // 1. 設定通用 CORS 跨來源標頭
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-Type, Authorization',
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

  // 2. 檢查請求大小
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
    const signedPayload = (body.signedPayload as string) || (typeof req.body === 'string' ? req.body : '');

    if (!signedPayload || typeof signedPayload !== 'string' || signedPayload.trim().length === 0) {
      return res.status(400).json({
        success: false,
        code: 'MISSING_SIGNED_PAYLOAD',
        error: '未提供 Apple Webhook signedPayload 簽署字串。',
      });
    }

    // 3. 官方 SignedDataVerifier 密碼學驗證
    const verifier = getAppleNotificationVerifier();
    const verified = await verifier.verifyAndDecode(signedPayload);

    if (!verified.isValid) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_NOTIFICATION',
        error: verified.errorMessage || 'Apple Webhook 通知簽章驗證未通過。',
      });
    }

    const notificationUUID = verified.notificationUUID;
    const isDryRun = process.env.APPLE_WEBHOOK_DRY_RUN !== 'false';

    // 4. 冪等狀態檢查 (processing / completed)
    if (notificationUUID) {
      const lockResult = await acquireWebhookIdempotency(notificationUUID, { isDryRun });
      if (!lockResult.acquired) {
        if (lockResult.state === 'completed') {
          // 已經成功處理完畢：回傳 HTTP 200 OK，通知 Apple 不需再重試
          return res.status(200).json({
            success: true,
            duplicate: true,
            state: 'completed',
            notificationUUID,
            message: lockResult.message || '此通知先前已接收並處理完成。',
          });
        }

        // 仍在 processing 中：嚴禁回傳 200！
        // 若第一筆並行處理隨後失敗，回傳 200 會使 Apple 誤認已處理成功而停止重送。
        // 回傳 503 Service Unavailable 並附帶 Retry-After 標頭，通知 Apple 稍後重試。
        res.setHeader('Retry-After', '5');
        return res.status(503).json({
          success: false,
          code: 'CONCURRENT_PROCESSING',
          state: 'processing',
          notificationUUID,
          error: '此通知目前正由另一並行工作處理中，請稍後重試。',
        });
      }
    }

    // 5. 調用受控事件處理器
    let handleResult;
    try {
      const eventHandler = getAppleWebhookEventHandler();
      handleResult = await eventHandler.handle(verified);

      if (!handleResult.success) {
        throw new Error(handleResult.reason || '事件處理器回報失敗。');
      }

      // 處理成功：標記為 completed (保存 3 天，Dry-Run 模式使用獨立命名空間)
      if (notificationUUID) {
        await completeWebhookIdempotency(notificationUUID, { isDryRun });
      }

      return res.status(200).json({
        success: true,
        notificationUUID,
        notificationType: verified.notificationType,
        subtype: verified.subtype,
        action: handleResult.action,
        message: handleResult.reason || 'Apple 通知處理完成。',
      });
    } catch (processErr: any) {
      console.error('[Apple Webhook] 事件處理異常:', processErr?.message || processErr);

      // 處理失敗：釋放 processing 鎖，確保 Apple 後續重試時能順利重新進入
      if (notificationUUID) {
        await releaseWebhookIdempotency(notificationUUID, { isDryRun });
      }

      return res.status(500).json({
        success: false,
        code: 'PROCESSING_FAILED',
        error: '處理 Apple 通知時伺服器發生暫時性錯誤，已釋放鎖定以供 Apple 重試。',
      });
    }
  } catch (error: any) {
    console.error('[Apple Webhook 端點未預期錯誤]:', error?.message || error);
    return res.status(500).json({
      success: false,
      code: 'INTERNAL_SERVER_ERROR',
      error: '伺服端處理 Apple 通知時發生未預期錯誤。',
    });
  }
}
