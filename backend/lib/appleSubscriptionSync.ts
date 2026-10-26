import {
  EXPECTED_BUNDLE_ID,
  isTransactionEnvironmentAllowed,
  resolveAppleEnvironment,
} from './appleEnvironment';
import {
  AppleEntitlementRecord,
  getOriginalTransactionEntitlement,
  syncUserDeviceEffectiveEntitlement,
  UserEntitlementCache,
} from './entitlement';
import { getRedisClient, SAVE_ENTITLEMENT_OCC_LUA } from './redis';
import {
  evaluateSubscriptionStateTransition,
  IAppleWebhookEventHandler,
  StateTransitionResult,
  VerifiedAppleNotification,
  setDefaultAppleWebhookEventHandler,
  setCustomAppleWebhookEventHandler,
  getAppleWebhookEventHandler,
  getAppleNotificationVerifier,
} from './appleWebhookHandler';
import { getAppleServerApiClient } from './appleServerApi';

/**
 * 考試計畫 AI - Apple 訂閱與會員狀態 Redis 同步核心模組 (Phase 3.2)
 *
 * 核心安全規範：
 * 1. 每次變更必須以 Apple 已驗證的交易憑證 (JWS) 或 Webhook 事件為唯一權威依據。
 * 2. 嚴禁僅憑客戶端可任意修改的 deviceId 或 originalTransactionId 宣告或變更會員資格。
 * 3. 嚴禁舊退款或過期通知覆蓋使用者之後的最新合法交易。
 * 4. 關閉自動續約 (autoRenewStatus=0) 絕不提前撤銷尚未到期的 Pro。
 * 5. 寬限期 (Grace Period) 必須依 Apple 可信狀態 (status=4 / GRACE_PERIOD) 維持 Pro。
 * 6. 多裝置 (devices_z) 廣播更新避免部分成功造成長期不一致；操作具冪等性，安全重試不重複錯誤授權。
 * 7. 主動補救機制 (reconcileSubscriptionWithApple)：解決 Apple Sandbox 通常僅投遞一次 Webhook 的可靠性缺口。
 * 8. 受控安全開關 (APPLE_WEBHOOK_DRY_RUN 預設為 true)：在未明確啟用前，絕不擅自修改真實 Redis。
 */

export interface SyncResult {
  success: boolean;
  action: string;
  originalTransactionId: string;
  status: 'active' | 'expired' | 'revoked' | 'noop';
  tier: 'free' | 'pro' | 'lifetime';
  devicesUpdatedCount: number;
  dryRun: boolean;
  reason: string;
  error?: string;
}

export interface ReconcileResult {
  success: boolean;
  originalTransactionId: string;
  status?: 'active' | 'expired' | 'revoked' | 'noop';
  tier?: 'free' | 'pro' | 'lifetime';
  devicesUpdatedCount?: number;
  dryRun: boolean;
  message: string;
  error?: string;
}

export class SubscriptionSyncError extends Error {
  constructor(
    message: string,
    public readonly originalTransactionId: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'SubscriptionSyncError';
  }
}

/**
 * 將評估後的訂閱狀態原子寫入 Redis 主記錄並廣播至所有關聯裝置
 */
