import { Linking, Platform } from 'react-native';
import {
  clearStoredLatestAppleJws,
  clearStoredProofToken,
  getBackendUrlFromStorage,
  getOrCreateClientDeviceId,
  getStoredProofToken,
  isIapSandboxConfigured,
  saveStoredLatestAppleJws,
  saveStoredProofToken,
} from '../storage';
import {
  ALL_STOREKIT_PRODUCT_IDS,
  APPLE_MANAGE_SUBSCRIPTIONS_URL,
  isValidProductId,
  STOREKIT_PRODUCT_IDS,
} from './storeKitConfig';
import { SUBSCRIPTION_PRODUCTS } from './products';
import { invalidateInflightSyncRequests, isProofTokenWithinRenewalWindow } from './subscriptionSyncService';
import type { PlanTier, ProductDefinition, UserSubscription } from './types';

export interface PurchaseResult {
  success: boolean;
  status: 'success' | 'cancelled' | 'failed' | 'deferred' | 'pending';
  subscription?: UserSubscription;
  transactionId?: string;
  productId?: string;
  message: string;
}

export interface RestoreOptions {
  /**
   * 是否向 Apple 伺服器發起深度同步（調用 AppStore.sync()）
   * 預設為 false，優先以安全模式讀取裝置端現有憑證快取，避免不必要的密碼提示與 Code 14 錯誤。
   */
  syncWithAppStore?: boolean;
}

export interface RestoreResult {
  success: boolean;
  status:
    | 'success'
    | 'no_purchases'
    | 'expired'
    | 'needs_sync'
    | 'sync_error'
    | 'verification_failed'
    | 'busy'
    | 'cancelled'
    | 'failed';
  subscription?: UserSubscription;
  message: string;
  errorCode?: string;
  canRetrySync?: boolean;
}

export interface StoreStatus {
  isConnected: boolean;
  isNativeAvailable: boolean;
  environment: 'sandbox' | 'production' | 'dev_preview' | 'expo_go';
  notice: string;
}

export interface ValidationResult {
  valid: boolean;
  tier?: PlanTier;
  status?: 'active' | 'expired' | 'revoked' | 'invalid';
  proofToken?: string;
  originalTransactionId?: string;
  expiresDate?: number;
  reason?: string;
}

/**
 * 伺服器端與客戶端憑證驗證介面（支援 StoreKit 2 JWS 與 App Store Server API）
 */
export interface ITransactionValidator {
  validate(purchase: unknown): Promise<ValidationResult>;
}

/**
 * 客戶端預設交易驗證器（基礎格式與時序校驗）
 */
export class ClientSideTransactionValidator implements ITransactionValidator {
  async validate(purchase: any): Promise<ValidationResult> {
    if (!purchase || !purchase.productId) {
      return { valid: false, reason: '無效的交易資訊。' };
    }
    if (!isValidProductId(purchase.productId)) {
      return { valid: false, reason: '未知的產品識別碼。' };
    }
    if (purchase.revocationDateIOS != null) {
      return { valid: false, status: 'revoked', reason: '此交易已被 Apple 撤銷或退款。' };
    }
    const isLife = purchase.productId === STOREKIT_PRODUCT_IDS.LIFETIME;
    return {
      valid: true,
      tier: isLife ? 'lifetime' : 'pro',
      status: 'active',
      originalTransactionId: purchase.originalTransactionIdentifierIOS ?? purchase.id,
      expiresDate: purchase.expirationDateIOS,
    };
  }
}

/**
 * 正式後端伺服器驗證器（呼叫 POST /api/verify-transaction 進行 StoreKit 2 JWS 官方密碼學驗證）
 */
export class ServerSideTransactionValidator implements ITransactionValidator {
  constructor(private readonly customApiEndpoint?: string) {}

