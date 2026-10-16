import type { AppData } from '../types/models';
import { PLAN_ENTITLEMENTS } from './products';
import type { AiQuotaStatus, AiUsageRecord, PlanEntitlements, PlanTier, UserSubscription } from './types';

/**
 * 取得指定方案的權限定義
 */
export function getPlanEntitlements(tier: PlanTier = 'free'): PlanEntitlements {
  return PLAN_ENTITLEMENTS[tier] ?? PLAN_ENTITLEMENTS.free;
}

/**
 * 檢查使用者目前訂閱是否處於有效啟用狀態
 */
export function isSubscriptionActive(sub?: UserSubscription): boolean {
  if (!sub) return false;
  if (sub.plan === 'lifetime') return true;
  if (sub.plan === 'pro') {
    if (sub.status === 'active') return true;
    if (sub.expiresAt) {
      return new Date(sub.expiresAt).getTime() > Date.now();
    }
  }
  return false;
}

/**
 * 取得當前有效方案等級（若訂閱過期則降回 free）
 */
export function getEffectiveTier(sub?: UserSubscription): PlanTier {
  if (!sub) return 'free';
  if (sub.plan === 'lifetime') return 'lifetime';
  if (sub.plan === 'pro') {
    return isSubscriptionActive(sub) ? 'pro' : 'free';
  }
  return 'free';
}

export interface ExamCreationCheckResult {
  allowed: boolean;
  maxAllowed: number;
  currentActiveCount: number;
  reason?: string;
}

/**
 * 檢查是否可以建立新考試計畫
 * 規則：
 * 1. 免費版上限為 1 場進行中（未封存）考試。
 * 2. 達到上限時明確提示，引導升級或封存既有考試。
 * 3. 既有考試資料絕對不可被刪除或損壞（包含降級使用者已有之多場考試）。
 */
export function canCreateExam(data: AppData): ExamCreationCheckResult {
  const tier = getEffectiveTier(data.subscription);
  const entitlements = getPlanEntitlements(tier);

  // 若目前僅有 demo 資料，建立新考試時會乾淨替換 demo，故算作 0 場既有自訂考試
  const isOnlyDemo =
    data.isDemo || (data.exams.length === 1 && data.exams[0].id === 'demo-toeic');
  const realExams = isOnlyDemo ? [] : data.exams;

  const activeExams = realExams.filter((e) => !e.archived);
  const currentActiveCount = activeExams.length;

  if (currentActiveCount >= entitlements.maxActiveExams) {
    return {
      allowed: false,
      maxAllowed: entitlements.maxActiveExams,
      currentActiveCount,
      reason: `免費版支援 ${entitlements.maxActiveExams} 場進行中的考試計畫。升級至 Pro 方案即可建立無限場考試，或將現有考試「封存」後再建立新目標。`,
    };
  }

  return {
    allowed: true,
    maxAllowed: entitlements.maxActiveExams,
    currentActiveCount,
  };
}

/**
 * 檢查是否可以解除封存指定考試
 * 規則：
 * 1. 免費版進行中考試最多 1 場。
 * 2. 若當前進行中考試已達方案上限，不可解除封存，需提示先封存目前考試或升級 Pro。
 */
export function canUnarchiveExam(data: AppData): ExamCreationCheckResult {
  const tier = getEffectiveTier(data.subscription);
  const entitlements = getPlanEntitlements(tier);

  const isOnlyDemo =
    data.isDemo || (data.exams.length === 1 && data.exams[0].id === 'demo-toeic');
  const realExams = isOnlyDemo ? [] : data.exams;

  const activeExams = realExams.filter((e) => !e.archived);
  const currentActiveCount = activeExams.length;

  if (currentActiveCount >= entitlements.maxActiveExams) {
    return {
      allowed: false,
      maxAllowed: entitlements.maxActiveExams,
      currentActiveCount,
      reason: `免費版支援最多 ${entitlements.maxActiveExams} 場進行中的考試計畫。請先將現有進行中的考試「封存」，或升級至 Pro 方案解鎖無限場考試。`,
    };
  }

  return {
    allowed: true,
    maxAllowed: entitlements.maxActiveExams,
    currentActiveCount,
  };
}

/**
 * 檢查是否可使用「智慧重新排程」功能
 */
export function canUseSmartReschedule(sub?: UserSubscription): {
  allowed: boolean;
  reason?: string;
} {
  const tier = getEffectiveTier(sub);
  const entitlements = getPlanEntitlements(tier);

  if (!entitlements.hasSmartReschedule) {
    return {
      allowed: false,
      reason: '「智慧重新排程」為 Pro 與 Lifetime 會員專屬功能，能自動平衡落後章節並提供前後每日讀書負荷對比。',
    };
  }
  return { allowed: true };
}

