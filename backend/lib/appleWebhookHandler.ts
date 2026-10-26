import {
  Environment,
  JWSRenewalInfoDecodedPayload,
  JWSTransactionDecodedPayload,
  ResponseBodyV2DecodedPayload,
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
} from '@apple/app-store-server-library';
import { getAppleRootCertificatesBuffers } from './appleCertificates';
import {
  isNotificationEnvironmentAllowed,
  isTransactionEnvironmentAllowed,
  resolveAppleEnvironment,
} from './appleEnvironment';
import {
  EXPECTED_APP_APPLE_ID,
  EXPECTED_BUNDLE_ID,
  isValidProductId,
  VALID_PRODUCT_CONFIG,
  ValidProductId,
} from './appleIap';
import type { AppleEntitlementRecord } from './entitlement';
import { getRedisClient } from './redis';

/**
 * 考試計畫 AI - Apple Server Notifications V2 驗證、解析與狀態流轉核心模組
 *
 * 核心安全職責：
 * 1. 使用官方 SignedDataVerifier 嚴格驗證 Apple 推送之 JWS (signedPayload、signedTransactionInfo、signedRenewalInfo)。
 * 2. 嚴格比對 Bundle ID (com.examplanai.app) 與環境 (Sandbox / Production 隔離)。
 * 3. 實作 notificationUUID 冪等機制，嚴格區分 processing 與 completed，失敗時自動釋放鎖允許 Apple 安全重試。
 * 4. 訂閱事件狀態轉換引擎：防舊覆蓋新、防退款永久鎖死新訂閱、防過期通知亂序降級有效續訂。
 * 5. 受控功能開關與事件處理介面 (IAppleWebhookEventHandler)，Phase 3.1 採安全 Dry-Run 模式，不擅自覆蓋真實 Redis。
 */

export interface VerifiedAppleNotification {
  isValid: boolean;
  notificationType: string;
  subtype?: string;
  notificationUUID: string;
  version?: string;
  signedDate?: number;
  environment?: string;
  bundleId?: string;
  appAppleId?: number;
  transaction?: JWSTransactionDecodedPayload;
  renewalInfo?: JWSRenewalInfoDecodedPayload;
  originalTransactionId?: string;
  transactionId?: string;
  productId?: string;
  purchaseDate?: number;
  originalPurchaseDate?: number;
  expiresDate?: number;
  revocationDate?: number;
  rawPayload?: ResponseBodyV2DecodedPayload;
  errorMessage?: string;
}

export interface StateTransitionResult {
  actionable: boolean;
  action:
    | 'APPLY_ACTIVE'
    | 'APPLY_RENEWAL'
    | 'APPLY_EXPIRED'
    | 'APPLY_REVOKED'
    | 'UPDATE_RENEWAL_INFO'
    | 'IGNORE_OUT_OF_ORDER'
    | 'IGNORE_STALE_TIMESTAMP'
    | 'IGNORE_OLD_RECEIPT_AFTER_REVOCATION'
    | 'IGNORE_TEST_NOTIFICATION'
    | 'NOOP_REFUND_DECLINED'
    | 'NOOP_UNHANDLED_EVENT'
    | 'INVALID_PRODUCT';
  status: 'active' | 'expired' | 'revoked' | 'noop';
  tier: 'free' | 'pro' | 'lifetime';
  effectiveExpiresDate?: number | null;
  effectiveRevocationDate?: number | null;
  willRenew?: boolean;
  reason: string;
}

/**
 * 官方 Apple Server Notification V2 簽章驗證器
 */
export class AppleNotificationVerifier {
  private productionVerifier: SignedDataVerifier | null = null;
  private sandboxVerifier: SignedDataVerifier | null = null;

  private initVerifiers() {
    if (this.productionVerifier && this.sandboxVerifier) return;

    const rootCerts = getAppleRootCertificatesBuffers();
    const enableOnlineChecks = process.env.APPLE_ENABLE_ONLINE_OCSP === 'true';

    this.productionVerifier = new SignedDataVerifier(
      rootCerts,
      enableOnlineChecks,
      Environment.PRODUCTION,
      EXPECTED_BUNDLE_ID,
      EXPECTED_APP_APPLE_ID,
    );

    this.sandboxVerifier = new SignedDataVerifier(
      rootCerts,
      enableOnlineChecks,
      Environment.SANDBOX,
      EXPECTED_BUNDLE_ID,
    );
  }