  async validate(purchase: any): Promise<ValidationResult> {
    if (!purchase || !purchase.productId) {
      return { valid: false, reason: '無效的交易資訊。' };
    }

    if (!isValidProductId(purchase.productId)) {
      return { valid: false, reason: `未知的產品識別碼「${purchase.productId}」。` };
    }

    // 檢查客戶端初步標記
    if (purchase.revocationDateIOS != null) {
      await clearStoredProofToken();
      await clearStoredLatestAppleJws();
      return { valid: false, status: 'revoked', reason: '此交易已被 Apple 撤銷或退款。' };
    }

    // 取得 Apple JWS 憑證 (expo-iap 在 iOS 上放置於 purchaseToken 或 transactionReceiptIOS)
    const signedTransaction =
      purchase.purchaseToken ||
      purchase.transactionReceiptIOS ||
      purchase.signedTransaction;

    if (!signedTransaction || typeof signedTransaction !== 'string' || signedTransaction.trim().length === 0) {
      // 若無 JWS (例如在尚未完成真實連線的本機測試)，在開發模式下可平滑回退，否則拒絕
      if (__DEV__) {
        console.warn('[StoreKit] 交易未帶有 JWS 簽署字串，於開發測試模式下使用客戶端驗證。');
        const clientVal = new ClientSideTransactionValidator();
        return clientVal.validate(purchase);
      }
      return { valid: false, reason: 'Apple 交易憑證遺漏必要之 JWS 數位簽署。' };
    }

    try {
      const baseUrl = this.customApiEndpoint || (await getBackendUrlFromStorage());
      if (!baseUrl) {
        if (isIapSandboxConfigured()) {
          return {
            valid: false,
            reason: 'Sandbox 測試環境後端網址設定不合規，已安全阻斷交易驗證。',
          };
        }
        return { valid: false, reason: '未配置伺服器驗證端點，請確認網路連線。' };
      }

      const deviceId = await getOrCreateClientDeviceId();
      const verifyEndpoint = `${baseUrl.replace(/\/+$/, '')}/api/verify-transaction`;

      const response = await fetch(verifyEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Client-Device-Id': deviceId,
        },
        body: JSON.stringify({
          signedTransaction: signedTransaction.trim(),
          deviceId,
        }),
      });

      let json: any = null;
      try {
        json = await response.json();
      } catch {
        json = null;
      }

      if (!response.ok || !json || json.success === false) {
        if (json?.status === 'revoked' || json?.code === 'TRANSACTION_REVOKED') {
          await clearStoredProofToken();
          await clearStoredLatestAppleJws();
          return { valid: false, tier: 'free', status: 'revoked', reason: json.error || '此交易已被 Apple 撤銷或退款。' };
        }
        if (json?.status === 'expired' || json?.code === 'SUBSCRIPTION_EXPIRED') {
          const currentToken = await getStoredProofToken();
          if (!isProofTokenWithinRenewalWindow(currentToken)) {
            await clearStoredProofToken();
            await clearStoredLatestAppleJws();
          }
          return { valid: false, tier: 'free', status: 'expired', reason: json.error || '此訂閱方案已到期。' };
        }
        return { valid: false, reason: json?.error || `Apple 交易伺服端驗證失敗 (HTTP ${response.status})。` };
      }

      // 驗證成功！
      if (json.proofToken) {
        await saveStoredProofToken(json.proofToken);
      }
      if (signedTransaction && typeof signedTransaction === 'string') {
        await saveStoredLatestAppleJws(signedTransaction.trim());
      }

      return {
        valid: true,
        tier: json.tier,
        status: 'active',
        proofToken: json.proofToken,
        originalTransactionId: json.originalTransactionId,
        expiresDate: json.expiresDate,
      };
    } catch (err: any) {
      console.error('[StoreKit] 呼叫後端交易驗證端點失敗:', err?.message || err);
      return { valid: false, reason: '無法連線至驗證伺服器，請檢查網路連線後重試。' };
    }
  }
}

/**
 * 檢查當前環境是否具備 Apple 原生 StoreKit 支援
 * 注意：Expo Go 不含原生 StoreKit 模組；Development Build 與原生打包環境才支援。
 */
export function isStoreKitNativeAvailable(): boolean {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    return false;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { requireNativeModule } = require('expo-modules-core');
    requireNativeModule('ExpoIap');
    return true;
  } catch {
    return false;
  }
}

/**
 * 判斷是否為 Apple StoreKit 2 的 SKInternalErrorDomain Code 14 或 StoreKit 內部暫時同步中斷錯誤
 */
export function isStoreKitCode14(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'object') {
    const err = error as Record<string, any>;
    if (
      (err.code === 14 || err.code === '14' || err.errorCode === 14 || err.errorCode === '14') &&
      (err.domain === 'SKInternalErrorDomain' || err.domain === 'SKErrorDomain' || !err.domain)
    ) {
      return true;
    }
  }

  const msg =
    typeof error === 'string'
      ? error
      : (error as any)?.message ?? (error as any)?.userInfo?.NSLocalizedDescription ?? String(error);

  const containsDomain = /SKInternalErrorDomain|SKErrorDomain/i.test(msg);
  const containsCode14 = /\b(code\s*=?\s*14|error\s*14)\b/i.test(msg) || /:14\b/.test(msg);

  return (containsDomain && containsCode14) || (msg.includes('SKInternalErrorDomain') && msg.includes('14'));
}

/**
 * 判斷是否為使用者主動取消 Apple ID 驗證或購買對話框
 */
export function isStoreKitUserCancelled(error: unknown): boolean {
  if (!error) return false;
  const err = error as Record<string, any>;
  if (
    err.code === 'user-cancelled' ||
    err.code === 'E_USER_CANCELLED' ||
    err.code === 2 ||
    err.code === '2'
  ) {
    return true;
  }
  const msg = typeof error === 'string' ? error : err.message ?? String(error);
  return /user\s*cancel/i.test(msg) || /使用者取消/.test(msg) || /用戶取消/.test(msg);
}

