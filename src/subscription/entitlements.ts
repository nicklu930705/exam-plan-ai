import type { AppData } from '../types/models';
import { PLAN_ENTITLEMENTS } from './products';
import { STOREKIT_PRODUCT_IDS } from './storeKitConfig';
import type { AiQuotaStatus, AiUsageRecord, PlanEntitlements, PlanTier, UserSubscription } from './types';

/**
 * 取得指定方案的權限定義
 */
export function getPlanEntitlements(tier: PlanTier = 'free'): PlanEntitlements {
  return PLAN_ENTITLEMENTS[tier] ?? PLAN_ENTITLEMENTS.free;
}

/**
 * 安全解碼 Base64URL 字串 (相容 Node.js、Jest 與 React Native Hermes)
 */
export function decodeBase64Url(str: string): string {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
  const fullBase64 = base64 + pad;

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(fullBase64, 'base64').toString('utf8');
  }
  if (typeof atob === 'function') {
    return atob(fullBase64);
  }
  throw new Error('當前環境不支援 Base64 解碼');
}

/**
 * 客戶端解析並校驗 Proof Token 結構與效期
 *
 * 安全聲明：
 * 本函式僅執行客戶端可驗證的結構檢查（Base64URL 結構、欄位存在性、原交易 ID 相符性與權杖有效期限）。
 * 真正的 HMAC-SHA256 數位簽章防偽驗證與 Redis 退款/撤銷狀態查詢，嚴格由後端伺服器（APP_SERVER_SECRET）
 * 在呼叫 /api/verify-transaction 或 /api/study-advice 時進行權威校驗，絕不在客戶端以假驗證取代真簽章。
 */
export function inspectProofToken(token?: string): {
  valid: boolean;
  userId?: string;
  originalTransactionId?: string;
  expiresAt?: number;
  reason?: string;
} {
  if (!token || typeof token !== 'string' || token.trim() === '') {
    return { valid: false, reason: '未提供權杖。' };
  }

  const parts = token.trim().split('.');
  if (parts.length !== 2) {
    return { valid: false, reason: '權杖格式無效（必須為 payload.signature 雙段格式）。' };
  }

  const [rawPayloadB64, signature] = parts;
  if (!rawPayloadB64 || !signature || signature.trim() === '') {
    return { valid: false, reason: '權杖簽名或內文缺失。' };
  }

  let payloadStr = '';
  try {
    payloadStr = decodeBase64Url(rawPayloadB64);
  } catch {
    return { valid: false, reason: '權杖內文 Base64 解碼失敗。' };
  }

  const segments = payloadStr.split(':');
  if (segments.length < 3) {
    return { valid: false, reason: '權杖內文缺少必要欄位。' };
  }

  const [userId, originalTransactionId, expStr] = segments;
  if (!userId || !originalTransactionId) {
    return { valid: false, reason: '權杖缺少身分或原始交易識別碼。' };
  }

  const expiresAt = parseInt(expStr || '0', 10);
  if (isNaN(expiresAt) || expiresAt <= 0) {
    return { valid: false, reason: '權杖到期時間戳記無效。' };
  }

  if (expiresAt < Date.now()) {
    return { valid: false, userId, originalTransactionId, expiresAt, reason: '權杖已逾期。' };
  }

  return { valid: true, userId, originalTransactionId, expiresAt };
}

/**
 * 檢查使用者目前訂閱是否處於有效啟用狀態
 *
 * 安全強化規則：
 * 1. 若無 subscription 物件或方案為 free，直接判定為非有效。
 * 2. 撤銷與退款即時阻斷：任何方案若已被 Apple 撤銷、退款或有 revocationDate，立即判定為非有效 (退回 free)。
 * 3. 狀態細分：
 *    - 'revoked' / 'refunded'：即刻終止一切付費權益。
 *    - 'expired' / 'none'：已到期或無訂閱，無權益。
 *    - 'active'：有效訂閱中。
 *    - 'canceled'：使用者已停止自動續訂，但在 expiresAt 期限前仍保有完整付費權益，不可提前降級。
 * 4. Pro 訂閱判定：
 *    - status 必須為 'active' 或 'canceled' (未退款撤銷)。
 *    - 必須具備非空且合法的 expiresAt ISO 日期字串。
 *    - 現在時間必須小於到期時間 (Date.now() < Date.parse(expiresAt))。
 *    - 若設定了 purchaseDate，現在時間不得小於購買時間 (防範使用者刻意回撥手機系統時鐘逃避過期)。
 * 5. Lifetime 方案判定：
 *    - status 必須嚴格為 'active'（買斷商品無自動續訂，故無 canceled 狀態）。
 *    - 若為開發預覽模式 (isDevPreview: true)，允許測試。
 *    - 若為正式/Sandbox 購買：
 *      a. 商品 ID 必須為 STOREKIT_PRODUCT_IDS.LIFETIME ('exampro_lifetime')。
 *      b. 必須具有 transactionId 或 originalTransactionId。
 *      c. 必須具備伺服器簽發的有效 proofToken，且其結構未損毀、未逾期，且綁定之 originalTransactionId 與本機紀錄一致。
 *      d. 單純在本地修改 AsyncStorage 注入商品 ID 與偽造交易 ID 而無有效伺服器 Proof Token 者，一律拒絕放行。
 *    - 若設定了 purchaseDate，現在時間不得小於購買時間。
 */