  async verifyAndDecode(signedPayload: string): Promise<VerifiedAppleNotification> {
    if (!signedPayload || typeof signedPayload !== 'string' || signedPayload.trim().length === 0) {
      return {
        isValid: false,
        notificationType: 'UNKNOWN',
        notificationUUID: '',
        errorMessage: '未提供 Apple Webhook 簽署負載 (signedPayload)。',
      };
    }

    this.initVerifiers();

    const envConfig = resolveAppleEnvironment();
    if (!envConfig.valid) {
      return {
        isValid: false,
        notificationType: 'INVALID',
        notificationUUID: '',
        errorMessage: envConfig.error || 'Apple 環境設定無效或衝突。',
      };
    }

    const preferredEnv = envConfig.targetRole;
    const allowSandbox = envConfig.allowSandbox;

    let decodedPayload: ResponseBodyV2DecodedPayload | null = null;
    let activeVerifier: SignedDataVerifier | null = null;
    let verifiedEnv = '';
    let lastError: any = null;

    const candidateVerifiers: Array<{ verifier: SignedDataVerifier; envName: string }> = [];
    if (preferredEnv === 'sandbox') {
      if (this.sandboxVerifier) candidateVerifiers.push({ verifier: this.sandboxVerifier, envName: 'Sandbox' });
      if (allowSandbox && this.productionVerifier) {
        candidateVerifiers.push({ verifier: this.productionVerifier, envName: 'Production' });
      }
    } else {
      // 正式後端：嚴格僅掛載正式驗證器，絕對不允許 Sandbox
      if (this.productionVerifier) candidateVerifiers.push({ verifier: this.productionVerifier, envName: 'Production' });
      if (allowSandbox && this.sandboxVerifier) {
        candidateVerifiers.push({ verifier: this.sandboxVerifier, envName: 'Sandbox' });
      }
    }

    for (const { verifier, envName } of candidateVerifiers) {
      try {
        decodedPayload = await verifier.verifyAndDecodeNotification(signedPayload.trim());
        activeVerifier = verifier;
        verifiedEnv = envName;
        break;
      } catch (err: any) {
        lastError = err;
        if (err instanceof VerificationException && err.status === VerificationStatus.INVALID_ENVIRONMENT) {
          continue;
        }
        break;
      }
    }

    if (!decodedPayload || !activeVerifier) {
      return {
        isValid: false,
        notificationType: 'INVALID',
        notificationUUID: '',
        errorMessage: this.formatError(lastError),
      };
    }

    // 嚴格比對 Webhook 通知環境是否符合當前伺服器角色 (正式後端拒絕 Sandbox Webhook)
    if (!isNotificationEnvironmentAllowed(verifiedEnv)) {
      return {
        isValid: false,
        notificationType: decodedPayload.notificationType || 'UNKNOWN',
        notificationUUID: decodedPayload.notificationUUID || '',
        errorMessage: `正式後端嚴格禁止處理 ${verifiedEnv} Webhook 通知。`,
      };
    }

    // 檢查外層通知 Bundle ID
    const notificationBundleId = decodedPayload.data?.bundleId;
    if (notificationBundleId && notificationBundleId !== EXPECTED_BUNDLE_ID) {
      return {
        isValid: false,
        notificationType: decodedPayload.notificationType || 'UNKNOWN',
        notificationUUID: decodedPayload.notificationUUID || '',
        errorMessage: `通知應用程式識別碼不吻合 (預期 ${EXPECTED_BUNDLE_ID}，實際 ${notificationBundleId})。`,
      };
    }

    // 解密內嵌的 signedTransactionInfo (若有)
    let decodedTransaction: JWSTransactionDecodedPayload | undefined;
    if (decodedPayload.data?.signedTransactionInfo) {
      try {
        decodedTransaction = await activeVerifier.verifyAndDecodeTransaction(
          decodedPayload.data.signedTransactionInfo,
        );
      } catch (txErr: any) {
        console.warn('[Apple Webhook] 解密內嵌交易失敗:', txErr?.message || txErr);
      }
    }

    // 嚴格檢查外層 signedPayload 與內層交易 JWS 的 Bundle ID 及環境一致性
    if (decodedTransaction) {
      // 內層交易 Bundle ID 檢驗
      if (decodedTransaction.bundleId && decodedTransaction.bundleId !== EXPECTED_BUNDLE_ID) {
        return {
          isValid: false,
          notificationType: decodedPayload.notificationType || 'UNKNOWN',
          notificationUUID: decodedPayload.notificationUUID || '',
          errorMessage: `內層交易 Bundle ID 不符合預期 (預期 ${EXPECTED_BUNDLE_ID}，實際 ${decodedTransaction.bundleId})。`,
        };
      }
      // 外層與內層 Bundle ID 交叉比對
      if (notificationBundleId && decodedTransaction.bundleId && decodedTransaction.bundleId !== notificationBundleId) {
        return {
          isValid: false,
          notificationType: decodedPayload.notificationType || 'UNKNOWN',
          notificationUUID: decodedPayload.notificationUUID || '',
          errorMessage: `外層通知與內層交易之 Bundle ID 不一致 (${notificationBundleId} vs ${decodedTransaction.bundleId})。`,
        };
      }
      // 外層與內層 Environment 交叉比對
      const outerEnv = decodedPayload.data?.environment;
      if (outerEnv && decodedTransaction.environment && outerEnv.toLowerCase() !== decodedTransaction.environment.toLowerCase()) {
        return {
          isValid: false,
          notificationType: decodedPayload.notificationType || 'UNKNOWN',
          notificationUUID: decodedPayload.notificationUUID || '',
          errorMessage: `外層通知與內層交易之環境不一致 (${outerEnv} vs ${decodedTransaction.environment})。`,
        };
      }
      // 內層交易環境是否符合當前伺服器角色
      if (decodedTransaction.environment && !isTransactionEnvironmentAllowed(decodedTransaction.environment)) {
        return {
          isValid: false,
          notificationType: decodedPayload.notificationType || 'UNKNOWN',
          notificationUUID: decodedPayload.notificationUUID || '',
          errorMessage: `正式後端嚴格禁止處理 ${decodedTransaction.environment} 內層交易憑證。`,
        };
      }
    }

    // 解密內嵌的 signedRenewalInfo (若有)
    let decodedRenewalInfo: JWSRenewalInfoDecodedPayload | undefined;
    if (decodedPayload.data?.signedRenewalInfo) {
      try {
        decodedRenewalInfo = await activeVerifier.verifyAndDecodeRenewalInfo(
          decodedPayload.data.signedRenewalInfo,
        );
      } catch (rnErr: any) {
        console.warn('[Apple Webhook] 解密內嵌續約資訊失敗:', rnErr?.message || rnErr);
      }
    }

    const originalTxId =
      decodedTransaction?.originalTransactionId ||
      decodedTransaction?.transactionId;

    return {
      isValid: true,
      notificationType: decodedPayload.notificationType || 'UNKNOWN',
      subtype: decodedPayload.subtype,
      notificationUUID: decodedPayload.notificationUUID || '',
      version: decodedPayload.version,
      signedDate: decodedPayload.signedDate,
      environment: verifiedEnv,
      bundleId: notificationBundleId || EXPECTED_BUNDLE_ID,
      appAppleId: decodedPayload.data?.appAppleId,
      transaction: decodedTransaction,
      renewalInfo: decodedRenewalInfo,
      originalTransactionId: originalTxId,
      transactionId: decodedTransaction?.transactionId,
      productId: decodedTransaction?.productId,
      purchaseDate: decodedTransaction?.purchaseDate,
      originalPurchaseDate: decodedTransaction?.originalPurchaseDate,
      expiresDate: decodedTransaction?.expiresDate,
      revocationDate: decodedTransaction?.revocationDate,
      rawPayload: decodedPayload,
    };
  }