export async function applySubscriptionStateToRedis(params: {
  originalTransactionId: string;
  transition: StateTransitionResult;
  verifiedNotification?: VerifiedAppleNotification;
  now?: number;
  isDryRun?: boolean;
}): Promise<SyncResult> {
  const { originalTransactionId, transition, verifiedNotification } = params;
  const now = params.now || Date.now();
  const isDryRun = params.isDryRun ?? (process.env.APPLE_WEBHOOK_DRY_RUN !== 'false');

  if (!originalTransactionId || typeof originalTransactionId !== 'string') {
    throw new SubscriptionSyncError('缺少有效之 originalTransactionId。', originalTransactionId);
  }

  // 若為不可變更操作 (noop 或不具行動力)，直接安全返回
  if (!transition.actionable || transition.status === 'noop') {
    return {
      success: true,
      action: transition.action,
      originalTransactionId,
      status: transition.status,
      tier: transition.tier,
      devicesUpdatedCount: 0,
      dryRun: isDryRun,
      reason: transition.reason,
    };
  }

  // 若處於 Dry-Run 模式，僅模擬推導結果，絕不寫入資料庫
  if (isDryRun) {
    return {
      success: true,
      action: transition.action,
      originalTransactionId,
      status: transition.status,
      tier: transition.tier,
      devicesUpdatedCount: 0,
      dryRun: true,
      reason: `[Dry-Run 模式] 模擬計算完成，未修改真實 Redis (${transition.reason})`,
    };
  }

  const redis = getRedisClient();

  // 1. 取得既有記錄 (優先查詢環境隔離記錄)
  const incomingEnv = (verifiedNotification?.environment || 'Sandbox').trim().toLowerCase();
  let existingRecord: AppleEntitlementRecord | null = null;
  let legacyRecord: AppleEntitlementRecord | null = null;
  try {
    existingRecord = await getOriginalTransactionEntitlement(originalTransactionId, incomingEnv);
    legacyRecord = (await redis.get(`exam_ai:apple:entitlement:${originalTransactionId}`)) as AppleEntitlementRecord | null;
    if (!existingRecord && legacyRecord) {
      existingRecord = legacyRecord;
    }
  } catch (err: any) {
    throw new SubscriptionSyncError(
      `讀取既有交易主記錄失敗: ${err?.message || err}`,
      originalTransactionId,
      err,
    );
  }

  // 嚴格跨環境 Webhook 防護：Sandbox Webhook 絕不得更新 Production 交易主記錄
  const legacyEnv = (legacyRecord?.environment || 'Sandbox').toLowerCase();
  const isBlockedFromLegacy = Boolean(legacyRecord && legacyEnv === 'production' && incomingEnv === 'sandbox');

  if (isBlockedFromLegacy) {
    console.warn(`[Webhook環境隔離] 拒絕 Sandbox Webhook 更新已由 Production 佔有之交易 (${originalTransactionId})`);
    return {
      success: true,
      action: 'ignored_cross_environment',
      originalTransactionId,
      status: legacyRecord?.status || 'active',
      tier: legacyRecord?.tier || 'pro',
      devicesUpdatedCount: 0,
      dryRun: isDryRun,
      reason: 'Sandbox Webhook 嚴格禁止修改 Production 交易主記錄。',
    };
  }

  // 2. 組合更新後的交易主記錄
  const targetTier = transition.tier === 'lifetime' ? 'lifetime' : 'pro';
  const targetStatus = transition.status;
  const effectiveExpiresDate =
    transition.effectiveExpiresDate !== undefined
      ? transition.effectiveExpiresDate
      : existingRecord?.expiresDate || null;
  const effectiveRevocationDate =
    transition.effectiveRevocationDate !== undefined
      ? transition.effectiveRevocationDate
      : existingRecord?.revocationDate || null;

  // 取得 Apple 密碼學簽署時間戳記 (若未傳入通知則以傳入之 now 為基準)
  const txSignedDate =
    verifiedNotification?.transaction?.signedDate ||
    verifiedNotification?.signedDate ||
    verifiedNotification?.purchaseDate ||
    now;

  const renewalSignedDate =
    verifiedNotification?.renewalInfo?.signedDate ||
    (verifiedNotification?.notificationType === 'DID_CHANGE_RENEWAL_STATUS' ? (verifiedNotification?.signedDate || now) : 0) ||
    0;

  const updatedRecord: AppleEntitlementRecord = {
    originalTransactionId,
    lastTransactionId:
      verifiedNotification?.transaction?.transactionId ||
      verifiedNotification?.transactionId ||
      existingRecord?.lastTransactionId ||
      originalTransactionId,
    productId:
      verifiedNotification?.transaction?.productId ||
      verifiedNotification?.productId ||
      existingRecord?.productId ||
      'exampro_monthly',
    tier: targetTier,
    status: targetStatus,
    purchaseDate:
      verifiedNotification?.transaction?.purchaseDate ||
      verifiedNotification?.purchaseDate ||
      existingRecord?.purchaseDate ||
      now,
    originalPurchaseDate:
      verifiedNotification?.transaction?.originalPurchaseDate ||
      verifiedNotification?.originalPurchaseDate ||
      existingRecord?.originalPurchaseDate ||
      now,
    expiresDate: effectiveExpiresDate,
    revocationDate: effectiveRevocationDate,
    willRenew:
      targetTier === 'lifetime'
        ? undefined
        : transition.willRenew !== undefined
        ? transition.willRenew
        : existingRecord?.willRenew,
    verifiedAt: now,
    lastAppleSignedDate: txSignedDate > 0 ? txSignedDate : existingRecord?.lastAppleSignedDate,
    lastRenewalSignedDate: renewalSignedDate > 0 ? renewalSignedDate : existingRecord?.lastRenewalSignedDate,
    environment:
      verifiedNotification?.environment ||
      existingRecord?.environment ||
      'Sandbox',
    isSandbox: (verifiedNotification?.environment || existingRecord?.environment || 'Sandbox').toLowerCase() === 'sandbox',
  };

  // 3 & 4. 樂觀並行控制 (OCC) 與原子寫入 Redis 交易主記錄
  let recordTtl = 0;
  if (targetTier !== 'lifetime') {
    if (effectiveExpiresDate && targetStatus === 'active') {
      const diffSec = Math.ceil((effectiveExpiresDate - now) / 1000);
      recordTtl = Math.max(86400, diffSec + 30 * 86400);
    } else {
      recordTtl = 30 * 86400;
    }
  }

  const incomingTimestamp = txSignedDate > 0 ? txSignedDate : (renewalSignedDate > 0 ? renewalSignedDate : 0);
  const envScopedMainKey = `exam_ai:apple:entitlement:${incomingEnv}:${originalTransactionId}`;
  const legacyMainKey = `exam_ai:apple:entitlement:${originalTransactionId}`;
  const targetKeyForOcc = isBlockedFromLegacy ? envScopedMainKey : legacyMainKey;

  try {
    const occRes = (await redis.eval(
      SAVE_ENTITLEMENT_OCC_LUA,
      [targetKeyForOcc],
      [JSON.stringify(updatedRecord), String(incomingTimestamp), String(recordTtl)],
    )) as string[];

    if (!isBlockedFromLegacy) {
      try {
        if (targetTier === 'lifetime') {
          await redis.set(envScopedMainKey, updatedRecord);
        } else {
          await redis.set(envScopedMainKey, updatedRecord, { ex: recordTtl || 86400 });
        }
      } catch {
        // 忽略輔助環境 Key 寫入錯誤
      }
    }

    if (occRes && occRes[0] !== 'OK') {
      const occCode = occRes[0];
      const detail = occRes[1] || 'unknown';

      // 關鍵防護：即使主記錄因 STALE、REVOKED_LOCK 或 OUT_OF_ORDER_EXPIRED 略過主鍵寫入，
      // 仍必須對關聯裝置進行補償同步，確保所有裝置與目前 Redis 中的權威記錄保持一致！
      let compensatedDevicesCount = 0;
      try {
        const devicesKey = `exam_ai:apple:devices_z:${incomingEnv}:${originalTransactionId}`;
        const legacyDevicesKey = `exam_ai:apple:devices_z:${originalTransactionId}`;
        const associatedDevices = (await redis.zrange(devicesKey, 0, -1)) as string[];
        const legacyDevices = !isBlockedFromLegacy ? ((await redis.zrange(legacyDevicesKey, 0, -1)) as string[]) : [];
        const uniqueDevIds = new Set<string>();
        if (Array.isArray(associatedDevices)) associatedDevices.forEach((d) => uniqueDevIds.add(d));
        if (Array.isArray(legacyDevices)) legacyDevices.forEach((d) => uniqueDevIds.add(d));

        if (uniqueDevIds.size > 0) {
          for (const devId of uniqueDevIds) {
            if (!devId || typeof devId !== 'string') continue;
            // 傳入 null 作為 updatedTargetRecord，直接讀取 Redis 最新權威記錄進行裝置權益評估
            await syncUserDeviceEffectiveEntitlement(devId, originalTransactionId, null, now);
            compensatedDevicesCount++;
          }
        }
      } catch (compErr: any) {
        console.error(`[訂閱同步補償異常] 裝置補償同步失敗 (交易: ${originalTransactionId}):`, compErr?.message || compErr);
        throw new SubscriptionSyncError(
          `裝置補償同步失敗: ${compErr?.message || compErr}`,
          originalTransactionId,
          compErr,
        );
      }

      if (occCode === 'REVOKED_LOCK') {
        return {
          success: true,
          action: 'IGNORE_OLD_RECEIPT_AFTER_REVOCATION',
          originalTransactionId,
          status: 'revoked',
          tier: 'free',
          devicesUpdatedCount: compensatedDevicesCount,
          dryRun: false,
          reason: `Redis OCC 阻擋：此交易已被 Apple 撤銷或退款 (鎖定時間戳: ${detail})，拒絕以舊收據覆蓋。已補償確認關聯裝置 (${compensatedDevicesCount} 台)。`,
        };
      }

      if (occCode === 'LIFETIME_PROTECTED') {
        return {
          success: true,
          action: 'IGNORE_LOWER_TIER_OVERWRITE',
          originalTransactionId,
          status: 'active',
          tier: 'lifetime',
          devicesUpdatedCount: compensatedDevicesCount,
          dryRun: false,
          reason: `Redis OCC 阻擋：既有終身買斷版 (Lifetime) 方案具備最高優先權，拒絕由一般訂閱或通知降級。已補償確認關聯裝置 (${compensatedDevicesCount} 台)。`,
        };
      }

      if (occCode === 'OUT_OF_ORDER_EXPIRED') {
        return {
          success: true,
          action: 'IGNORE_OUT_OF_ORDER',
          originalTransactionId,
          status: 'active',
          tier: existingRecord?.tier || targetTier,
          devicesUpdatedCount: compensatedDevicesCount,
          dryRun: false,
          reason: `Redis OCC 阻擋：收到亂序過期通知，現有有效續約到期日 (${detail}) 較新，予以忽略。已補償確認關聯裝置 (${compensatedDevicesCount} 台)。`,
        };
      }

      return {
        success: true,
        action: 'IGNORE_STALE_RECORD',
        originalTransactionId,
        status: existingRecord?.status || 'active',
        tier: existingRecord?.status === 'active' ? (existingRecord.tier || 'free') : 'free',
        devicesUpdatedCount: compensatedDevicesCount,
        dryRun: false,
        reason: `Redis OCC 阻擋：現有記錄時間戳記 (${detail}) 比本次寫入事件 (${incomingTimestamp}) 更新，略過過期工作以防覆蓋。已補償確認關聯裝置 (${compensatedDevicesCount} 台)。`,
      };
    }
  } catch (saveErr: any) {
    if (saveErr instanceof SubscriptionSyncError) {
      throw saveErr;
    }
    throw new SubscriptionSyncError(
      `寫入交易主記錄失敗: ${saveErr?.message || saveErr}`,
      originalTransactionId,
      saveErr,
    );
  }

  // 5. 多裝置原子廣播更新 (Multi-device Fan-out 整合跨交易評估)
  let devicesUpdatedCount = 0;
  try {
    const devicesKey = `exam_ai:apple:devices_z:${incomingEnv}:${originalTransactionId}`;
    const legacyDevicesKey = `exam_ai:apple:devices_z:${originalTransactionId}`;
    const associatedDevices = (await redis.zrange(devicesKey, 0, -1)) as string[];
    const legacyDevices = !isBlockedFromLegacy ? ((await redis.zrange(legacyDevicesKey, 0, -1)) as string[]) : [];
    const uniqueDevIds = new Set<string>();
    if (Array.isArray(associatedDevices)) associatedDevices.forEach((d) => uniqueDevIds.add(d));
    if (Array.isArray(legacyDevices)) legacyDevices.forEach((d) => uniqueDevIds.add(d));

    if (uniqueDevIds.size > 0) {
      for (const devId of uniqueDevIds) {
        if (!devId || typeof devId !== 'string') continue;
        // 呼叫跨交易綜合評估，確保此交易即使到期或撤銷，也不會誤刪使用者在其他交易上合法擁有的 Lifetime 或 Pro 權限！
        await syncUserDeviceEffectiveEntitlement(devId, originalTransactionId, updatedRecord, now);
        devicesUpdatedCount++;
      }
    }
  } catch (fanOutErr: any) {
    console.error(`[訂閱同步異常] 廣播更新關聯裝置快取失敗 (交易: ${originalTransactionId}):`, fanOutErr?.message || fanOutErr);
    // 拋出明確例外，確保上層 Webhook 釋放處理鎖以供安全重試
    throw new SubscriptionSyncError(
      `廣播更新關聯裝置快取失敗: ${fanOutErr?.message || fanOutErr}`,
      originalTransactionId,
      fanOutErr,
    );
  }

  return {
    success: true,
    action: transition.action,
    originalTransactionId,
    status: targetStatus,
    tier: targetStatus === 'active' ? targetTier : 'free',
    devicesUpdatedCount,
    dryRun: false,
    reason: transition.reason,
  };
}