/**
 * 評估 App Store 回傳之歷史購買紀錄以決定有效會員權限
 * 規則：
 * 1. 若曾退款或撤銷（revocationDateIOS != null），不給予權限。
 * 2. Lifetime 非消耗型買斷：永久具備 lifetime 權限，無過期時間，非訂閱亦不可續訂。
 * 3. Pro 月/年訂閱：檢查有效期限，未到期給予 pro 權限，已到期則降為 free。
 * 4. 方案切換與多筆交易：多筆歷史訂閱時，以最新有效且到期日最晚者為準（例如月繳切換為年繳）。
 * 5. 重要資料保護原則：降為 free 時絕不刪除既有考試或任務。
 */
export function evaluatePurchasesEntitlement(purchases: any[]): {
  tier: PlanTier;
  subscription?: UserSubscription;
  status: 'active' | 'expired' | 'none';
} {
  if (!Array.isArray(purchases) || purchases.length === 0) {
    return { tier: 'free', status: 'none' };
  }

  // 1. 優先檢查終身買斷版（非消耗型、永久有效、無過期時間）
  const lifetimePurchase = purchases.find(
    (p) =>
      p.productId === STOREKIT_PRODUCT_IDS.LIFETIME &&
      p.revocationDateIOS == null,
  );

  if (lifetimePurchase) {
    const sub: UserSubscription = {
      plan: 'lifetime',
      billingCycle: 'lifetime',
      status: 'active',
      productId: STOREKIT_PRODUCT_IDS.LIFETIME,
      transactionId: lifetimePurchase.id,
      originalTransactionId:
        lifetimePurchase.originalTransactionIdentifierIOS ?? lifetimePurchase.id,
      purchaseDate: new Date(lifetimePurchase.transactionDate || Date.now()).toISOString(),
    };
    return { tier: 'lifetime', subscription: sub, status: 'active' };
  }

  // 2. 檢查有效訂閱（過濾已被 Apple 撤銷的項目）
  const now = Date.now();
  const validSubs = purchases.filter(
    (p) =>
      (p.productId === STOREKIT_PRODUCT_IDS.YEARLY ||
        p.productId === STOREKIT_PRODUCT_IDS.MONTHLY) &&
      p.revocationDateIOS == null,
  );

  if (validSubs.length === 0) {
    return { tier: 'free', status: 'none' };
  }

  // 計算每一筆的生效到期日
  const getEffectiveExp = (p: any): number => {
    if (typeof p.expirationDateIOS === 'number') {
      return p.expirationDateIOS;
    }
    const isYearly = p.productId === STOREKIT_PRODUCT_IDS.YEARLY;
    const txnDate = typeof p.transactionDate === 'number' ? p.transactionDate : now;
    return txnDate + (isYearly ? 365 : 30) * 86400 * 1000;
  };

  // 排序規則（處理方案切換，例如月繳升級為年繳）：
  // 1. 是否已生效且仍在有效期內 (txn <= now && exp > now) 優先於 expired 或未生效
  // 2. 最新交易時間 transactionDate (最新購買/續訂者為當前方案)
  // 3. 到期日 expirationDate (較晚到期優先)
  // 4. 年繳優先於月繳
  validSubs.sort((a, b) => {
    const expA = getEffectiveExp(a);
    const expB = getEffectiveExp(b);
    const txnA = typeof a.transactionDate === 'number' ? a.transactionDate : 0;
    const txnB = typeof b.transactionDate === 'number' ? b.transactionDate : 0;

    // 只有已生效 (txn <= now) 且未逾期 (exp > now) 才是「當前有效」方案
    const aActive = txnA <= now && expA > now;
    const bActive = txnB <= now && expB > now;

    if (aActive && !bActive) return -1;
    if (!aActive && bActive) return 1;

    // 若都 active 或皆非 active，優先依交易時間判定（最新交易者代表最新使用者操作）
    if (txnB !== txnA) {
      return txnB - txnA;
    }

    // 交易時間相同時，比較到期日
    if (expB !== expA) {
      return expB - expA;
    }

    // 若到期日亦相同，年繳優先於月繳
    if (a.productId === STOREKIT_PRODUCT_IDS.YEARLY) return -1;
    if (b.productId === STOREKIT_PRODUCT_IDS.YEARLY) return 1;

    return 0;
  });

  const bestSub = validSubs[0];
  const bestExp = getEffectiveExp(bestSub);
  const isYearly = bestSub.productId === STOREKIT_PRODUCT_IDS.YEARLY;
  const bestTxn = typeof bestSub.transactionDate === 'number' ? bestSub.transactionDate : now;

  // 只有在交易已生效 (bestTxn <= now) 且未逾期 (bestExp > now) 時給予 active 權益
  if (bestTxn <= now && bestExp > now) {
    const sub: UserSubscription = {
      plan: 'pro',
      billingCycle: isYearly ? 'annual' : 'monthly',
      status: 'active',
      expiresAt: new Date(bestExp).toISOString(),
      productId: bestSub.productId,
      transactionId: bestSub.id,
      originalTransactionId:
        bestSub.originalTransactionIdentifierIOS ?? bestSub.id,
      purchaseDate: new Date(bestTxn).toISOString(),
      isAutoRenewing: Boolean(bestSub.isAutoRenewing),
    };
    return { tier: 'pro', subscription: sub, status: 'active' };
  } else {
    const sub: UserSubscription = {
      plan: 'pro',
      billingCycle: isYearly ? 'annual' : 'monthly',
      status: 'expired',
      expiresAt: new Date(bestExp).toISOString(),
      productId: bestSub.productId,
      transactionId: bestSub.id,
      originalTransactionId:
        bestSub.originalTransactionIdentifierIOS ?? bestSub.id,
      purchaseDate: new Date(bestSub.transactionDate || now).toISOString(),
      isAutoRenewing: false,
    };
    return { tier: 'free', subscription: sub, status: 'expired' };
  }
}

