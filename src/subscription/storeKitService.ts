import { Linking, Platform } from 'react-native';
import {
  ALL_STOREKIT_PRODUCT_IDS,
  APPLE_MANAGE_SUBSCRIPTIONS_URL,
  isValidProductId,
  STOREKIT_PRODUCT_IDS,
} from './storeKitConfig';
import { SUBSCRIPTION_PRODUCTS } from './products';
import type { PlanTier, ProductDefinition, UserSubscription } from './types';

export interface PurchaseResult {
  success: boolean;
  status: 'success' | 'cancelled' | 'failed' | 'deferred' | 'pending';
  subscription?: UserSubscription;
  transactionId?: string;
  productId?: string;
  message: string;
}

export interface RestoreResult {
  success: boolean;
  status: 'success' | 'no_purchases' | 'expired' | 'failed';
  subscription?: UserSubscription;
  message: string;
}

export interface StoreStatus {
  isConnected: boolean;
  isNativeAvailable: boolean;
  environment: 'sandbox' | 'production' | 'dev_preview' | 'expo_go';
  notice: string;
}

/**
 * 伺服器端與客戶端憑證驗證介面（保留未來 App Store Server API 擴充彈性）
 */
export interface ITransactionValidator {
  validate(purchase: unknown): Promise<{ valid: boolean; reason?: string }>;
}

/**
 * 客戶端預設交易驗證器（基礎格式與時序校驗）
 */
export class ClientSideTransactionValidator implements ITransactionValidator {
  async validate(purchase: any): Promise<{ valid: boolean; reason?: string }> {
    if (!purchase || !purchase.productId) {
      return { valid: false, reason: '無效的交易資訊。' };
    }
    if (!isValidProductId(purchase.productId)) {
      return { valid: false, reason: '未知的產品識別碼。' };
    }
    if (purchase.revocationDateIOS != null) {
      return { valid: false, reason: '此交易已被 Apple 撤銷或退款。' };
    }
    return { valid: true };
  }
}

/**
 * 預留未來後端伺服器驗證器（App Store Server API / Notifications V2）
 */
export class ServerSideTransactionValidator implements ITransactionValidator {
  constructor(private readonly apiEndpoint: string) {}

  async validate(purchase: any): Promise<{ valid: boolean; reason?: string }> {
    if (!this.apiEndpoint) {
      return { valid: true };
    }
    // 未來部署後端時：
    // const res = await fetch(`${this.apiEndpoint}/api/iap/verify-receipt`, {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify({ transactionId: purchase.id, purchaseToken: purchase.purchaseToken }),
    // });
    return { valid: true };
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
 * 評估 App Store 回傳之歷史購買紀錄以決定有效會員權限
 * 規則：
 * 1. 若曾退款或撤銷（revocationDateIOS != null），不給予權限。
 * 2. Lifetime 非消耗型買斷：永久具備 lifetime 權限，無過期時間。
 * 3. Pro 月/年訂閱：檢查 expirationDateIOS，未到期給予 pro 權限，已到期則降為 free。
 * 4. 重要資料保護原則：降為 free 時絕不刪除既有考試或任務。
 */
export function evaluatePurchasesEntitlement(purchases: any[]): {
  tier: PlanTier;
  subscription?: UserSubscription;
  status: 'active' | 'expired' | 'none';
} {
  if (!Array.isArray(purchases) || purchases.length === 0) {
    return { tier: 'free', status: 'none' };
  }

  // 1. 優先檢查終身買斷版（非消耗型）
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
      purchaseDate: new Date(lifetimePurchase.transactionDate).toISOString(),
    };
    return { tier: 'lifetime', subscription: sub, status: 'active' };
  }

  // 2. 檢查有效訂閱（過濾已被 Apple 撤銷的項目）
  const now = Date.now();
  const validSubs = purchases
    .filter(
      (p) =>
        (p.productId === STOREKIT_PRODUCT_IDS.YEARLY ||
          p.productId === STOREKIT_PRODUCT_IDS.MONTHLY) &&
        p.revocationDateIOS == null,
    )
    .sort((a, b) => (b.expirationDateIOS ?? 0) - (a.expirationDateIOS ?? 0));