/**
 * 即時 Apple Webhook 事件處理器實作 (支援受控 Dry-Run 與 Live 模式切換)
 */
export class LiveAppleWebhookEventHandler implements IAppleWebhookEventHandler {
  async handle(notification: VerifiedAppleNotification): Promise<{
    success: boolean;
    action: string;
    reason?: string;
  }> {
    if (!notification.isValid) {
      return {
        success: false,
        action: 'REJECTED',
        reason: notification.errorMessage || '無效的 Apple 簽署通知。',
      };
    }

    // TEST 測試通知不包含交易資訊，無須更新 Redis 主記錄
    if (notification.notificationType === 'TEST') {
      return {
        success: true,
        action: 'IGNORE_TEST_NOTIFICATION',
        reason: '收到 Apple 測試連線通知 (TEST)，連線正常無須更新資料庫。',
      };
    }

    const isDryRun = process.env.APPLE_WEBHOOK_DRY_RUN !== 'false';
    const originalTxId =
      notification.originalTransactionId ||
      notification.transaction?.originalTransactionId ||
      notification.transactionId ||
      (isDryRun ? `dryrun_${notification.notificationUUID || Date.now()}` : '');

    if (!originalTxId) {
      return {
        success: false,
        action: 'REJECTED',
        reason: '通知負載缺失必要之 originalTransactionId。',
      };
    }

    // 1. 取得既有交易主記錄 (Dry-run 下若為虛擬 ID 則跳過查詢)
    let existingRecord: AppleEntitlementRecord | null = null;
    if (!originalTxId.startsWith('dryrun_')) {
      try {
        existingRecord = await getOriginalTransactionEntitlement(originalTxId);
      } catch {
        // 忽略初次讀取錯誤
      }
    }

    // 2. 透過狀態流轉引擎進行純函式狀態推導
    const transition = evaluateSubscriptionStateTransition({
      existingRecord,
      incomingNotification: notification,
      now: Date.now(),
    });

    // 3. 執行同步至 Redis (若 APPLE_WEBHOOK_DRY_RUN !== 'false' 則安全乾跑)
    const syncRes = await applySubscriptionStateToRedis({
      originalTransactionId: originalTxId,
      transition,
      verifiedNotification: notification,
      isDryRun,
    });

    return {
      success: syncRes.success,
      action: syncRes.action,
      reason: syncRes.reason,
    };
  }
}