export interface IStoreKitService {
  init(): Promise<boolean>;
  getProducts(): Promise<ProductDefinition[]>;
  purchase(productId: string): Promise<PurchaseResult>;
  restorePurchases(options?: RestoreOptions): Promise<RestoreResult>;
  getStoreStatus(): StoreStatus;
  manageSubscriptions(): Promise<void>;
  setDevPreviewMode(enabled: boolean): void;
  isDevPreviewMode(): boolean;
}

/**
 * 開發測試預覽服務（用於 Expo Go、單元測試或本機直接切換驗證）
 */
export class DevStoreKitService implements IStoreKitService {
  private devPreviewEnabled = true;
  private isRestoring = false;

  async init(): Promise<boolean> {
    return true;
  }

  async getProducts(): Promise<ProductDefinition[]> {
    return SUBSCRIPTION_PRODUCTS;
  }

  async purchase(productId: string): Promise<PurchaseResult> {
    const product = SUBSCRIPTION_PRODUCTS.find((p) => p.id === productId);
    if (!product) {
      return {
        success: false,
        status: 'failed',
        message: '找不到所選方案產品設定。',
      };
    }

    if (product.tier === 'free') {
      return {
        success: true,
        status: 'success',
        subscription: {
          plan: 'free',
          billingCycle: 'none',
          status: 'none',
          isDevPreview: true,
        },
        message: '已切換為免費版模式。',
      };
    }

    // 安全防護：非開發環境嚴禁透過 Mock 購買服務直接解鎖付費會員 (Pro / Lifetime)
    if (!__DEV__) {
      return {
        success: false,
        status: 'failed',
        message: '目前尚未連接 Apple In-App Purchase 服務，請確認您的 Apple ID 登入狀態與網路連線後再試。',
      };
    }

    const now = new Date();
    let expiresAt: string | undefined;
    if (product.period === 'monthly') {
      now.setDate(now.getDate() + 30);
      expiresAt = now.toISOString();
    } else if (product.period === 'annual') {
      now.setDate(now.getDate() + 365);
      expiresAt = now.toISOString();
    }

    const tier: PlanTier = product.tier;

    return {
      success: true,
      status: 'success',
      productId: product.id,
      transactionId: `dev-txn-${Date.now()}`,
      subscription: {
        plan: tier,
        billingCycle: product.period,
        status: 'active',
        expiresAt,
        productId: product.id,
        isDevPreview: true,
      },
      message: `【測試預覽】已成功切換至「${product.title}」測試狀態。正式環境將經由 Apple In-App Purchase 安全交易。`,
    };
  }

  async restorePurchases(options?: RestoreOptions): Promise<RestoreResult> {
    if (this.isRestoring) {
      return {
        success: false,
        status: 'busy',
        message: '恢復購買正在處理中，請稍候。',
      };
    }
    this.isRestoring = true;
    try {
      if (options?.syncWithAppStore) {
        return {
          success: true,
          status: 'no_purchases',
          message: '【測試預覽】已完成與 Apple 伺服器同步模擬，未查詢到歷史收據。',
        };
      }
      return {
        success: true,
        status: 'no_purchases',
        message: '【測試預覽】已檢查購買紀錄。目前無歷史 App Store 收據。',
      };
    } finally {
      this.isRestoring = false;
    }
  }

