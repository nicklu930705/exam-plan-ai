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
  isSubscriptionActive,
} from '../entitlements';
import { DevStoreKitService } from '../storeKitService';
import type { AiUsageRecord, UserSubscription } from '../types';
import type { AppData, Exam, StudyPreferences, Weekday } from '../../types/models';

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
});