export function isSubscriptionActive(sub?: UserSubscription): boolean {
  if (!sub) return false;

  // 1. 撤銷與退款狀態優先阻斷
  if (sub.revocationDate && typeof sub.revocationDate === 'string' && sub.revocationDate.trim() !== '') {
    return false;
  }
  const status = sub.status?.toLowerCase();
  if (status === 'revoked' || status === 'refunded') {
    return false;
  }
  if (status === 'expired' || status === 'none') {
    return false;
  }

  const now = Date.now();

  // 2. 手機時間異常（時鐘回撥）防護：若系統目前時間小於購買時間，判定為異常狀態不予放行
  if (sub.purchaseDate && typeof sub.purchaseDate === 'string' && sub.purchaseDate.trim() !== '') {
    const purchaseMs = Date.parse(sub.purchaseDate);
    if (!isNaN(purchaseMs) && purchaseMs > 0 && now < purchaseMs) {
      return false;
    }
  }

  // 3. Pro 方案判定：支援 active 與 canceled（取消自動續訂但尚未到期）
  if (sub.plan === 'pro') {
    if (status !== 'active' && status !== 'canceled' && status !== 'cancelled') {
      return false;
    }
    if (!sub.expiresAt || typeof sub.expiresAt !== 'string' || sub.expiresAt.trim() === '') {
      return false;
    }
    const expMs = Date.parse(sub.expiresAt);
    if (isNaN(expMs) || expMs <= 0) {
      return false;
    }
    // 嚴格檢查是否過期
    if (expMs <= now) {
      return false;
    }
    return true;
  }

  // 4. Lifetime 終身方案判定
  if (sub.plan === 'lifetime') {
    if (status !== 'active') {
      return false;
    }

    // A. 開發測試模式 (isDevPreview: true)
    if (sub.isDevPreview === true) {
      return true;
    }

    // B. 正式 / Sandbox 驗證：
    // 1) 商品 ID 必須為官方終身版
    const isMatchingProduct =
      sub.productId === STOREKIT_PRODUCT_IDS.LIFETIME || sub.productId === 'exampro_lifetime';
    if (!isMatchingProduct) {
      return false;
    }

    // 2) 必須具備有效交易識別碼
    const txnId = sub.originalTransactionId || sub.transactionId;
    if (!txnId || typeof txnId !== 'string' || txnId.trim() === '') {
      return false;
    }

    // 3) 必須具備伺服器簽發的有效 Proof Token (單純有交易 ID 不足以授權)
    if (!sub.proofToken || typeof sub.proofToken !== 'string' || sub.proofToken.trim() === '') {
      return false;
    }

    const tokenInspection = inspectProofToken(sub.proofToken);
    if (!tokenInspection.valid) {
      return false;
    }

    // 4) 權杖內部綁定的原始交易 ID 必須與本機物件相符
    const targetOrigId = sub.originalTransactionId || sub.transactionId;
    if (tokenInspection.originalTransactionId !== targetOrigId) {
      return false;
    }

    return true;
  }

  return false;
}

/**
 * 取得當前有效方案等級（若訂閱過期或未通過有效性驗證則降回 free）
 */
export function getEffectiveTier(sub?: UserSubscription): PlanTier {
  if (!sub) return 'free';
  if (!isSubscriptionActive(sub)) return 'free';
  if (sub.plan === 'lifetime') return 'lifetime';
  if (sub.plan === 'pro') return 'pro';
  return 'free';
}

/**
 * 本機快取載入時的規範化處理
 * 當 App 啟動自 AsyncStorage 載入 subscription 時呼叫：
 * 1. 若為 Pro 訂閱：
 *    - 若仍在有效期限內 (active 或 canceled)，保留原狀態，使用者繼續享有付費權益。
 *    - 若已過期，自動更新 status 為 'expired'，有效方案退回 free。
 *    - 若被 Apple 撤銷或退款，標記為 'revoked' 或 'refunded'。
 * 2. 若為 Lifetime 方案：
 *    - 若未通過驗證 (例如手動竄改 AsyncStorage 缺乏有效伺服器 Proof Token)，降為 free 方案，
 *      但保留其歷史交易識別碼等欄位，以便未來透過 StoreKit「恢復購買」重新向 Apple 驗證。
 *    - 若已被撤銷或退款，標記為 'revoked' 或 'refunded'。
 * 3. 完整保留使用者的歷史交易識別碼、產品 ID 與到期日等紀錄，絕不損毀歷史資料。
 */
export function normalizeSubscriptionOnLoad(sub?: UserSubscription): UserSubscription {
  if (!sub) {
    return {
      plan: 'free',
      billingCycle: 'none',
      status: 'none',
    };
  }

  if (sub.plan === 'pro') {
    if (!isSubscriptionActive(sub)) {
      const isRevoked =
        sub.status === 'revoked' ||
        sub.status === 'refunded' ||
        Boolean(sub.revocationDate && sub.revocationDate.trim() !== '');
      return {
        ...sub,
        status: isRevoked ? (sub.status === 'refunded' ? 'refunded' : 'revoked') : 'expired',
      };
    }
    return sub;
  }

  if (sub.plan === 'lifetime') {
    if (!isSubscriptionActive(sub)) {
      const isRevoked =
        sub.status === 'revoked' ||
        sub.status === 'refunded' ||
        Boolean(sub.revocationDate && sub.revocationDate.trim() !== '');
      return {
        ...sub,
        plan: 'free',
        billingCycle: 'none',
        status: isRevoked ? (sub.status === 'refunded' ? 'refunded' : 'revoked') : 'none',
      };
    }
    return sub;
  }

  return sub;
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
