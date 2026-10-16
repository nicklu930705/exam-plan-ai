import { STOREKIT_PRODUCT_IDS } from './storeKitConfig';
import type { PlanEntitlements, PlanTier, ProductDefinition } from './types';

/**
 * 產品方案目錄
 * 價格為預設/離線產品設定，正式環境由 Apple StoreKit 產品查詢回傳即時在地化價格更新。
 */
export const SUBSCRIPTION_PRODUCTS: ProductDefinition[] = [
  {
    id: 'examplan_free',
    tier: 'free',
    period: 'none',
    title: 'Free 免費版',
    priceFormatted: 'NT$0',
    priceAmount: 0,
    currency: 'TWD',
    description: '基礎備考管理，適合單一目標的日常規律複習。',
    features: [
      '1 個進行中考試計畫',
      '科目與章節手動管理',
      '基礎自動排程與每日任務',
      '專注讀書計時器',
      '基本進度達成率統計',
      '自由調整預估與實際研讀時間',
      '每日 3 次 AI 讀書建議（雲端智慧分析）',
    ],
  },
  {
    id: STOREKIT_PRODUCT_IDS.MONTHLY,
    tier: 'pro',
    period: 'monthly',
    title: 'Pro 月訂閱',
    priceFormatted: 'NT$149 / 月',
    priceAmount: 149,
    currency: 'TWD',
    description: '完整解鎖多目標備考、智慧重新排程與個人化學習建議。',
    features: [
      '無限進行中考試計畫',
      '智慧重新排程與落後進度自動平衡',
      'AI 個人化讀書建議與衝刺提醒',
      '各科目弱項掌握度深度報告',
      '每日 15 次進階 AI 規劃配額（午夜自動重設）',
      '未來支援雲端跨裝置備份（後端建置後）',
    ],
  },
  {
    id: STOREKIT_PRODUCT_IDS.YEARLY,
    tier: 'pro',
    period: 'annual',
    title: 'Pro 年訂閱',
    priceFormatted: 'NT$990 / 年',
    priceAmount: 990,
    currency: 'TWD',
    badge: '最划算 · 省 45%',
    description: '長期備考超值首選，平均每月僅約 NT$82.5。',
    features: [
      '涵蓋所有 Pro 版完整功能',
      '無限考試計畫與多目標時間平衡',
      '智慧重新排程與負荷對比',
      'AI 個人化建議（每日 15 次配額）與弱項衝刺計畫',
      '進階學習效益與投入比分析',
      '優先體驗未來新增功能',
    ],
  },
  {
    id: STOREKIT_PRODUCT_IDS.LIFETIME,
    tier: 'lifetime',
    period: 'lifetime',
    title: 'Lifetime 終身買斷版',
    priceFormatted: 'NT$1,690 一次性購買',
    priceAmount: 1690,
    currency: 'TWD',
    badge: '一次買斷 · 永久享有',
    description: '一次購買，永久解鎖本機核心 Pro 備考引擎與多考試管理。',
    features: [
      '永久享有無限考試計畫管理',
      '永久享有智慧重新排程與任務微調',
      '永久享有弱項掌握度與進階進度儀表',
      '每日 15 次 AI 輔助規劃配額（或自備 API 金鑰）',
      '未來核心 App 功能更新永久免費',
    ],
  },
];

/**
 * 各方案權限定義
 */
export const PLAN_ENTITLEMENTS: Record<PlanTier, PlanEntitlements> = {
  free: {
    tier: 'free',
    displayName: '免費版',
    maxActiveExams: 1,
    hasSmartReschedule: false,
    hasAiRecommendations: false,
    hasSprintPlanner: false,
    hasAdvancedAnalytics: false,
    hasCloudSync: false,
    aiMonthlyQuota: 0,
    isCoreFeaturesPermanent: true,
    cloudSyncNote: '免費版資料安全儲存於 iPhone 本機。',
    aiPolicyNote: '免費版享有每日 3 次 AI 雲端讀書建議（台北時間午夜自動重設）。',
  },
  pro: {
    tier: 'pro',
    displayName: 'Pro 訂閱版',
    maxActiveExams: Infinity,
    hasSmartReschedule: true,
    hasAiRecommendations: true,
    hasSprintPlanner: true,
    hasAdvancedAnalytics: true,
    hasCloudSync: 'future',
    aiMonthlyQuota: 100,
    isCoreFeaturesPermanent: false,
    cloudSyncNote: '訂閱期間享有未來雲端多裝置同步權益（後端建置後開放）。',
    aiPolicyNote: '提供每日 15 次 AI 規劃用量上限（每日午夜自動重設）。',
  },
  lifetime: {
    tier: 'lifetime',
    displayName: '終身買斷版',
    maxActiveExams: Infinity,
    hasSmartReschedule: true,
    hasAiRecommendations: true,
    hasSprintPlanner: true,
    hasAdvancedAnalytics: true,
    hasCloudSync: 'future',
    aiMonthlyQuota: 30,
    isCoreFeaturesPermanent: true,
    cloudSyncNote: '永久解鎖所有本機 App 功能；第三方雲端持續伺服器成本保留獨立配套。',
    aiPolicyNote: '本機排程演算法永久可用；第三方 AI 呼叫提供每月 30 次基礎額度或自備金鑰（BYOK）。',
  },
};

/**
 * 依據 Product ID 取得產品規格
 */
export function getProductDefinition(productId: string): ProductDefinition | undefined {
  return SUBSCRIPTION_PRODUCTS.find((p) => p.id === productId);
}