  getStoreStatus(): StoreStatus {
    const native = isStoreKitNativeAvailable();
    return {
      isConnected: false,
      isNativeAvailable: native,
      environment: native ? 'sandbox' : 'expo_go',
      notice: native
        ? '目前切換為開發測試模式。如需驗證真實 StoreKit 請關閉開發測試開關。'
        : '目前執行於 Expo Go 或未載入原生模組環境。Expo Go 無法執行 Apple 原生 StoreKit 交易，已自動啟用測試預覽模式供驗證 UI 與權限架構。',
    };
  }

  async manageSubscriptions(): Promise<void> {
    try {
      await Linking.openURL(APPLE_MANAGE_SUBSCRIPTIONS_URL);
    } catch {
      // 瀏覽器無法開啟時靜默忽略
    }
  }

  setDevPreviewMode(enabled: boolean): void {
    this.devPreviewEnabled = enabled;
  }

  isDevPreviewMode(): boolean {
    return this.devPreviewEnabled;
  }
}

/**
 * 正式 Apple StoreKit 2 整合服務（基於 expo-iap）
 * 在原生模組存在時執行正式 StoreKit 交易，缺失時自動平滑回退至 DevStoreKitService。
 */
export class ProductionStoreKitService implements IStoreKitService {
  private devService = new DevStoreKitService();
  private devModeForced = false;
  private isInitialized = false;
  private validator: ITransactionValidator;
  private isRestoring = false;
  private nativeModeForced?: boolean;

  constructor(validator?: ITransactionValidator) {
    this.validator = validator || new ServerSideTransactionValidator();
  }

  setDevPreviewMode(enabled: boolean): void {
    if (__DEV__) {
      this.devModeForced = enabled;
    }
  }

  /**
   * 供單元測試模擬原生環境連線模式
   */
  setNativeModeForTesting(forced: boolean): void {
    this.nativeModeForced = forced;
  }

  isDevPreviewMode(): boolean {
    if (this.nativeModeForced !== undefined) {
      return !this.nativeModeForced;
    }
    if (__DEV__ && this.devModeForced) return true;
    return !isStoreKitNativeAvailable();
  }

  async init(): Promise<boolean> {
    if (this.isDevPreviewMode()) {
      return this.devService.init();
    }

    try {
      // 動態載入 expo-iap 避免在 Expo Go 或無原生模組環境時直接爆發全域錯誤
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { initConnection } = require('expo-iap');
      await initConnection();
      this.isInitialized = true;
      return true;
    } catch (error) {
      console.warn('[StoreKit] 原生連線初始化失敗，回退至測試模式:', error);
      return false;
    }
  }

  async getProducts(): Promise<ProductDefinition[]> {
    if (this.isDevPreviewMode()) {
      return this.devService.getProducts();
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { fetchProducts } = require('expo-iap');
      await this.init();

      // 向 StoreKit 查詢已定義的產品清單
      const storeProducts: any[] = await fetchProducts({
        skus: ALL_STOREKIT_PRODUCT_IDS,
        type: 'all',
      });

      if (!Array.isArray(storeProducts) || storeProducts.length === 0) {
        return SUBSCRIPTION_PRODUCTS;
      }

      // 將 Apple StoreKit 回傳的真實在地化價格更新至產品目錄
      return SUBSCRIPTION_PRODUCTS.map((prod) => {
        const found = storeProducts.find(
          (sp) => sp.id === prod.id || sp.productId === prod.id,
        );
        if (!found) return prod;

        return {
          ...prod,
          title: found.title || prod.title,
          description: found.description || prod.description,
          priceFormatted: found.displayPrice || prod.priceFormatted,
          priceAmount: typeof found.price === 'number' ? found.price : prod.priceAmount,
          currency: found.currency || prod.currency,
        };
      });
    } catch (error) {
      console.warn('[StoreKit] 查詢產品資訊失敗，使用預設配置:', error);
      return SUBSCRIPTION_PRODUCTS;
    }
  }