  async verifyAndDecodeTransaction(
    signedTransactionInfo: string,
  ): Promise<JWSTransactionDecodedPayload> {
    if (!signedTransactionInfo || typeof signedTransactionInfo !== 'string') {
      throw new Error('未提供有效的 signedTransactionInfo。');
    }
    this.initVerifiers();
    const envConfig = resolveAppleEnvironment();
    if (!envConfig.valid) {
      throw new Error(envConfig.error || 'Apple 環境設定無效。');
    }

    const candidateVerifiers: Array<{ verifier: SignedDataVerifier; envName: string }> = [];
    if (envConfig.targetRole === 'sandbox') {
      if (this.sandboxVerifier) candidateVerifiers.push({ verifier: this.sandboxVerifier, envName: 'Sandbox' });
      if (envConfig.allowSandbox && this.productionVerifier) {
        candidateVerifiers.push({ verifier: this.productionVerifier, envName: 'Production' });
      }
    } else {
      if (this.productionVerifier) candidateVerifiers.push({ verifier: this.productionVerifier, envName: 'Production' });
      if (envConfig.allowSandbox && this.sandboxVerifier) {
        candidateVerifiers.push({ verifier: this.sandboxVerifier, envName: 'Sandbox' });
      }
    }

    let lastError: any = null;
    for (const { verifier, envName } of candidateVerifiers) {
      try {
        const decoded = await verifier.verifyAndDecodeTransaction(signedTransactionInfo.trim());
        if (decoded.bundleId && decoded.bundleId !== EXPECTED_BUNDLE_ID) {
          throw new Error(`交易 Bundle ID 不符 (預期 ${EXPECTED_BUNDLE_ID}，實際 ${decoded.bundleId})。`);
        }
        if (decoded.environment && !isTransactionEnvironmentAllowed(decoded.environment)) {
          throw new Error(`環境不相符：禁止在當前伺服器處理 ${decoded.environment} 交易。`);
        }
        return decoded;
      } catch (err: any) {
        lastError = err;
        if (err instanceof VerificationException && err.status === VerificationStatus.INVALID_ENVIRONMENT) {
          continue;
        }
        throw err;
      }
    }
    throw lastError || new Error('Apple 交易簽章驗證失敗。');
  }

