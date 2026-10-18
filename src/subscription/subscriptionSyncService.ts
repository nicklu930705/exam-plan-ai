import { AppState, type AppStateStatus } from 'react-native';
import {
  clearStoredLatestAppleJws,
  clearStoredProofToken,
  getBackendUrlFromStorage,
  getOrCreateClientDeviceId,
  getStoredLatestAppleJws,
  getStoredProofToken,
  isIapSandboxConfigured,
  saveStoredProofToken,
} from '../storage';
import { getEffectiveTier } from './entitlements';
import type { PlanTier, UserSubscription } from './types';

/**
 * 考試計畫 AI - 會員狀態背景靜默自動同步服務 (Phase 3.2b)
 *
 * 核心安全規範：
 * 1. 靜默非同步：於 App 啟動或自背景喚醒回到前景時非同步查詢，絕不阻擋 UI 繪製與使用者操作。
 * 2. 避免 Code 14：絕對不得在啟動或切換前景時無條件調用 StoreKit 原生 restorePurchases() 或 AppStore.sync()。
 * 3. 前景節流 (Throttle)：回到前景時自動觸發，但設有至少 5 分鐘冷卻間隔，避免頻繁發送網路請求。
 * 4. 競態防護 (Race Condition Guard)：維護遞增 Request ID，舊的延遲回應絕不可覆蓋較新的成功狀態。
 * 5. 寬容網絡錯誤：遭遇網路斷線、後端 502/503 或逾時時，寬容維持本機尚未到期的合法權益，絕不誤降級。
 * 6. 到期/撤銷安全降級：伺服端明確確認 revoked 或 expired 時，安全將訂閱狀態改為 Free，
 *    同時嚴格確保使用者所有考試、進度、筆記與歷史資料 100% 完整無損！
 */

export const FOREGROUND_THROTTLE_MS = 5 * 60 * 1000; // 5 分鐘節流冷卻

export interface SubscriptionSyncOptions {
  currentSubscription?: UserSubscription;
  getCurrentSubscription?: () => UserSubscription | undefined;
  setSubscription: (sub: UserSubscription) => void;
  force?: boolean;
  customApiEndpoint?: string;
  timeoutMs?: number;
}

export interface SubscriptionSyncResult {
  success: boolean;
  status:
    | 'active'
    | 'expired'
    | 'revoked'
    | 'none'
    | 'network_error'
    | 'throttled'
    | 'stale_response'
    | 'skipped_free';
  tier: PlanTier;
  message: string;
}

// 模組狀態 (跨生命週期共享)
let lastSyncTimestamp = 0;
let latestSyncRequestId = 0;

/**
 * 使所有目前進行中的背景同步請求立即失效
 * 當使用者完成購買、手動恢復或會員資料變更時調用，徹底杜絕舊背景查詢覆蓋新購買狀態！
 */
export function invalidateInflightSyncRequests(): void {
  latestSyncRequestId++;
}

/**
 * 測試專用：重設同步服務狀態
 */
export function resetSyncServiceForTesting() {
  lastSyncTimestamp = 0;
  latestSyncRequestId = 0;
}

/**
 * 測試專用：設定前次同步時間
 */
export function setLastSyncTimestampForTesting(ts: number) {
  lastSyncTimestamp = ts;
}

/**
 * 執行會員狀態同步
 */