  async purchase(productId: string): Promise<PurchaseResult> {
    if (this.isDevPreviewMode()) {
      if (!__DEV__) {
        return {
          success: false,
          status: 'failed',
          message: '目前尚未連接 Apple In-App Purchase 服務，請確認您的 Apple ID 登入狀態與網路連線後再試。',
        };
      }
      return this.devService.purchase(productId);
    }

    if (!isValidProductId(productId)) {
      return {
        success: false,
        status: 'failed',
        message: '未知的產品項目。',
      };
    }

    try {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const {
        requestPurchase,
        finishTransaction,
        purchaseUpdatedListener,
        purchaseErrorListener,
        isUserCancelledError,
      } = require('expo-iap');
      /* eslint-enable @typescript-eslint/no-require-imports */

      await this.init();

      const isSub =
        productId === STOREKIT_PRODUCT_IDS.MONTHLY ||
        productId === STOREKIT_PRODUCT_IDS.YEARLY;

      return await new Promise<PurchaseResult>((resolve) => {
        let isResolved = false;
        let updateSub: { remove: () => void } | null = null;
        let errorSub: { remove: () => void } | null = null;

        const cleanup = () => {
          if (updateSub) updateSub.remove();
          if (errorSub) errorSub.remove();
        };

        // 監聽交易成功與更新
        updateSub = purchaseUpdatedListener(async (purchase: any) => {
          if (isResolved) return;
          if (purchase.productId !== productId) return;

          // 處理待批准或等待家長同意 (Ask to Buy)
          if (purchase.purchaseState === 'pending') {
            isResolved = true;
            cleanup();
            resolve({
              success: false,
              status: 'deferred',
              productId,
              message:
                '交易已送出待處理（例如等待家庭共享家長批准）。完成核准後將自動為您啟用會員權益。',
            });
            return;
          }

          // 驗證交易憑證
          const valRes = await this.validator.validate(purchase);
          if (!valRes.valid) {
            isResolved = true;
            cleanup();
            resolve({
              success: false,
              status: 'failed',
              message: valRes.reason || '交易憑證驗證未通過。',
            });
            return;
          }

          // 評估授權等級 (優先依據伺服端權威授權結果)
          const ent = evaluatePurchasesEntitlement([purchase]);
          const effectiveTier: PlanTier = valRes.tier || ent.tier;
          const isYearly = purchase.productId === STOREKIT_PRODUCT_IDS.YEARLY;
          const isSub =
            purchase.productId === STOREKIT_PRODUCT_IDS.MONTHLY ||
            purchase.productId === STOREKIT_PRODUCT_IDS.YEARLY;

          const verifiedSub: UserSubscription = {
            plan: effectiveTier,
            billingCycle: isYearly ? 'annual' : isSub ? 'monthly' : 'lifetime',
            status: 'active',
            expiresAt: valRes.expiresDate
              ? new Date(valRes.expiresDate).toISOString()
              : ent.subscription?.expiresAt,
            productId: purchase.productId,
            transactionId: purchase.id,
            originalTransactionId:
              valRes.originalTransactionId ||
              purchase.originalTransactionIdentifierIOS ||
              purchase.id,
            purchaseDate: new Date(purchase.transactionDate || Date.now()).toISOString(),
            isAutoRenewing: Boolean(purchase.isAutoRenewing),
            proofToken: valRes.proofToken,
          };

          // 完成 StoreKit 交易，從 Apple 佇列中移除
          try {
            await finishTransaction({ purchase, isConsumable: false });
          } catch (finErr) {
            console.warn('[StoreKit] finishTransaction 失敗:', finErr);
          }

          isResolved = true;
          cleanup();
          invalidateInflightSyncRequests();
          resolve({
            success: true,
            status: 'success',
            subscription: verifiedSub,
            transactionId: purchase.id,
            productId,
            message: '購買成功！已為您開通會員專屬權益。',
          });
        });

        // 監聽交易取消或錯誤
        errorSub = purchaseErrorListener((error: any) => {
          if (isResolved) return;
          isResolved = true;
          cleanup();

          if (isUserCancelledError?.(error) || error?.code === 'user-cancelled') {
            resolve({
              success: false,
              status: 'cancelled',
              productId,
              message: '您已取消本次購買。',
            });
          } else {
            resolve({
              success: false,
              status: 'failed',
              productId,
              message: error?.message || '購買失敗，請確認網路連線或 App Store 帳號狀態後再試。',
            });
          }
        });

        // 發動 StoreKit 購買請求
        requestPurchase({
          request: {
            apple: { sku: productId },
          },
          type: isSub ? 'subs' : 'in-app',
        }).catch((reqErr: any) => {
          if (isResolved) return;
          isResolved = true;
          cleanup();
          if (isUserCancelledError?.(reqErr) || reqErr?.code === 'user-cancelled') {
            resolve({
              success: false,
              status: 'cancelled',
              productId,
              message: '您已取消本次購買。',
            });
          } else {
            resolve({
              success: false,
              status: 'failed',
              productId,
              message: reqErr?.message || '發起購買失敗，請稍後再試。',
            });
          }
        });
      });
    } catch (err: any) {
      return {
        success: false,
        status: 'failed',
        message: err?.message || '處理購買請求時發生未預期錯誤。',
      };
    }
  }