  async verifyAndDecodeRenewalInfo(
    signedRenewalInfo: string,
  ): Promise<JWSRenewalInfoDecodedPayload> {
    if (!signedRenewalInfo || typeof signedRenewalInfo !== 'string') {
      throw new Error('未提供有效的 signedRenewalInfo。');
    }
    this.initVerifiers();
    const envConfig = resolveAppleEnvironment();
    if (!envConfig.valid) {
      throw new Error(envConfig.error || 'Apple 環境設定無效。');
    }

    const candidateVerifiers: SignedDataVerifier[] = [];
    if (envConfig.targetRole === 'sandbox') {
      if (this.sandboxVerifier) candidateVerifiers.push(this.sandboxVerifier);
      if (envConfig.allowSandbox && this.productionVerifier) candidateVerifiers.push(this.productionVerifier);
    } else {
      if (this.productionVerifier) candidateVerifiers.push(this.productionVerifier);
      if (envConfig.allowSandbox && this.sandboxVerifier) candidateVerifiers.push(this.sandboxVerifier);
    }

    let lastError: any = null;
    for (const verifier of candidateVerifiers) {
      try {
        return await verifier.verifyAndDecodeRenewalInfo(signedRenewalInfo.trim());
      } catch (err: any) {
        lastError = err;
        if (err instanceof VerificationException && err.status === VerificationStatus.INVALID_ENVIRONMENT) {
          continue;
        }
        throw err;
      }
    }
    throw lastError || new Error('Apple 續約資訊簽章驗證失敗。');
  }