/**
 * 檢查是否可查看 AI 個人化讀書建議
 */
export function canAccessAiRecommendations(sub?: UserSubscription): {
  allowed: boolean;
  reason?: string;
} {
  const tier = getEffectiveTier(sub);
  const entitlements = getPlanEntitlements(tier);

  if (!entitlements.hasAiRecommendations) {
    return {
      allowed: false,
      reason: '「AI 個人化讀書建議」為 Pro 與 Lifetime 會員專屬功能。',
    };
  }
  return { allowed: true };
}

/**
 * 檢查是否可存取進階學習報告與統計
 */
export function canAccessAdvancedAnalytics(sub?: UserSubscription): {
  allowed: boolean;
  reason?: string;
} {
  const tier = getEffectiveTier(sub);
  const entitlements = getPlanEntitlements(tier);

  if (!entitlements.hasAdvancedAnalytics) {
    return {
      allowed: false,
      reason: '「各科弱項深入分析與多目標對比報告」為 Pro 會員專屬功能。',
    };
  }
  return { allowed: true };
}

/**
 * 計算當前 AI 用量狀態與額度
 */
/**
 * 計算當前 AI 用量狀態與額度
 */
export function getAiQuotaStatus(
  arg1?: AiUsageRecord | UserSubscription,
  arg2?: UserSubscription | AiUsageRecord,
  currentMonth: string = new Date().toISOString().slice(0, 7), // 'YYYY-MM'
): AiQuotaStatus {
  let sub: UserSubscription | undefined;
  let usage: AiUsageRecord | undefined;

  if (arg1 && 'plan' in arg1) {
    sub = arg1 as UserSubscription;
    usage = (arg2 && 'monthlyCalls' in arg2 ? arg2 : undefined) as AiUsageRecord | undefined;
  } else if (arg2 && 'plan' in arg2) {
    sub = arg2 as UserSubscription;
    usage = (arg1 && 'monthlyCalls' in arg1 ? arg1 : undefined) as AiUsageRecord | undefined;
  } else {
    usage = arg1 as AiUsageRecord | undefined;
    sub = arg2 as UserSubscription | undefined;
  }

  const tier = getEffectiveTier(sub);
  const entitlements = getPlanEntitlements(tier);
  const limit = entitlements.aiMonthlyQuota;

  const used =
    usage && usage.lastResetMonth === currentMonth ? usage.monthlyCalls : 0;
  const remaining = Math.max(0, limit - used);
  const isExceeded = limit > 0 ? used >= limit : true;

  // 下個月 1 日重設
  const [year, month] = currentMonth.split('-').map(Number);
  const nextMonth =
    month === 12
      ? `${year + 1}-01-01`
      : `${year}-${String(month + 1).padStart(2, '0')}-01`;

  return {
    used,
    limit,
    remaining,
    isExceeded,
    resetsAt: nextMonth,
  };
}

/**
 * 檢查外部 AI 呼叫權限與額度
 */
export function checkAiAccess(
  arg1?: AiUsageRecord | UserSubscription,
  arg2?: UserSubscription | AiUsageRecord,
  currentMonth?: string,
): { allowed: boolean; canUse: boolean; reason?: string } {
  let sub: UserSubscription | undefined;
  let usage: AiUsageRecord | undefined;

  if (arg1 && 'plan' in arg1) {
    sub = arg1 as UserSubscription;
    usage = (arg2 && 'monthlyCalls' in arg2 ? arg2 : undefined) as AiUsageRecord | undefined;
  } else if (arg2 && 'plan' in arg2) {
    sub = arg2 as UserSubscription;
    usage = (arg1 && 'monthlyCalls' in arg1 ? arg1 : undefined) as AiUsageRecord | undefined;
  } else {
    usage = arg1 as AiUsageRecord | undefined;
    sub = arg2 as UserSubscription | undefined;
  }

  const tier = getEffectiveTier(sub);
  const quota = getAiQuotaStatus(usage, sub, currentMonth);

  if (tier === 'free') {
    return {
      allowed: false,
      canUse: false,
      reason: '免費版目前使用本機確定性規則排程，未開放外部 AI 深度規劃功能。',
    };
  }

  if (quota.isExceeded) {
    return {
      allowed: false,
      canUse: false,
      reason: `本月 AI 深度規劃額度已達上限（${quota.limit} 次/月），將於 ${quota.resetsAt} 自動重設。所有既有排程與本機讀書功能依然完全正常運作。`,
    };
  }

  return { allowed: true, canUse: true };
}
