import { AiCostController } from '../aiCostControl';
import {
  canAccessAdvancedAnalytics,
  canAccessAiRecommendations,
  canCreateExam,
  canUseSmartReschedule,
  checkAiAccess,
  getAiQuotaStatus,
  getEffectiveTier,
  getPlanEntitlements,
  inspectProofToken,
  isSubscriptionActive,
  normalizeSubscriptionOnLoad,
} from '../entitlements';
import { DevStoreKitService } from '../storeKitService';
import type { AiUsageRecord, UserSubscription } from '../types';
import type { AppData, Exam, StudyPreferences, Weekday } from '../../types/models';

// 模擬 AsyncStorage
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

describe('付費方案與權限控制模組 (Subscription & Entitlements)', () => {
  const basePreferences: StudyPreferences = {
    dailyMinutes: 120,
    restDays: [0 as Weekday],
    intensity: 'normal',
  };

  const createDummyExam = (id: string, name: string, archived = false): Exam => ({
    id,
    name,
    examDate: '2026-12-01',
    createdAt: new Date().toISOString(),
    subjects: [
      {
        id: `subj-${id}`,
        name: '測試科目',
        familiarity: 2,
        chapters: [{ id: `chap-${id}`, title: '第一章' }],
      },
    ],
    archived,
  });

  const baseAppData = (overrides?: Partial<AppData>): AppData => ({
    exams: [],
    tasks: [],
    preferences: basePreferences,
    selectedExamId: undefined,
    isDemo: false,
    activeTimer: null,
    subscription: {
      plan: 'free',
      billingCycle: 'none',
      status: 'none',
      isDevPreview: true,
    },
    aiUsage: {
      monthlyCalls: 0,
      lastResetMonth: new Date().toISOString().slice(0, 7),
    },
    ...overrides,
  });

  describe('1. Free 免費版方案規則', () => {
    test('權限定義正確反映免費版限制', () => {
      const entitlements = getPlanEntitlements('free');
      expect(entitlements.maxActiveExams).toBe(1);
      expect(entitlements.hasSmartReschedule).toBe(false);
      expect(entitlements.hasAiRecommendations).toBe(false);
      expect(entitlements.hasSprintPlanner).toBe(false);
      expect(entitlements.hasAdvancedAnalytics).toBe(false);
      expect(entitlements.aiMonthlyQuota).toBe(0);
      expect(entitlements.isCoreFeaturesPermanent).toBe(true);
    });

    test('尚未有考試時，允許建立第一場考試', () => {
      const data = baseAppData();
      const check = canCreateExam(data);
      expect(check.allowed).toBe(true);
      expect(check.currentActiveCount).toBe(0);
      expect(check.maxAllowed).toBe(1);
    });

    test('已有 1 場進行中考試時，禁止建立第 2 場並提供升級或封存說明', () => {
      const data = baseAppData({
        exams: [createDummyExam('exam-1', '托福考試')],
      });
      const check = canCreateExam(data);
      expect(check.allowed).toBe(false);
      expect(check.currentActiveCount).toBe(1);
      expect(check.reason).toContain('免費版支援 1 場進行中的考試計畫');
      expect(check.reason).toContain('Pro');
      expect(check.reason).toContain('封存');
    });

    test('若已有考試處於「已封存」狀態，允許建立新考試', () => {
      const data = baseAppData({
        exams: [
          createDummyExam('exam-old', '已結束的多益', true), // archived = true
        ],
      });
      const check = canCreateExam(data);
      expect(check.allowed).toBe(true);
      expect(check.currentActiveCount).toBe(0);
    });

    test('首次啟動只有 demo 考試時，算作 0 場真實自訂考試，允許建立第一場考試', () => {
      const data = baseAppData({
        isDemo: true,
        exams: [createDummyExam('demo-toeic', '多益示範')],
      });
      const check = canCreateExam(data);
      expect(check.allowed).toBe(true);
      expect(check.currentActiveCount).toBe(0);
    });

    test('免費版嘗試使用智慧重排、AI建議與進階分析時正確受限', () => {
      const sub: UserSubscription = {
        plan: 'free',
        billingCycle: 'none',
        status: 'none',
      };
      expect(canUseSmartReschedule(sub).allowed).toBe(false);
      expect(canAccessAiRecommendations(sub).allowed).toBe(false);
      expect(canAccessAdvancedAnalytics(sub).allowed).toBe(false);

      const quota = getAiQuotaStatus(sub, { monthlyCalls: 0, lastResetMonth: '2026-10' });
      expect(quota.limit).toBe(0);
      expect(quota.remaining).toBe(0);
      expect(quota.isExceeded).toBe(true);
    });
  });

  describe('2. Pro 訂閱版方案規則', () => {
    const activeProSub: UserSubscription = {
      plan: 'pro',
      billingCycle: 'annual',
      status: 'active',
      expiresAt: '2027-10-13T00:00:00.000Z',
    };

    test('權限定義正確反映 Pro 版解鎖項目', () => {
      const entitlements = getPlanEntitlements('pro');
      expect(entitlements.maxActiveExams).toBe(Infinity);
      expect(entitlements.hasSmartReschedule).toBe(true);
      expect(entitlements.hasAiRecommendations).toBe(true);
      expect(entitlements.hasSprintPlanner).toBe(true);
      expect(entitlements.hasAdvancedAnalytics).toBe(true);
      expect(entitlements.aiMonthlyQuota).toBe(100);
      expect(entitlements.cloudSyncNote).toContain('雲端');
    });

    test('有效 Pro 方案允許建立多場考試（2 場、5 場以上均不受限）', () => {
      const data = baseAppData({
        subscription: activeProSub,
        exams: [
          createDummyExam('exam-1', '高考'),
          createDummyExam('exam-2', '日文檢定'),
          createDummyExam('exam-3', '雅思考試'),
        ],
      });
      const check = canCreateExam(data);
      expect(check.allowed).toBe(true);
      expect(check.currentActiveCount).toBe(3);
    });

    test('Pro 方案完整解鎖智慧排程、AI建議與進階分析', () => {
      expect(canUseSmartReschedule(activeProSub).allowed).toBe(true);
      expect(canAccessAiRecommendations(activeProSub).allowed).toBe(true);
      expect(canAccessAdvancedAnalytics(activeProSub).allowed).toBe(true);
    });

    test('Pro 每月 100 次 AI 用量限制與超額保護', () => {
      const currentMonth = new Date().toISOString().slice(0, 7);
      const usageUnder: AiUsageRecord = { monthlyCalls: 45, lastResetMonth: currentMonth };
      const quotaUnder = getAiQuotaStatus(activeProSub, usageUnder);
      expect(quotaUnder.limit).toBe(100);
      expect(quotaUnder.used).toBe(45);
      expect(quotaUnder.remaining).toBe(55);
      expect(quotaUnder.isExceeded).toBe(false);

      const checkOk = checkAiAccess(activeProSub, usageUnder);
      expect(checkOk.allowed).toBe(true);

      const usageExceeded: AiUsageRecord = { monthlyCalls: 100, lastResetMonth: currentMonth };
      const quotaExceeded = getAiQuotaStatus(activeProSub, usageExceeded);
      expect(quotaExceeded.remaining).toBe(0);
      expect(quotaExceeded.isExceeded).toBe(true);

      const checkExceeded = checkAiAccess(activeProSub, usageExceeded);
      expect(checkExceeded.allowed).toBe(false);
      expect(checkExceeded.reason).toContain('已達上限');
    });
  });

  describe('3. Lifetime 終生買斷版方案規則', () => {
    const lifetimeSub: UserSubscription = {
      plan: 'lifetime',
      billingCycle: 'lifetime',
      status: 'active',
      isDevPreview: true,
    };

    test('終生版權限明確區隔本機核心功能與外部 API 成本', () => {
      const entitlements = getPlanEntitlements('lifetime');
      expect(entitlements.maxActiveExams).toBe(Infinity);
      expect(entitlements.hasSmartReschedule).toBe(true);
      expect(entitlements.hasAdvancedAnalytics).toBe(true);
      expect(entitlements.isCoreFeaturesPermanent).toBe(true);
      expect(entitlements.aiMonthlyQuota).toBe(30); // 30 次/月或自備金鑰
      expect(entitlements.aiPolicyNote).toContain('30 次');
      expect(entitlements.cloudSyncNote).toContain('第三方雲端');
    });

    test('終生版永久有效且不受過期時間影響', () => {
      expect(isSubscriptionActive(lifetimeSub)).toBe(true);
      expect(getEffectiveTier(lifetimeSub)).toBe('lifetime');
      expect(canUseSmartReschedule(lifetimeSub).allowed).toBe(true);
      expect(canAccessAiRecommendations(lifetimeSub).allowed).toBe(true);
    });

    test('終生版享有每月 30 次 AI 基礎配額', () => {
      const currentMonth = new Date().toISOString().slice(0, 7);
      const quota = getAiQuotaStatus(lifetimeSub, { monthlyCalls: 10, lastResetMonth: currentMonth });
      expect(quota.limit).toBe(30);
      expect(quota.used).toBe(10);
      expect(quota.remaining).toBe(20);
      expect(quota.isExceeded).toBe(false);
    });
  });

  describe('4. 降級與過期防護（既有資料絕對保留原則）', () => {
    test('Pro 方案過期時降回 Free 權限，但不損毀任何既有考試與歷史任務', () => {
      const expiredProSub: UserSubscription = {
        plan: 'pro',
        billingCycle: 'monthly',
        status: 'expired',
        expiresAt: '2025-01-01T00:00:00.000Z', // 過去的時間
      };

      expect(isSubscriptionActive(expiredProSub)).toBe(false);
      expect(getEffectiveTier(expiredProSub)).toBe('free');

      // 使用者在 Pro 期間已建立 3 場考試
      const exams = [
        createDummyExam('e1', '法學緒論'),
        createDummyExam('e2', '行政法'),
        createDummyExam('e3', '公務員法'),
      ];
      const data = baseAppData({
        subscription: expiredProSub,
        exams,
      });

      // 檢查既有考試陣列完整性：絕對不被刪除
      expect(data.exams.length).toBe(3);

      // 當嘗試再建新考試時，因已達 Free 上限（3 >= 1）而被擋下
      const check = canCreateExam(data);
      expect(check.allowed).toBe(false);
      expect(check.currentActiveCount).toBe(3);
      expect(check.reason).toContain('免費版支援 1 場');
    });
  });

  describe('5. DevStoreKitService 與預覽透明度', () => {
    const service = new DevStoreKitService();

    test('包含 4 種產品規格且標價明確（NT$0, NT$149, NT$990, NT$1,690）', async () => {
      const products = await service.getProducts();
      expect(products.length).toBe(4);

      const free = products.find((p) => p.tier === 'free');
      const monthly = products.find((p) => p.id === 'exampro_monthly');
      const annual = products.find((p) => p.id === 'exampro_yearly');
      const lifetime = products.find((p) => p.id === 'exampro_lifetime');

      expect(free?.priceFormatted).toBe('NT$0');
      expect(monthly?.priceAmount).toBe(149);
      expect(annual?.priceAmount).toBe(990);
      expect(lifetime?.priceAmount).toBe(1690);
    });

    test('Store 狀態明確標註為開發測試預覽，不偽造金流扣款', () => {
      const status = service.getStoreStatus();
      expect(status.environment).toBeDefined();
      expect(status.notice).toBeDefined();
    });

    test('模擬購買產品會正確產生對應權限與測試到期日', async () => {
      const buyAnnual = await service.purchase('exampro_yearly');
      expect(buyAnnual.success).toBe(true);
      expect(buyAnnual.subscription?.plan).toBe('pro');
      expect(buyAnnual.subscription?.billingCycle).toBe('annual');
      expect(buyAnnual.subscription?.isDevPreview).toBe(true);
      expect(buyAnnual.subscription?.expiresAt).toBeDefined();

      const buyLifetime = await service.purchase('exampro_lifetime');
      expect(buyLifetime.success).toBe(true);
      expect(buyLifetime.subscription?.plan).toBe('lifetime');
      expect(buyLifetime.subscription?.billingCycle).toBe('lifetime');

      const buyFree = await service.purchase('examplan_free');
      expect(buyFree.success).toBe(true);
      expect(buyFree.subscription?.plan).toBe('free');
    });

    test('恢復購買能正常執行並回傳透明說明', async () => {
      const restore = await service.restorePurchases();
      expect(restore.success).toBe(true);
      expect(restore.message).toContain('測試預覽');
    });
  });

  describe('6. AI 成本控制與本機安全架構 (AiCostController)', () => {
    test('用戶端無寫死之付費 API Key', () => {
      expect(AiCostController.hasClientApiKey()).toBe(false);
      expect(AiCostController.getBackendEndpoint()).toBeNull();
    });

    test('新月份自動重設月用量計數器', () => {
      const pastRecord: AiUsageRecord = {
        monthlyCalls: 85,
        lastResetMonth: '2026-08',
      };
      const activePro: UserSubscription = {
        plan: 'pro',
        billingCycle: 'monthly',
        status: 'active',
        expiresAt: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
      };

      // 計算時若遇到不同月份，會視為 0 開始
      const status = getAiQuotaStatus(activePro, pastRecord);
      expect(status.used).toBe(0);
      expect(status.remaining).toBe(100);
      expect(status.isExceeded).toBe(false);
    });

    test('超額時優雅降級至本機排程演算法', async () => {
      const sub: UserSubscription = {
        plan: 'pro',
        billingCycle: 'monthly',
        status: 'active',
        expiresAt: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
      };
      const usage: AiUsageRecord = {
        monthlyCalls: 100,
        lastResetMonth: new Date().toISOString().slice(0, 7),
      };

      const result = await AiCostController.requestAiRecommendation({
        subscription: sub,
        usage,
        context: { examCount: 1, taskCount: 10 },
      });

      expect(result.source).toBe('fallback_rule_engine');
      expect(result.fallbackNote).toContain('已達上限');
    });
  });

  describe('7. 會員有效期限與本地安全性檢驗 (Build 5 Phase 1 Security Suite)', () => {
    const futureDate = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
    const pastDate = new Date(Date.now() - 3600 * 1000).toISOString();

    const makeMockProofToken = (userId: string, originalTransactionId: string, expiresAtMs: number): string => {
      const payload = `${userId}:${originalTransactionId}:${expiresAtMs}`;
      const b64 = Buffer.from(payload).toString('base64url');
      return `${b64}.mock_sha256_signature`;
    };

    test('1. 未過期且合法的 Pro 訂閱能正確取得 Pro 權限', () => {
      const validPro: UserSubscription = {
        plan: 'pro',
        billingCycle: 'monthly',
        status: 'active',
        expiresAt: futureDate,
        productId: 'exampro_monthly',
        transactionId: 'txn-1001',
      };
      expect(isSubscriptionActive(validPro)).toBe(true);
      expect(getEffectiveTier(validPro)).toBe('pro');
    });

    test('2. status === "active" 但 expiresAt 已過期的 Pro 訂閱，判定為非有效，有效方案退回 free', () => {
      const expiredPro: UserSubscription = {
        plan: 'pro',
        billingCycle: 'monthly',
        status: 'active', // 雖然狀態為 active，但 expiresAt 已經過去
        expiresAt: pastDate,
        productId: 'exampro_monthly',
        transactionId: 'txn-1002',
      };
      expect(isSubscriptionActive(expiredPro)).toBe(false);
      expect(getEffectiveTier(expiredPro)).toBe('free');
    });

    test('3. expiresAt 缺失、為空字串、或為無效日期的 Pro 訂閱，判定為非有效', () => {
      const missingExpires: UserSubscription = {
        plan: 'pro',
        billingCycle: 'monthly',
        status: 'active',
      };
      expect(isSubscriptionActive(missingExpires)).toBe(false);
      expect(getEffectiveTier(missingExpires)).toBe('free');

      const emptyExpires: UserSubscription = {
        plan: 'pro',
        billingCycle: 'monthly',
        status: 'active',
        expiresAt: '   ',
      };
      expect(isSubscriptionActive(emptyExpires)).toBe(false);
      expect(getEffectiveTier(emptyExpires)).toBe('free');

      const invalidDateExpires: UserSubscription = {
        plan: 'pro',
        billingCycle: 'monthly',
        status: 'active',
        expiresAt: 'invalid-date-string-xxx',
      };
      expect(isSubscriptionActive(invalidDateExpires)).toBe(false);
      expect(getEffectiveTier(invalidDateExpires)).toBe('free');
    });

    test('4. 已取消自動續訂 (status: "canceled") 但仍在有效期的 Pro 不會被錯誤降級，到期後方降級', () => {
      // A. 停止自動續訂但尚未到期：仍享有 Pro 權益
      const canceledActivePro: UserSubscription = {
        plan: 'pro',
        billingCycle: 'monthly',
        status: 'canceled',
        expiresAt: futureDate,
        productId: 'exampro_monthly',
        transactionId: 'txn-canceled-future',
      };
      expect(isSubscriptionActive(canceledActivePro)).toBe(true);
      expect(getEffectiveTier(canceledActivePro)).toBe('pro');

      // 載入規範化保留 canceled 狀態，不誤降為 free
      const normalizedCanceled = normalizeSubscriptionOnLoad(canceledActivePro);
      expect(normalizedCanceled.status).toBe('canceled');
      expect(getEffectiveTier(normalizedCanceled)).toBe('pro');

      // B. 停止自動續訂且已經到期：正確降級為 free，狀態更新為 expired
      const canceledExpiredPro: UserSubscription = {
        plan: 'pro',
        billingCycle: 'monthly',
        status: 'canceled',
        expiresAt: pastDate,
        productId: 'exampro_monthly',
        transactionId: 'txn-canceled-past',
      };
      expect(isSubscriptionActive(canceledExpiredPro)).toBe(false);
      expect(getEffectiveTier(canceledExpiredPro)).toBe('free');

      const normalizedExpired = normalizeSubscriptionOnLoad(canceledExpiredPro);
      expect(normalizedExpired.status).toBe('expired');
      expect(getEffectiveTier(normalizedExpired)).toBe('free');
    });

    test('5. 具有 revocationDate 或 status 為 revoked/refunded 的訂閱，即刻判定為非有效', () => {
      const subWithRevocationDate: UserSubscription = {
        plan: 'pro',
        billingCycle: 'monthly',
        status: 'active',
        expiresAt: futureDate,
        revocationDate: pastDate,
      };
      expect(isSubscriptionActive(subWithRevocationDate)).toBe(false);
      expect(getEffectiveTier(subWithRevocationDate)).toBe('free');

      const revokedStatusSub: UserSubscription = {
        plan: 'pro',
        billingCycle: 'monthly',
        status: 'revoked',
        expiresAt: futureDate,
      };
      expect(isSubscriptionActive(revokedStatusSub)).toBe(false);
      expect(getEffectiveTier(revokedStatusSub)).toBe('free');

      const refundedStatusSub: UserSubscription = {
        plan: 'pro',
        billingCycle: 'annual',
        status: 'refunded',
        expiresAt: futureDate,
      };
      expect(isSubscriptionActive(refundedStatusSub)).toBe(false);
      expect(getEffectiveTier(refundedStatusSub)).toBe('free');

      const revokedLifetime: UserSubscription = {
        plan: 'lifetime',
        billingCycle: 'lifetime',
        status: 'revoked',
        productId: 'exampro_lifetime',
        transactionId: 'txn-revoked-life',
        proofToken: makeMockProofToken('user_revoked', 'txn-revoked-life', Date.now() + 7 * 86400 * 1000),
      };
      expect(isSubscriptionActive(revokedLifetime)).toBe(false);
      expect(getEffectiveTier(revokedLifetime)).toBe('free');
    });

    test('6. 偽造 Lifetime productId + transactionId 不能直接解鎖', () => {
      // 模擬手動在 AsyncStorage 注入商品 ID 與假交易 ID，但缺乏伺服器 Proof Token
      const fakeInjectedLifetime: UserSubscription = {
        plan: 'lifetime',
        billingCycle: 'lifetime',
        status: 'active',
        productId: 'exampro_lifetime',
        transactionId: 'fake-transaction-id-999',
        originalTransactionId: 'fake-transaction-id-999',
      };
      expect(isSubscriptionActive(fakeInjectedLifetime)).toBe(false);
      expect(getEffectiveTier(fakeInjectedLifetime)).toBe('free');

      // 啟動規範化：退回 free，但保留交易欄位供後續 StoreKit 恢復
      const normalized = normalizeSubscriptionOnLoad(fakeInjectedLifetime);
      expect(normalized.plan).toBe('free');
      expect(normalized.status).toBe('none');
      expect(normalized.productId).toBe('exampro_lifetime');
      expect(normalized.transactionId).toBe('fake-transaction-id-999');
      expect(getEffectiveTier(normalized)).toBe('free');
    });

    test('7. 偽造或過期 Proof Token 不能成為授權依據', () => {
      // A. 隨意字串偽造 Token
      expect(inspectProofToken('invalid_malformed_token_string').valid).toBe(false);
      const fakeTokenLifetime: UserSubscription = {
        plan: 'lifetime',
        billingCycle: 'lifetime',
        status: 'active',
        productId: 'exampro_lifetime',
        transactionId: 'txn-123',
        originalTransactionId: 'txn-123',
        proofToken: 'invalid_malformed_token_string',
      };
      expect(isSubscriptionActive(fakeTokenLifetime)).toBe(false);
      expect(getEffectiveTier(fakeTokenLifetime)).toBe('free');

      // B. 已過期 Proof Token
      const expiredToken = makeMockProofToken('user_exp', 'txn-123', Date.now() - 1000);
      const expiredInspection = inspectProofToken(expiredToken);
      expect(expiredInspection.valid).toBe(false);
      expect(expiredInspection.reason).toContain('逾期');
      const expiredTokenLifetime: UserSubscription = {
        plan: 'lifetime',
        billingCycle: 'lifetime',
        status: 'active',
        productId: 'exampro_lifetime',
        transactionId: 'txn-123',
        originalTransactionId: 'txn-123',
        proofToken: expiredToken,
      };
      expect(isSubscriptionActive(expiredTokenLifetime)).toBe(false);
      expect(getEffectiveTier(expiredTokenLifetime)).toBe('free');

      // C. 交易識別碼不相符的 Token (盜用他人收據 Token)
      const mismatchedToken = makeMockProofToken('user_other', 'different-txn-id', Date.now() + 7 * 86400 * 1000);
      const mismatchedLifetime: UserSubscription = {
        plan: 'lifetime',
        billingCycle: 'lifetime',
        status: 'active',
        productId: 'exampro_lifetime',
        transactionId: 'txn-123',
        originalTransactionId: 'txn-123',
        proofToken: mismatchedToken,
      };
      expect(isSubscriptionActive(mismatchedLifetime)).toBe(false);
      expect(getEffectiveTier(mismatchedLifetime)).toBe('free');
    });

    test('8. 有效 Lifetime 經可信任流程（含合法 Proof Token 或開發預覽）取得權益，不受 expiresAt 限制', () => {
      // 正式 / Sandbox 驗證流程所產生的合格 Lifetime
      const legitToken = makeMockProofToken('client_dev_1', 'txn-life-valid-1', Date.now() + 7 * 86400 * 1000);
      const legitInspection = inspectProofToken(legitToken);
      expect(legitInspection.valid).toBe(true);
      expect(legitInspection.originalTransactionId).toBe('txn-life-valid-1');
      const verifiedStoreKitLifetime: UserSubscription = {
        plan: 'lifetime',
        billingCycle: 'lifetime',
        status: 'active',
        productId: 'exampro_lifetime',
        transactionId: 'txn-life-valid-1',
        originalTransactionId: 'txn-life-valid-1',
        purchaseDate: new Date(Date.now() - 86400 * 1000).toISOString(),
        proofToken: legitToken,
      };
      expect(isSubscriptionActive(verifiedStoreKitLifetime)).toBe(true);
      expect(getEffectiveTier(verifiedStoreKitLifetime)).toBe('lifetime');

      // 開發測試模式
      const devVerifiedLifetime: UserSubscription = {
        plan: 'lifetime',
        billingCycle: 'lifetime',
        status: 'active',
        isDevPreview: true,
      };
      expect(isSubscriptionActive(devVerifiedLifetime)).toBe(true);
      expect(getEffectiveTier(devVerifiedLifetime)).toBe('lifetime');
    });

    test('9. 系統時間異常（時鐘往回撥：目前時間小於購買時間）時的安全防護', () => {
      const futurePurchaseDate = new Date(Date.now() + 365 * 86400 * 1000).toISOString();
      const farFutureExpires = new Date(Date.now() + 400 * 86400 * 1000).toISOString();

      const clockRollbackPro: UserSubscription = {
        plan: 'pro',
        billingCycle: 'monthly',
        status: 'active',
        purchaseDate: futurePurchaseDate,
        expiresAt: farFutureExpires,
        productId: 'exampro_monthly',
        transactionId: 'txn-clock-rollback',
      };
      expect(isSubscriptionActive(clockRollbackPro)).toBe(false);
      expect(getEffectiveTier(clockRollbackPro)).toBe('free');
    });

    test('10. App 啟動載入已過期快取時，狀態正確退回 free，現有考試資料與舊訂閱紀錄絕不被破壞', () => {
      const staleExpiredPro: UserSubscription = {
        plan: 'pro',
        billingCycle: 'monthly',
        status: 'active',
        expiresAt: pastDate,
        productId: 'exampro_monthly',
        transactionId: 'txn-old-stale',
        originalTransactionId: 'txn-orig-stale',
        purchaseDate: new Date(Date.now() - 30 * 86400 * 1000).toISOString(),
      };

      const normalized = normalizeSubscriptionOnLoad(staleExpiredPro);

      expect(normalized.status).toBe('expired');
      expect(normalized.plan).toBe('pro');
      expect(normalized.productId).toBe('exampro_monthly');
      expect(normalized.transactionId).toBe('txn-old-stale');
      expect(normalized.originalTransactionId).toBe('txn-orig-stale');
      expect(normalized.expiresAt).toBe(pastDate);
      expect(getEffectiveTier(normalized)).toBe('free');

      // 檢查考試資料完整性：退回 free 時絕不影響使用者的考試列表
      const userExams = [
        createDummyExam('exam-1', '高考會計'),
        createDummyExam('exam-2', '證券分析師'),
      ];
      const data = baseAppData({
        subscription: normalized,
        exams: userExams,
      });
      expect(data.exams.length).toBe(2);
      expect(data.exams[0].name).toBe('高考會計');
      expect(data.exams[1].name).toBe('證券分析師');
    });
  });
});