  private formatError(err: any): string {
    if (!err) return 'Apple Webhook 簽名驗證失敗。';
    if (err instanceof VerificationException) {
      switch (err.status) {
        case VerificationStatus.INVALID_APP_IDENTIFIER:
          return '通知應用程式識別碼與本 App 不相符。';
        case VerificationStatus.INVALID_ENVIRONMENT:
          return '通知環境不相符 (沙盒/正式環境不一致)。';
        case VerificationStatus.INVALID_CHAIN_LENGTH:
        case VerificationStatus.INVALID_CERTIFICATE:
        case VerificationStatus.VERIFICATION_FAILURE:
          return 'Apple 通知數位簽章或憑證鏈驗證失敗。';
        default:
          return '通知憑證驗證失敗。';
      }
    }
    return err?.message || 'Apple 通知驗證過程發生未預期錯誤。';
  }
}

// 驗證器單例與測試注入
let customNotificationVerifier: AppleNotificationVerifier | null = null;
export function setCustomNotificationVerifier(verifier: AppleNotificationVerifier | null) {
  customNotificationVerifier = verifier;
}
export const setCustomAppleNotificationVerifier = setCustomNotificationVerifier;
export function getAppleNotificationVerifier(): AppleNotificationVerifier {
  return customNotificationVerifier || new AppleNotificationVerifier();
}

/**
 * ───── 冪等性管理 (區分 processing 與 completed) ─────
 */
export interface WebhookIdempotencyOptions {
  lockTtlSec?: number;
  completeTtlSec?: number;
  isDryRun?: boolean;
}

export function getWebhookIdempotencyRedisKey(notificationUUID: string, isDryRun = false): string {
  const prefix = isDryRun ? 'exam_ai:apple:webhook:dryrun:state:' : 'exam_ai:apple:webhook:state:';
  return `${prefix}${notificationUUID.trim()}`;
}

export async function acquireWebhookIdempotency(
  notificationUUID: string,
  options: WebhookIdempotencyOptions | number = {},
): Promise<{ acquired: boolean; state: 'processing' | 'completed' | 'new'; message?: string }> {
  if (!notificationUUID || typeof notificationUUID !== 'string' || notificationUUID.trim().length === 0) {
    return { acquired: false, state: 'completed', message: '缺少有效的 notificationUUID。' };
  }

  const opts = typeof options === 'number' ? { lockTtlSec: options } : options;
  const lockTtlSec = opts.lockTtlSec ?? 60;
  const isDryRun = opts.isDryRun ?? false;

  const redis = getRedisClient();
  const key = getWebhookIdempotencyRedisKey(notificationUUID, isDryRun);

  // 先讀取當前狀態
  const current = await redis.get(key);
  if (current === 'completed') {
    return { acquired: false, state: 'completed', message: '此通知已於先前成功處理完畢。' };
  }
  if (current === 'processing') {
    return { acquired: false, state: 'processing', message: '此通知目前正在並行處理中。' };
  }

  // 嘗試原子設定 processing 鎖
  const lockAcquired = await redis.set(key, 'processing', { nx: true, ex: lockTtlSec });
  if (lockAcquired) {
    return { acquired: true, state: 'new' };
  }

  // 若鎖未取得，再次檢查狀態
  const latest = await redis.get(key);
  if (latest === 'completed') {
    return { acquired: false, state: 'completed', message: '此通知已於先前成功處理完畢。' };
  }
  return { acquired: false, state: 'processing', message: '此通知目前正在並行處理中。' };
}

export async function completeWebhookIdempotency(
  notificationUUID: string,
  options: WebhookIdempotencyOptions | number = {},
): Promise<void> {
  if (!notificationUUID) return;
  const opts = typeof options === 'number' ? { completeTtlSec: options } : options;
  const completeTtlSec = opts.completeTtlSec ?? 259200; // 3 天
  const isDryRun = opts.isDryRun ?? false;

  const redis = getRedisClient();
  const key = getWebhookIdempotencyRedisKey(notificationUUID, isDryRun);
  await redis.set(key, 'completed', { ex: completeTtlSec });
}

export async function releaseWebhookIdempotency(
  notificationUUID: string,
  options: WebhookIdempotencyOptions = {},
): Promise<void> {
  if (!notificationUUID) return;
  const isDryRun = options.isDryRun ?? false;

  const redis = getRedisClient();
  const key = getWebhookIdempotencyRedisKey(notificationUUID, isDryRun);
  // 處理失敗時必須刪除 processing 鎖，確保 Apple 下一次重試時可以重新處理
  await redis.del(key);
}