export async function syncSubscriptionStatus(
  options: SubscriptionSyncOptions,
): Promise<SubscriptionSyncResult> {
  const now = Date.now();
  const currentTier = getEffectiveTier(options.currentSubscription);

  // 1. 節流檢查 (除非指定 force=true)
  if (!options.force && lastSyncTimestamp > 0 && now - lastSyncTimestamp < FOREGROUND_THROTTLE_MS) {
    return {
      success: true,
      status: 'throttled',
      tier: currentTier,
      message: '同步冷卻中，略過重複請求。',
    };
  }

  // 2. 檢查本地付費憑證
  const storedProofToken = await getStoredProofToken();
  const proofToken = storedProofToken || options.currentSubscription?.proofToken;
  const storedJws = await getStoredLatestAppleJws();
  const latestJws = storedJws || options.currentSubscription?.signedTransaction;
  const origTxId =
    options.currentSubscription?.originalTransactionId ||
    options.currentSubscription?.transactionId;

  // 若使用者從未購買且完全無任何付費憑證，靜默保留 Free，不造成無謂網路負擔
  const isFreeNoCredentials =
    (!options.currentSubscription || options.currentSubscription.plan === 'free') &&
    !proofToken &&
    !latestJws &&
    !origTxId;

  if (isFreeNoCredentials) {
    lastSyncTimestamp = now;
    return {
      success: true,
      status: 'skipped_free',
      tier: 'free',
      message: '免費使用者無交易憑證，略過伺服器查詢。',
    };
  }

  // 3. 取得伺服器端點
  const baseUrl = options.customApiEndpoint || (await getBackendUrlFromStorage());
  if (!baseUrl) {
    if (isIapSandboxConfigured()) {
      return {
        success: false,
        status: 'network_error',
        tier: currentTier,
        message: 'Sandbox 環境後端網址不合規，略過同步。',
      };
    }
    return {
      success: false,
      status: 'network_error',
      tier: currentTier,
      message: '未配置伺服器網址，保留本地快取。',
    };
  }

  // 4. 發送非同步查詢請求 (並行競態保護)
  const currentRequestId = ++latestSyncRequestId;
  const deviceId = await getOrCreateClientDeviceId();
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/api/subscription-status`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Client-Device-Id': deviceId,
  };

  if (proofToken) {
    headers['Authorization'] = `Bearer ${proofToken}`;
    headers['X-Apple-Proof-Token'] = proofToken;
  }
  if (latestJws) {
    headers['X-Apple-JWS'] = latestJws;
  }
  if (origTxId) {
    headers['X-Original-Transaction-Id'] = origTxId;
  }

  const payload = {
    deviceId,
    proofToken,
    signedTransaction: latestJws,
    originalTransactionId: origTxId,
  };

  let response: Response;
  const timeoutMs = options.timeoutMs ?? 10000;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller?.signal,
    });
  } catch (err: any) {
    if (timer) clearTimeout(timer);
    console.warn('[會員同步] 伺服器連線失敗或逾時，寬容保留本地會員權限:', err?.message || err);
    return {
      success: false,
      status: 'network_error',
      tier: currentTier,
      message: '網路連線異常，已保留現有會員狀態。',
    };
  } finally {
    if (timer) clearTimeout(timer);
  }

  // 5. 處理伺服端錯誤 (500, 502, 503 等暫時性故障)
  if (response.status >= 500) {
    console.warn(`[會員同步] 伺服器回傳暫時性錯誤 (${response.status})，寬容保留本地會員權限。`);
    return {
      success: false,
      status: 'network_error',
      tier: currentTier,
      message: `伺服器暫時無法使用 (${response.status})，已保留現有狀態。`,
    };
  }

  let json: any = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }

  // 6. 競態防護檢查：若在等待回應期間已啟動了更新的同步請求，安全捨棄此舊回應
  if (currentRequestId < latestSyncRequestId) {
    return {
      success: false,
      status: 'stale_response',
      tier: currentTier,
      message: '已產生更新的同步請求，捨棄逾時之舊回應。',
    };
  }

  // 更新成功同步時間戳記
  lastSyncTimestamp = Date.now();

  if (!response.ok || !json || json.success === false) {
    return {
      success: false,
      status: 'none',
      tier: currentTier,
      message: json?.error || `查詢失敗 (HTTP ${response.status})。`,
    };
  }

  // 7. 解析伺服端回傳的權威狀態
  const returnedStatus = json.status as string;
  const returnedTier = (json.tier as PlanTier) || 'free';

  // ────── A. 被 Apple 撤銷或退款 (Revoked) ──────
  if (returnedStatus === 'revoked') {
    // 競態安全防護：若在請求處理期間，Store 中的會員狀態已被更新為有效 Pro/Lifetime，絕不以舊的撤銷結果覆蓋！
    const currentSubInStore = options.getCurrentSubscription?.() ?? options.currentSubscription;
    if (
      currentSubInStore &&
      (currentSubInStore.plan === 'pro' || currentSubInStore.plan === 'lifetime') &&
      currentSubInStore.status === 'active' &&
      currentSubInStore.originalTransactionId &&
      currentSubInStore.originalTransactionId !== (json.originalTransactionId || origTxId)
    ) {
      return {
        success: false,
        status: 'stale_response',
        tier: currentSubInStore.plan,
        message: '本機已更新為其他有效購買方案，捨棄舊交易狀態回應。',
      };
    }

    await clearStoredProofToken();
    await clearStoredLatestAppleJws();

    const downgraded: UserSubscription = {
      plan: 'free',
      billingCycle: 'none',
      status: 'revoked',
      productId: json.productId || options.currentSubscription?.productId,
      originalTransactionId: json.originalTransactionId || options.currentSubscription?.originalTransactionId,
      transactionId: options.currentSubscription?.transactionId,
      purchaseDate: options.currentSubscription?.purchaseDate,
      revocationDate: new Date().toISOString(),
      proofToken: undefined,
      signedTransaction: undefined,
    };

    options.setSubscription(downgraded);

    return {
      success: true,
      status: 'revoked',
      tier: 'free',
      message: '此會員權益已被 Apple 撤銷或退款，已安全降回免費方案。',
    };
  }

  // ────── B. 訂閱已過期 (Expired) ──────
  if (returnedStatus === 'expired') {
    // 競態安全防護：若在請求處理期間，Store 中的會員狀態已被更新為有效 Pro/Lifetime，絕不以舊的過期結果覆蓋！
    const currentSubInStore = options.getCurrentSubscription?.() ?? options.currentSubscription;
    if (
      currentSubInStore &&
      (currentSubInStore.plan === 'pro' || currentSubInStore.plan === 'lifetime') &&
      currentSubInStore.status === 'active' &&
      currentSubInStore.originalTransactionId &&
      currentSubInStore.originalTransactionId !== (json.originalTransactionId || origTxId)
    ) {
      return {
        success: false,
        status: 'stale_response',
        tier: currentSubInStore.plan,
        message: '本機已更新為其他有效購買方案，捨棄舊交易狀態回應。',
      };
    }

    await clearStoredProofToken();
    await clearStoredLatestAppleJws();

    const downgraded: UserSubscription = {
      plan: 'free',
      billingCycle: options.currentSubscription?.billingCycle || 'none',
      status: 'expired',
      productId: json.productId || options.currentSubscription?.productId,
      originalTransactionId: json.originalTransactionId || options.currentSubscription?.originalTransactionId,
      transactionId: options.currentSubscription?.transactionId,
      purchaseDate: options.currentSubscription?.purchaseDate,
      expiresAt: json.expiresAt ? new Date(json.expiresAt).toISOString() : options.currentSubscription?.expiresAt,
      proofToken: undefined,
      signedTransaction: undefined,
    };

    options.setSubscription(downgraded);

    return {
      success: true,
      status: 'expired',
      tier: 'free',
      message: '訂閱方案已到期，已更新為免費方案。',
    };
  }

  // ────── C. 有效啟用中 (Active 或 Grace Period) ──────
  if (returnedStatus === 'active' || returnedStatus === 'grace_period') {
    if (json.proofToken) {
      await saveStoredProofToken(json.proofToken);
    }

    const updated: UserSubscription = {
      plan: returnedTier === 'lifetime' ? 'lifetime' : 'pro',
      billingCycle:
        returnedTier === 'lifetime'
          ? 'lifetime'
          : options.currentSubscription?.billingCycle === 'annual'
            ? 'annual'
            : 'monthly',
      status: 'active',
      productId: json.productId || options.currentSubscription?.productId,
      originalTransactionId: json.originalTransactionId || options.currentSubscription?.originalTransactionId,
      transactionId: options.currentSubscription?.transactionId,
      purchaseDate: options.currentSubscription?.purchaseDate,
      expiresAt: json.expiresAt ? new Date(json.expiresAt).toISOString() : options.currentSubscription?.expiresAt,
      isAutoRenewing: json.willRenew ?? options.currentSubscription?.isAutoRenewing,
      proofToken: json.proofToken || options.currentSubscription?.proofToken,
      signedTransaction: latestJws || options.currentSubscription?.signedTransaction,
    };

    options.setSubscription(updated);

    return {
      success: true,
      status: 'active',
      tier: updated.plan,
      message: '會員狀態同步完成，權益處於有效狀態。',
    };
  }

  // ────── D. 無付費紀錄 (None) ──────
  return {
    success: true,
    status: 'none',
    tier: 'free',
    message: '會員狀態正常。',
  };
}

/**
 * 監聽 App 生命週期（前景切換），自動執行節流同步
 */
export function setupForegroundSubscriptionSync(options: {
  getSubscription: () => UserSubscription | undefined;
  setSubscription: (sub: UserSubscription) => void;
  customApiEndpoint?: string;
}): () => void {
  let appState: AppStateStatus = AppState.currentState;

  const subscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
    // 當 App 由背景 (background / inactive) 回到前景 (active)
    if (appState.match(/inactive|background/) && nextAppState === 'active') {
      syncSubscriptionStatus({
        currentSubscription: options.getSubscription(),
        setSubscription: options.setSubscription,
        customApiEndpoint: options.customApiEndpoint,
        force: false, // 尊重 5 分鐘節流冷卻
      }).catch((err) => {
        console.warn('[會員同步] 前景自動同步發生例外:', err?.message || err);
      });
    }
    appState = nextAppState;
  });

  return () => {
    subscription.remove();
  };
}
