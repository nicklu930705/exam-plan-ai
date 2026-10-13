/**
 * Apple StoreKit 產品設定常數與設定檔
 * 集中管理所有 In-App Purchase 產品 ID，避免在程式碼各處寫死不同字串。
 */

export const STOREKIT_PRODUCT_IDS = {
  MONTHLY: 'exampro_monthly',
  YEARLY: 'exampro_yearly',
  LIFETIME: 'exampro_lifetime',
} as const;

export type StoreKitProductId =
  (typeof STOREKIT_PRODUCT_IDS)[keyof typeof STOREKIT_PRODUCT_IDS];

/**
 * 所有 App Store 產品 ID 清單
 */
export const ALL_STOREKIT_PRODUCT_IDS: readonly StoreKitProductId[] = [
  STOREKIT_PRODUCT_IDS.MONTHLY,
  STOREKIT_PRODUCT_IDS.YEARLY,
  STOREKIT_PRODUCT_IDS.LIFETIME,
] as const;

/**
 * 自動續訂型訂閱產品 ID
 */
export const SUBSCRIPTION_SKUS: readonly string[] = [
  STOREKIT_PRODUCT_IDS.MONTHLY,
  STOREKIT_PRODUCT_IDS.YEARLY,
] as const;

/**
 * 非消耗型（一次性買斷）產品 ID
 */
export const NON_CONSUMABLE_SKUS: readonly string[] = [
  STOREKIT_PRODUCT_IDS.LIFETIME,
] as const;

/**
 * Apple 官方訂閱管理頁面 Deep Link 與網址
 */
export const APPLE_MANAGE_SUBSCRIPTIONS_URL =
  'https://apps.apple.com/account/subscriptions';

/**
 * 檢查給定的 ID 是否為合法的 StoreKit 產品 ID
 */
export function isValidProductId(id: string): id is StoreKitProductId {
  return (ALL_STOREKIT_PRODUCT_IDS as readonly string[]).includes(id);
}