/**
 * ───── 訂閱狀態轉換規則引擎 (Pure State Evaluator) ─────
 */
export function evaluateSubscriptionStateTransition(params: {
  existingRecord: AppleEntitlementRecord | null;
  incomingNotification: VerifiedAppleNotification;
  now?: number;
}): StateTransitionResult {
  const { existingRecord, incomingNotification } = params;
  const now = params.now || Date.now();

  const type = incomingNotification.notificationType;
  const subtype = incomingNotification.subtype;
  const tx = incomingNotification.transaction;
  const renewal = incomingNotification.renewalInfo;

  // 1. 處理 TEST 通知
  if (type === 'TEST') {
    return {
      actionable: false,
      action: 'IGNORE_TEST_NOTIFICATION',
      status: 'noop',
      tier: existingRecord?.tier || 'free',
      reason: '收到 Apple 測試連線通知 (TEST)，連線正常無須更新資料庫。',
    };
  }

  // 2. 檢驗 Product ID 合法性
  const productId = incomingNotification.productId || existingRecord?.productId;
  if (!productId || !isValidProductId(productId)) {
    return {
      actionable: false,
      action: 'INVALID_PRODUCT',
      status: 'noop',
      tier: 'free',
      reason: `未知的產品 ID「${productId || '空值'}」，非合法方案。`,
    };
  }

  const productConfig = VALID_PRODUCT_CONFIG[productId as ValidProductId];
  const targetTier = productConfig.tier;

  // 3. 處理 REFUND_DECLINED (退款申請被 Apple 拒絕：維持現狀，不撤銷權益)
  if (type === 'REFUND_DECLINED') {
    return {
      actionable: false,
      action: 'NOOP_REFUND_DECLINED',
      status: existingRecord?.status || 'noop',
      tier: existingRecord?.tier || targetTier,
      effectiveExpiresDate: existingRecord?.expiresDate || incomingNotification.expiresDate,
      reason: 'Apple 已駁回退款申請 (REFUND_DECLINED)，維持現有會員權益與方案效期。',
    };
  }

  // 4. 處理 REFUND 與 REVOKE (最高優先級)
  if (type === 'REFUND' || type === 'REVOKE') {
    const revocationDate = incomingNotification.revocationDate || incomingNotification.signedDate || now;
    return {
      actionable: true,
      action: 'APPLY_REVOKED',
      status: 'revoked',
      tier: 'free',
      effectiveRevocationDate: revocationDate,
      effectiveExpiresDate: null,
      reason: `此交易已被 Apple 撤銷或退款 (事件: ${type})。`,
    };
  }

  // 4. 安全關鍵防護：若既有記錄已被撤銷/退款
  if (existingRecord && existingRecord.status === 'revoked') {
    // 嚴格安全規範：
    // 1. 新交易本身不得帶有撤銷標記 (revocationDate 必須為空)。
    // 2. 新購買時間 (purchaseDate) 必須嚴格晚於先前的退款撤銷時間 (revocationDate)。
    //    嚴禁僅因簽章時間 (signedDate) 較新就忽視先前的退款紀錄！
    // 3. 必須為明確的購買/重新訂閱事件。
    const incomingPurchaseDate = incomingNotification.purchaseDate || tx?.purchaseDate || 0;
    const existingRevocationDate = existingRecord.revocationDate || 0;
    const incomingRevocationDate = incomingNotification.revocationDate || tx?.revocationDate;

    const isSubscribedEvent =
      type === 'SUBSCRIBED' ||
      type === 'DID_RENEW' ||
      subtype === 'INITIAL_BUY' ||
      subtype === 'RESUBSCRIBE';

    const isNewPurchaseAfterRevoke =
      !incomingRevocationDate &&
      incomingPurchaseDate > existingRevocationDate &&
      isSubscribedEvent;

    if (!isNewPurchaseAfterRevoke) {
      return {
        actionable: false,
        action: 'IGNORE_OLD_RECEIPT_AFTER_REVOCATION',
        status: 'revoked',
        tier: 'free',
        effectiveRevocationDate: existingRevocationDate,
        reason: '此收據已在伺服端被確認為退款撤銷，拒絕由舊 JWS 逆向激活。',
      };
    }
    // 若為退款後之全新合法購買，允許進入後續正常激活流程！
  }

  // 5. 處理 EXPIRED (訂閱到期)
  if (type === 'EXPIRED') {
    const incomingExpiresDate = incomingNotification.expiresDate || tx?.expiresDate || 0;
    // 亂序保護：若既有記錄為有效續約，且既有到期日比此過期通知更晚，予以忽略
    if (
      existingRecord &&
      existingRecord.status === 'active' &&
      existingRecord.expiresDate &&
      existingRecord.expiresDate > now &&
      incomingExpiresDate < existingRecord.expiresDate
    ) {
      return {
        actionable: false,
        action: 'IGNORE_OUT_OF_ORDER',
        status: 'active',
        tier: existingRecord.tier,
        effectiveExpiresDate: existingRecord.expiresDate,
        reason: '收到亂序延遲抵達的過期通知，現有續訂到期日較新，予以忽略保持有效。',
      };
    }

    return {
      actionable: true,
      action: 'APPLY_EXPIRED',
      status: 'expired',
      tier: 'free',
      effectiveExpiresDate: incomingExpiresDate || now,
      reason: `訂閱方案已到期終止 (子類型: ${subtype || 'VOLUNTARY'})。`,
    };
  }

  // 6. 處理扣款失敗 (DID_FAIL_TO_RENEW)
  if (type === 'DID_FAIL_TO_RENEW') {
    // 依據 Apple 規範：扣款失敗不代表使用者取消續訂，Apple 會在重試期內繼續扣款，依 renewal.autoRenewStatus 判定
    const willRenew =
      renewal?.autoRenewStatus !== undefined
        ? renewal.autoRenewStatus === 1
        : (existingRecord?.willRenew ?? true);

    // 檢查是否處於寬限期 (Grace Period)
    const inGracePeriod =
      subtype === 'GRACE_PERIOD' ||
      (incomingNotification.rawPayload?.data?.status === 4);

    if (inGracePeriod) {
      // 寬限期內：保留 Pro 權限，但發出續費警示
      return {
        actionable: true,
        action: 'UPDATE_RENEWAL_INFO',
        status: 'active',
        tier: targetTier,
        effectiveExpiresDate: incomingNotification.expiresDate || existingRecord?.expiresDate,
        willRenew,
        reason: '訂閱扣款失敗，目前處於 Apple 帳單寬限期 (Grace Period)，保留會員資格。',
      };
    }

    // 非寬限期扣款失敗：若現有到期日已過則標記 expired
    const currentExpiry = incomingNotification.expiresDate || existingRecord?.expiresDate || 0;
    if (currentExpiry <= now) {
      return {
        actionable: true,
        action: 'APPLY_EXPIRED',
        status: 'expired',
        tier: 'free',
        effectiveExpiresDate: currentExpiry,
        reason: '訂閱續約扣款失敗且已逾到期日，會員資格降為免費版。',
      };
    }

    // 尚未逾期但續約扣款失敗（一般帳單重試 Billing Retry）：維持 Pro 權益至原到期日
    return {
      actionable: true,
      action: 'UPDATE_RENEWAL_INFO',
      status: 'active',
      tier: targetTier,
      effectiveExpiresDate: currentExpiry,
      willRenew,
      reason: '訂閱續約扣款失敗進入帳單重試期，目前尚未逾期，保留 Pro 權益至到期日為止。',
    };
  }

  // 7. 寬限期結束 (GRACE_PERIOD_EXPIRED)
  if (type === 'GRACE_PERIOD_EXPIRED') {
    return {
      actionable: true,
      action: 'APPLY_EXPIRED',
      status: 'expired',
      tier: 'free',
      reason: 'Apple 寬限期已結束仍未能成功扣款，會員資格降為免費版。',
    };
  }

  // 8. 處理續訂狀態變更 (DID_CHANGE_RENEWAL_STATUS)
  if (type === 'DID_CHANGE_RENEWAL_STATUS') {
    const willRenew =
      subtype === 'AUTO_RENEW_ENABLED' ||
      renewal?.autoRenewStatus === 1;

    // 關閉或開啟續約不影響目前有效到期日
    return {
      actionable: true,
      action: 'UPDATE_RENEWAL_INFO',
      status: existingRecord?.status || 'active',
      tier: existingRecord?.tier || targetTier,
      effectiveExpiresDate: existingRecord?.expiresDate || incomingNotification.expiresDate,
      willRenew,
      reason: `使用者自動續訂狀態已變更為 ${willRenew ? '開啟' : '關閉'}。`,
    };
  }

  // 9. 處理正常購買與續訂 (SUBSCRIBED / DID_RENEW / OFFER_REDEEMED)
  if (type === 'SUBSCRIBED' || type === 'DID_RENEW' || type === 'OFFER_REDEEMED') {
    const newExpiresDate = incomingNotification.expiresDate || tx?.expiresDate;

    // 亂序保護：若新通知之到期日比既有有效記錄更短，且既有記錄仍在有效中，略過縮短
    if (
      existingRecord &&
      existingRecord.status === 'active' &&
      existingRecord.expiresDate &&
      newExpiresDate &&
      newExpiresDate < existingRecord.expiresDate
    ) {
      return {
        actionable: false,
        action: 'IGNORE_OUT_OF_ORDER',
        status: 'active',
        tier: existingRecord.tier,
        effectiveExpiresDate: existingRecord.expiresDate,
        reason: '新通知之到期日比現有有效記錄短，略過縮短保持原有效期限。',
      };
    }

    return {
      actionable: true,
      action: type === 'DID_RENEW' ? 'APPLY_RENEWAL' : 'APPLY_ACTIVE',
      status: 'active',
      tier: targetTier,
      effectiveExpiresDate: newExpiresDate,
      effectiveRevocationDate: null,
      willRenew: renewal?.autoRenewStatus !== 0,
      reason: type === 'DID_RENEW' ? 'Apple 自動續訂扣款成功。' : 'Apple 訂閱或購買成功。',
    };
  }

  // 10. 預設非關鍵通知或未特別處理之事件
  return {
    actionable: false,
    action: 'NOOP_UNHANDLED_EVENT',
    status: 'noop',
    tier: existingRecord?.tier || 'free',
    reason: `未特別處理之 Apple 事件類型「${type}」。`,
  };
}