/**
 * ───── 主動補救與補查機制 (Reconciliation Fallback) ─────
 *
 * 設計原因：
 * Apple 官方明確指出 Sandbox 環境 Webhook 通常「僅發送一次且不保證重試」。
 * 當網路中斷、伺服端冷啟動或 Webhook 遺失時，本函式可主動呼叫 Apple Server API，
 * 取得最新真實訂閱狀態並補救修復 Redis，確保會員權限一致性。
 */
export async function reconcileSubscriptionWithApple(
  originalTransactionId: string,
  options: { forceLive?: boolean; now?: number } = {},
): Promise<ReconcileResult> {
  if (!originalTransactionId || typeof originalTransactionId !== 'string' || originalTransactionId.trim().length === 0) {
    return {
      success: false,
      originalTransactionId: '',
      dryRun: false,
      message: '未提供有效之 originalTransactionId。',
      error: 'INVALID_TRANSACTION_ID',
    };
  }

  const cleanTxId = originalTransactionId.trim();
  const now = options.now || Date.now();
  const isDryRun = options.forceLive ? false : (process.env.APPLE_WEBHOOK_DRY_RUN !== 'false');

  // 1. 檢查 Server API 客戶端是否已配置
  const apiClient = getAppleServerApiClient();
  if (!apiClient.isConfigured()) {
    return {
      success: false,
      originalTransactionId: cleanTxId,
      dryRun: isDryRun,
      message: 'Apple App Store Server API 金鑰尚未配置，無法發起主動補查。',
      error: 'APPLE_SERVER_API_NOT_CONFIGURED',
    };
  }

  // 2. 取得既有記錄，判斷商品種類
  let existingRecord: AppleEntitlementRecord | null = null;
  try {
    existingRecord = await getOriginalTransactionEntitlement(cleanTxId);
  } catch {
    // 忽略讀取錯誤
  }

  const isLifetime = existingRecord?.productId === 'exampro_lifetime';
  const verifier = getAppleNotificationVerifier();

  let decodedTx: any = null;
  let decodedRenewal: any = null;
  let appleStatus: number = 1;

  if (isLifetime) {
    // 3A. Lifetime (非消耗型終身商品)：透過 getTransactionInfo 查詢單筆交易狀態
    let txInfoRes;
    try {
      txInfoRes = await apiClient.getTransactionInfo(cleanTxId);
    } catch (apiErr: any) {
      return {
        success: false,
        originalTransactionId: cleanTxId,
        dryRun: isDryRun,
        message: `呼叫 Apple Server API getTransactionInfo 失敗: ${apiErr?.message || apiErr}`,
        error: 'APPLE_API_CALL_FAILED',
      };
    }

    if (!txInfoRes?.signedTransactionInfo) {
      return {
        success: false,
        originalTransactionId: cleanTxId,
        dryRun: isDryRun,
        message: 'Apple 未回傳 signedTransactionInfo。',
        error: 'NO_TRANSACTION_INFO',
      };
    }

    // 官方 SignedDataVerifier 嚴格驗證簽章
    try {
      decodedTx = await verifier.verifyAndDecodeTransaction(txInfoRes.signedTransactionInfo);
    } catch (vErr: any) {
      return {
        success: false,
        originalTransactionId: cleanTxId,
        dryRun: isDryRun,
        message: `Apple 交易簽章驗證失敗: ${vErr?.message || vErr}`,
        error: 'SIGNATURE_VERIFICATION_FAILED',
      };
    }

    appleStatus = decodedTx.revocationDate ? 5 : 1;
  } else {
    // 3B. 訂閱型商品：呼叫 getAllSubscriptionStatuses 查詢群組訂閱狀態
    let statusResponse;
    try {
      statusResponse = await apiClient.getAllSubscriptionStatuses(cleanTxId);
    } catch (apiErr: any) {
      return {
        success: false,
        originalTransactionId: cleanTxId,
        dryRun: isDryRun,
        message: `呼叫 Apple Server API 失敗: ${apiErr?.message || apiErr}`,
        error: 'APPLE_API_CALL_FAILED',
      };
    }

    if (!statusResponse || !Array.isArray(statusResponse.data) || statusResponse.data.length === 0) {
      return {
        success: false,
        originalTransactionId: cleanTxId,
        dryRun: isDryRun,
        message: 'Apple 未回傳任何訂閱群組資訊。',
        error: 'NO_SUBSCRIPTION_DATA',
      };
    }

    const group = statusResponse.data[0];
    const lastItem = group.lastTransactions?.[0];
    if (!lastItem) {
      return {
        success: false,
        originalTransactionId: cleanTxId,
        dryRun: isDryRun,
        message: 'Apple 訂閱群組中無有效之最新交易項目。',
        error: 'NO_TRANSACTION_ITEM',
      };
    }

    appleStatus = Number(lastItem.status);

    // 官方 SignedDataVerifier 密碼學驗證 signedTransactionInfo (若回傳提供)
    if (lastItem.signedTransactionInfo) {
      try {
        decodedTx = await verifier.verifyAndDecodeTransaction(lastItem.signedTransactionInfo);
      } catch (vErr: any) {
        return {
          success: false,
          originalTransactionId: cleanTxId,
          dryRun: isDryRun,
          message: `Apple 回傳之 signedTransactionInfo 簽署驗證未通過: ${vErr?.message || vErr}`,
          error: 'SIGNATURE_VERIFICATION_FAILED',
        };
      }
    }

    // 驗證 signedRenewalInfo (若回傳提供)
    if (lastItem.signedRenewalInfo) {
      try {
        decodedRenewal = await verifier.verifyAndDecodeRenewalInfo(lastItem.signedRenewalInfo);
      } catch (rErr: any) {
        console.warn('[主動補查] 解密 signedRenewalInfo 失敗:', rErr?.message || rErr);
      }
    }
  }

  // 4. 根據 Apple 驗證結果與 status 代碼映射合成正規通知事件
  let syntheticType = 'DID_RENEW';
  let syntheticSubtype: string | undefined;

  if (appleStatus === 1) {
    syntheticType = 'DID_RENEW';
  } else if (appleStatus === 2) {
    syntheticType = 'EXPIRED';
    syntheticSubtype = 'VOLUNTARY';
  } else if (appleStatus === 4) {
    syntheticType = 'DID_FAIL_TO_RENEW';
    syntheticSubtype = 'GRACE_PERIOD';
  } else if (appleStatus === 5 || decodedTx?.revocationDate) {
    syntheticType = 'REVOKE';
  }

  const verifiedNotification: VerifiedAppleNotification = {
    isValid: true,
    notificationType: syntheticType,
    subtype: syntheticSubtype,
    notificationUUID: `reconcile_${cleanTxId}_${now}`,
    signedDate: now,
    originalTransactionId: cleanTxId,
    transactionId: decodedTx?.transactionId || cleanTxId,
    productId: decodedTx?.productId || existingRecord?.productId || (isLifetime ? 'exampro_lifetime' : 'exampro_monthly'),
    purchaseDate: decodedTx?.purchaseDate || existingRecord?.purchaseDate || now,
    expiresDate: decodedTx?.expiresDate || existingRecord?.expiresDate || (isLifetime ? undefined : (now + 30 * 86400 * 1000)),
    revocationDate: decodedTx?.revocationDate || undefined,
    environment: decodedTx?.environment || existingRecord?.environment || 'Sandbox',
    transaction: decodedTx,
    renewalInfo: decodedRenewal,
    rawPayload: {
      data: {
        status: appleStatus,
      },
    },
  };

  const transition = evaluateSubscriptionStateTransition({
    existingRecord,
    incomingNotification: verifiedNotification,
    now,
  });

  const syncResult = await applySubscriptionStateToRedis({
    originalTransactionId: cleanTxId,
    transition,
    verifiedNotification,
    now,
    isDryRun,
  });

  return {
    success: syncResult.success,
    originalTransactionId: cleanTxId,
    status: syncResult.status,
    tier: syncResult.tier,
    devicesUpdatedCount: syncResult.devicesUpdatedCount,
    dryRun: isDryRun,
    message: isDryRun
      ? `主動補查推導成功 (Dry-Run 模式，未寫入 Redis): 狀態=${syncResult.status}`
      : `主動補查同步成功: 狀態=${syncResult.status}, 會員等級=${syncResult.tier}, 更新裝置數=${syncResult.devicesUpdatedCount}`,
  };
}

// 註冊 LiveAppleWebhookEventHandler 為全域預設處理器
setDefaultAppleWebhookEventHandler(new LiveAppleWebhookEventHandler());

export {
  setDefaultAppleWebhookEventHandler,
  setCustomAppleWebhookEventHandler,
  getAppleWebhookEventHandler,
};