  for (const p of validSubs) {
    const isYearly = p.productId === STOREKIT_PRODUCT_IDS.YEARLY;
    const expMs: number =
      p.expirationDateIOS ??
      p.transactionDate + (isYearly ? 365 : 30) * 86400 * 1000;

    if (expMs > now) {
      // 仍在有效期間
      const sub: UserSubscription = {
        plan: 'pro',
        billingCycle: isYearly ? 'annual' : 'monthly',
        status: 'active',
        expiresAt: new Date(expMs).toISOString(),
        productId: p.productId,
        transactionId: p.id,
        originalTransactionId:
          p.originalTransactionIdentifierIOS ?? p.id,
        purchaseDate: new Date(p.transactionDate).toISOString(),
        isAutoRenewing: Boolean(p.isAutoRenewing),
      };
      return { tier: 'pro', subscription: sub, status: 'active' };
    }
  }

  // 若有訂閱但已過期
  if (validSubs.length > 0) {
    const lastSub = validSubs[0];
    const isYearly = lastSub.productId === STOREKIT_PRODUCT_IDS.YEARLY;
    const sub: UserSubscription = {
      plan: 'pro',
      billingCycle: isYearly ? 'annual' : 'monthly',
      status: 'expired',
      expiresAt: new Date(lastSub.expirationDateIOS ?? lastSub.transactionDate).toISOString(),
      productId: lastSub.productId,
      transactionId: lastSub.id,
      originalTransactionId: lastSub.originalTransactionIdentifierIOS ?? lastSub.id,
    };
    return { tier: 'free', subscription: sub, status: 'expired' };
  }

  return { tier: 'free', status: 'none' };
}

export interface IStoreKitService {
  init(): Promise<boolean>;
  getProducts(): Promise<ProductDefinition[]>;
  purchase(productId: string): Promise<PurchaseResult>;
  restorePurchases(): Promise<RestoreResult>;
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

  async restorePurchases(): Promise<RestoreResult> {
    return {
      success: true,
      status: 'no_purchases',
      message: '【測試預覽】已檢查購買紀錄。目前無歷史 App Store 收據。',
    };
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
  private validator: ITransactionValidator = new ClientSideTransactionValidator();

  constructor(validator?: ITransactionValidator) {
    if (validator) this.validator = validator;
  }

  setDevPreviewMode(enabled: boolean): void {
    this.devModeForced = enabled;
  }

  isDevPreviewMode(): boolean {
    if (this.devModeForced) return true;
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

          // 評估授權等級
          const ent = evaluatePurchasesEntitlement([purchase]);

          // 完成 StoreKit 交易，從 Apple 佇列中移除
          try {
            await finishTransaction({ purchase, isConsumable: false });
          } catch (finErr) {
            console.warn('[StoreKit] finishTransaction 失敗:', finErr);
          }

          isResolved = true;
          cleanup();
          resolve({
            success: true,
            status: 'success',
            subscription: ent.subscription,
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

  async restorePurchases(): Promise<RestoreResult> {
    if (this.isDevPreviewMode()) {
      return this.devService.restorePurchases();
    }

    try {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const {
        restorePurchases,
        getAvailablePurchases,
        finishTransaction,
      } = require('expo-iap');
      /* eslint-enable @typescript-eslint/no-require-imports */

      await this.init();

      // 向 App Store 請求同步收據與歷史交易
      await restorePurchases();

      // 取得使用者當前所有有效與歷史購買
      const purchases: any[] = await getAvailablePurchases();

      if (!Array.isArray(purchases) || purchases.length === 0) {
        return {
          success: true,
          status: 'no_purchases',
          message: '未查詢到未過期的 App Store 購買紀錄。若您使用不同 Apple ID，請切換帳號後重試。',
        };
      }

      // 驗證並評估權限
      const validPurchases: any[] = [];
      for (const p of purchases) {
        const check = await this.validator.validate(p);
        if (check.valid) {
          validPurchases.push(p);
          // 確保未結算的交易被正常標記完成
          try {
            await finishTransaction({ purchase: p, isConsumable: false });
          } catch {
            // 已結算之交易略過
          }
        }
      }

      const evalResult = evaluatePurchasesEntitlement(validPurchases);

      if (evalResult.status === 'active' && evalResult.subscription) {
        return {
          success: true,
          status: 'success',
          subscription: evalResult.subscription,
          message: '已成功恢復您的會員方案權益！',
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

      return {
        success: true,
        status: 'no_purchases',
        message: '未查詢到有效的 App Store 購買紀錄。',
      };
    } catch (error: any) {
      return {
        success: false,
        status: 'failed',
        message: error?.message || '恢復購買失敗，請檢查網路連線後再試。',
      };
    }
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