  async restorePurchases(options?: RestoreOptions): Promise<RestoreResult> {
    if (this.isDevPreviewMode()) {
      return this.devService.restorePurchases(options);
    }

    if (this.isRestoring) {
      return {
        success: false,
        status: 'busy',
        message: '恢復購買程序正在處理中，請稍候。',
      };
    }

    this.isRestoring = true;
    try {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const expoIap = require('expo-iap');
      /* eslint-enable @typescript-eslint/no-require-imports */

      await this.init();

      const shouldSyncWithAppStore = Boolean(options?.syncWithAppStore);

      // 階段一：若未指定強制向 Apple 伺服器深度同步，優先讀取本機 StoreKit 2 交易憑證快取
      let purchases: any[] = [];
      if (!shouldSyncWithAppStore) {
        try {
          if (typeof expoIap.getAvailablePurchases === 'function') {
            purchases = await expoIap.getAvailablePurchases();
          }
        } catch (localErr) {
          console.warn('[StoreKit] 讀取本機購買快取失敗:', localErr);
        }

        // 若本機快取查到紀錄，直接進入後端安全驗證，完全避免彈出 Apple ID 登入提示與 Code 14 錯誤
        if (Array.isArray(purchases) && purchases.length > 0) {
          return await this.validateAndApplyPurchases(purchases, expoIap);
        }

        // 本機快取無交易紀錄：回傳 needs_sync，由 UI 引導使用者選擇是否進行深度同步
        return {
          success: false,
          status: 'needs_sync',
          message:
            '本機快取查無未過期的購買紀錄。若您先前曾購買過或更換過 Apple ID，可嘗試向 Apple 伺服器重新同步。',
          canRetrySync: true,
        };
      }

      // 階段二：使用者明確要求向 Apple 伺服器深度同步 (Deep Sync, 呼叫 AppStore.sync())
      try {
        if (typeof expoIap.restorePurchases === 'function') {
          await expoIap.restorePurchases();
        }
      } catch (syncErr: any) {
        console.warn('[StoreKit] Apple AppStore.sync 失敗:', syncErr);

        if (isStoreKitUserCancelled(syncErr)) {
          return {
            success: false,
            status: 'cancelled',
            message: '您已取消 Apple 帳號驗證。',
          };
        }

        if (isStoreKitCode14(syncErr)) {
          return {
            success: false,
            status: 'sync_error',
            errorCode: 'SKInternalErrorDomain:14',
            message:
              'Apple App Store 伺服器同步暫時中斷 (錯誤代碼: 14)。此通常為沙盒測試伺服器或連線暫時性狀況，請稍後重試。您的本機考試與歷史紀錄完好無損。',
            canRetrySync: true,
          };
        }

        return {
          success: false,
          status: 'failed',
          errorCode: syncErr?.code ? String(syncErr.code) : undefined,
          message:
            syncErr?.message ||
            '向 Apple 伺服器同步購買紀錄失敗，請確認網路連線或稍後再試。',
          canRetrySync: true,
        };
      }

      // 同步完成後，取得更新後之購買清單
      if (typeof expoIap.getAvailablePurchases === 'function') {
        purchases = await expoIap.getAvailablePurchases();
      }

      if (!Array.isArray(purchases) || purchases.length === 0) {
        return {
          success: true,
          status: 'no_purchases',
          message: '已向 Apple 伺服器完成同步，未查詢到任何 App Store 購買紀錄。',
        };
      }

      return await this.validateAndApplyPurchases(purchases, expoIap);
    } catch (globalErr: any) {
      console.error('[StoreKit] 恢復購買流程異常:', globalErr);
      return {
        success: false,
        status: 'failed',
        message: globalErr?.message || '恢復購買時發生未預期錯誤，請稍後再試。',
      };
    } finally {
      this.isRestoring = false;
    }
  }

