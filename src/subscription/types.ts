/**
 * 訂閱方案與權限型別定義
 */

export type PlanTier = 'free' | 'pro' | 'lifetime';

export type BillingPeriod = 'monthly' | 'annual' | 'lifetime' | 'none';

export type SubscriptionStatus = 'active' | 'expired' | 'canceled' | 'none';

export interface UserSubscription {
  plan: PlanTier;
  billingCycle: BillingPeriod;
  status: SubscriptionStatus;
  expiresAt?: string;
  isDevPreview?: boolean;
  productId?: string;
  originalTransactionId?: string;
  transactionId?: string;
  purchaseDate?: string;
  isAutoRenewing?: boolean;
  revocationDate?: string;
  proofToken?: string;
}

export interface AiUsageRecord {
  monthlyCalls: number;
  lastResetMonth: string; // 'YYYY-MM'
}

export interface PlanEntitlements {
  tier: PlanTier;
  displayName: string;
  maxActiveExams: number;
  hasSmartReschedule: boolean;
  hasAiRecommendations: boolean;
  hasSprintPlanner: boolean;
  hasAdvancedAnalytics: boolean;
  hasCloudSync: boolean | 'future';
  aiMonthlyQuota: number;
  isCoreFeaturesPermanent: boolean;
  cloudSyncNote: string;
  aiPolicyNote: string;
}

export interface ProductDefinition {
  id: string;
  tier: PlanTier;
  period: BillingPeriod;
  title: string;
  priceFormatted: string;
  priceAmount: number;
  currency: string;
  badge?: string;
  description: string;
  features: string[];
}

export interface AiQuotaStatus {
  used: number;
  limit: number;
  remaining: number;
  isExceeded: boolean;
  resetsAt: string;
}