/**
 * ───── Webhook 事件處理器介面與 Dry-Run 安全實作 (Phase 3.1) ─────
 */
export interface IAppleWebhookEventHandler {
  handle(notification: VerifiedAppleNotification): Promise<{
    success: boolean;
    action: string;
    reason?: string;
  }>;
}

/**
 * Phase 3.1 安全乾跑處理器 (Dry-Run)：
 * 僅執行簽名驗證、狀態推導與冪等性記錄，絕不修改正式/Sandbox 真實會員資料。
 */
export class DryRunAppleWebhookEventHandler implements IAppleWebhookEventHandler {
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

    // 評估狀態轉換
    const transition = evaluateSubscriptionStateTransition({
      existingRecord: null,
      incomingNotification: notification,
    });

    return {
      success: true,
      action: transition.action,
      reason: `[Phase 3.1 乾跑完成] ${transition.reason}`,
    };
  }
}

let customWebhookEventHandler: IAppleWebhookEventHandler | null = null;
let defaultWebhookEventHandler: IAppleWebhookEventHandler = new DryRunAppleWebhookEventHandler();

export function setDefaultAppleWebhookEventHandler(handler: IAppleWebhookEventHandler) {
  defaultWebhookEventHandler = handler;
}

export function setCustomAppleWebhookEventHandler(handler: IAppleWebhookEventHandler | null) {
  customWebhookEventHandler = handler;
}

export function getAppleWebhookEventHandler(): IAppleWebhookEventHandler {
  return customWebhookEventHandler || defaultWebhookEventHandler;
}