  /**
   * 批次校驗購買項目並計算最高會員權益
   */
  private async validateAndApplyPurchases(
    purchases: any[],
    expoIap: any,
  ): Promise<RestoreResult> {
    const validPurchases: any[] = [];
    const tokenMap = new Map<string, string>();
    let latestProofToken: string | undefined;
    let hasExpiredTransaction = false;
    let expiredSubCandidate: any = null;
    let hasVerificationError = false;
    let lastVerifyErrorMsg: string | undefined;

    for (const p of purchases) {
      // 忽略已被 Apple 標記撤銷退款的項目
      if (p.revocationDateIOS != null) {
        continue;
      }

      const check = await this.validator.validate(p);
      if (check.valid) {
        validPurchases.push(p);
        if (check.proofToken) {
          latestProofToken = check.proofToken;
          if (p.id) tokenMap.set(p.id, check.proofToken);
          if (p.transactionId) tokenMap.set(p.transactionId, check.proofToken);
          if (p.originalTransactionIdentifierIOS) {
            tokenMap.set(p.originalTransactionIdentifierIOS, check.proofToken);
          }
        }
        // 確保交易在 StoreKit 隊列中被 finish
        try {
          if (typeof expoIap.finishTransaction === 'function') {
            await expoIap.finishTransaction({ purchase: p, isConsumable: false });
          }
        } catch {
          // 忽略已完成的交易例外
        }
      } else if (check.status === 'expired') {
        hasExpiredTransaction = true;
        if (!expiredSubCandidate) {
          expiredSubCandidate = p;
        }
      } else {
        hasVerificationError = true;
        lastVerifyErrorMsg = check.reason;
      }
    }

    // 評估有效購買中最高且最新的權益方案
    if (validPurchases.length > 0) {
      const evalResult = evaluatePurchasesEntitlement(validPurchases);

      if (evalResult.status === 'active' && evalResult.subscription) {
        const winningTxnId = evalResult.subscription.transactionId;
        const winningOrigId = evalResult.subscription.originalTransactionId;
        const matchedProofToken =
          (winningTxnId ? tokenMap.get(winningTxnId) : undefined) ||
          (winningOrigId ? tokenMap.get(winningOrigId) : undefined) ||
          latestProofToken;

        const activeSub: UserSubscription = {
          ...evalResult.subscription,
          proofToken: matchedProofToken,
        };
        invalidateInflightSyncRequests();
        return {
          success: true,
          status: 'success',
          subscription: activeSub,
          message:
            evalResult.tier === 'lifetime'
              ? '已成功恢復您的「終身買斷版 (Lifetime)」專屬會員權益！'
              : '已成功恢復您的「Pro 會員」專屬方案權益！',
        };
      }

      if (evalResult.status === 'expired') {
        return {
          success: true,
          status: 'expired',
          subscription: evalResult.subscription,
          message:
            '您的歷史訂閱已到期，系統已自動維持在免費版。您的所有歷史考試與讀書紀錄均完整保留。',
        };
      }
    }

    // 若無有效購買，但有後端確認已到期的訂閱紀錄
    if (hasExpiredTransaction && expiredSubCandidate) {
      const isYearly = expiredSubCandidate.productId === STOREKIT_PRODUCT_IDS.YEARLY;
      const expiredSub: UserSubscription = {
        plan: 'pro',
        billingCycle: isYearly ? 'annual' : 'monthly',
        status: 'expired',
        expiresAt: new Date(
          expiredSubCandidate.expirationDateIOS ??
            expiredSubCandidate.transactionDate ??
            Date.now(),
        ).toISOString(),
        productId: expiredSubCandidate.productId,
        transactionId: expiredSubCandidate.id,
        originalTransactionId:
          expiredSubCandidate.originalTransactionIdentifierIOS ?? expiredSubCandidate.id,
        purchaseDate: new Date(
          expiredSubCandidate.transactionDate || Date.now(),
        ).toISOString(),
        isAutoRenewing: false,
      };
      return {
        success: true,
        status: 'expired',
        subscription: expiredSub,
        message:
          '您的歷史訂閱已到期，系統已自動維持在免費版。您的所有歷史考試與讀書紀錄均完整保留。',
      };
    }

    // 若有紀錄但皆未通過後端簽章校驗
    if (hasVerificationError) {
      return {
        success: false,
        status: 'verification_failed',
        message:
          lastVerifyErrorMsg ||
          'App Store 購買憑證未能通過伺服器安全驗證，無法恢復會員權益。',
      };
    }

    return {
      success: true,
      status: 'no_purchases',
      message: '未查詢到有效的 App Store 購買紀錄。',
    };
  }

  getStoreStatus(): StoreStatus {
    const native = isStoreKitNativeAvailable();
    if (this.devModeForced) {
      return {
        isConnected: false,
        isNativeAvailable: native,
        environment: 'dev_preview',
        notice: '目前已手動切換為開發測試模式。可自由模擬各項會員狀態與到期情境。',
      };
    }

    if (!native) {
      return {
        isConnected: false,
        isNativeAvailable: false,
        environment: 'expo_go',
        notice:
          'Expo Go 不支援 Apple 原生 In-App Purchase 模組。若需測試真實 StoreKit 金流，請使用 Development Build (npx expo run:ios) 搭配 StoreKit.storekit。目前已自動啟用測試預覽模式。',
      };
    }

    return {
      isConnected: this.isInitialized,
      isNativeAvailable: true,
      environment: 'sandbox',
      notice: 'Apple StoreKit 2 已連線。支援 App Store 沙盒與本機 StoreKit Configuration 測試。',
    };
  }

  async manageSubscriptions(): Promise<void> {
    if (!this.isDevPreviewMode()) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { deepLinkToSubscriptions } = require('expo-iap');
        await deepLinkToSubscriptions();
        return;
      } catch {
        // deepLinkToSubscriptions 失敗時平滑回退至官方網址
      }
    }

    try {
      await Linking.openURL(APPLE_MANAGE_SUBSCRIPTIONS_URL);
    } catch {
      // 忽略開啟失敗
    }
  }
}

export const storeKitService: IStoreKitService = new ProductionStoreKitService();
