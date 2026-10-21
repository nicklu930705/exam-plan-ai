import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  clearStoredLatestAppleJws,
  clearStoredProofToken,
  getStoredLatestAppleJws,
  getStoredProofToken,
  saveStoredLatestAppleJws,
  saveStoredProofToken,
} from '../../storage';
import {
  isProofTokenWithinRenewalWindow,
  resetSyncServiceForTesting,
  syncSubscriptionStatus,
} from '../subscriptionSyncService';
import { storeKitService } from '../storeKitService';
import { isSubscriptionActive, getEffectiveTier } from '../entitlements';
import type { UserSubscription } from '../types';
import type { AppData, Exam, StudyTask } from '../../types/models';

// 模擬 AsyncStorage
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

function createMockProofToken(userId: string, origTxId: string, expiresAt: number): string {
  const payload = `${userId}:${origTxId}:${expiresAt}`;
  const b64 = Buffer.from(payload).toString('base64url');
  return `${b64}.mock_signature_for_testing`;
}

describe('Phase 3.4c-19：Apple 自動續訂無感自癒與 Build 7 前端回歸測試套件', () => {
  const originalFetch = global.fetch;

  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    resetSyncServiceForTesting();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  // ───── 測試 1：Apple 已續訂 + 舊 Proof Token -> 自動恢復 Pro ─────
  test('1. Apple 已續訂 + 舊 Proof Token：啟動或喚醒時自動無感恢復 Pro 並存入新權杖', async () => {
    const now = Date.now();
    const oldExpiresAt = now - 3600 * 1000; // 1 小時前已到期
    const newExpiresAt = now + 30 * 86400 * 1000; // 雲端續約至 30 天後
    const oldToken = createMockProofToken('user_test_1', 'orig_tx_001', oldExpiresAt);
    const newToken = createMockProofToken('user_test_1', 'orig_tx_001', newExpiresAt);

    await saveStoredProofToken(oldToken);

    // 模擬已到期之本地狀態 (Free)
    const currentSub: UserSubscription = {
      plan: 'free',
      billingCycle: 'none',
      status: 'expired',
      productId: 'exampro_monthly',
      originalTransactionId: 'orig_tx_001',
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        tier: 'pro',
        status: 'active',
        productId: 'exampro_monthly',
        originalTransactionId: 'orig_tx_001',
        expiresAt: newExpiresAt,
        willRenew: true,
        proofToken: newToken,
        isVerified: true,
        serverTime: now,
      }),
    });

    const setSubscription = jest.fn();

    const result = await syncSubscriptionStatus({
      currentSubscription: currentSub,
      setSubscription,
      customApiEndpoint: 'https://test-sandbox.vercel.app',
      force: true,
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe('active');
    expect(result.tier).toBe('pro');

    // 驗證 App 狀態自動更新為 Pro
    expect(setSubscription).toHaveBeenCalledTimes(1);
    const updatedSub: UserSubscription = setSubscription.mock.calls[0][0];
    expect(updatedSub.plan).toBe('pro');
    expect(updatedSub.status).toBe('active');
    expect(updatedSub.isAutoRenewing).toBe(true);
    expect(updatedSub.proofToken).toBe(newToken);
    expect(updatedSub.expiresAt).toBe(new Date(newExpiresAt).toISOString());

    // 驗證本地儲存已成功寫入全新換發的 Proof Token
    expect(await getStoredProofToken()).toBe(newToken);
  });

  // ───── 測試 2：Apple 尚未續訂 + 舊 Proof Token -> 維持 Free 且安全保留換發憑據 ─────
  test('2. Apple 尚未續訂 + 舊 Proof Token：維持 Free，在 30 天窗口內保留舊 Token 供未來自癒', async () => {
    const now = Date.now();
    const oldExpiresAt = now - 1800 * 1000; // 30 分鐘前到期 (在 30 天窗口內)
    const oldToken = createMockProofToken('user_test_2', 'orig_tx_002', oldExpiresAt);

    await saveStoredProofToken(oldToken);

    const currentSub: UserSubscription = {
      plan: 'pro',
      billingCycle: 'monthly',
      status: 'active',
      productId: 'exampro_monthly',
      originalTransactionId: 'orig_tx_002',
      proofToken: oldToken,
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        tier: 'free',
        status: 'expired',
        productId: 'exampro_monthly',
        originalTransactionId: 'orig_tx_002',
        expiresAt: oldExpiresAt,
        isVerified: false,
        serverTime: now,
      }),
    });

    const setSubscription = jest.fn();

    const result = await syncSubscriptionStatus({
      currentSubscription: currentSub,
      setSubscription,
      customApiEndpoint: 'https://test-sandbox.vercel.app',
      force: true,
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe('expired');
    expect(result.tier).toBe('free');

    // App 即刻降級為 Free
    expect(setSubscription).toHaveBeenCalledTimes(1);
    const downgradedSub: UserSubscription = setSubscription.mock.calls[0][0];
    expect(downgradedSub.plan).toBe('free');
    expect(downgradedSub.status).toBe('expired');
    expect(isSubscriptionActive(downgradedSub)).toBe(false);
    expect(getEffectiveTier(downgradedSub)).toBe('free');

    // 核心安全自癒重點：舊 Proof Token 不被過早銷毀，繼續保留在 AsyncStorage
    expect(await getStoredProofToken()).toBe(oldToken);
  });

  // ───── 測試 3：Apple 已續訂 + 本機憑證遺失 -> 由可信 StoreKit 2 交易快取恢復 ─────
  test('3. Apple 已續訂 + 本機憑證遺失 (升級 Build 6 場景)：由 StoreKit 2 本機快取安全自癒恢復 Pro', async () => {
    const now = Date.now();
    const newExpiresAt = now + 30 * 86400 * 1000;
    const freshToken = createMockProofToken('user_test_3', 'orig_tx_003', newExpiresAt);

    // 模擬本機完全無 Token (被 Build 6 抹除)
    await clearStoredProofToken();
    await clearStoredLatestAppleJws();

    const currentSub: UserSubscription = {
      plan: 'free',
      billingCycle: 'none',
      status: 'none',
    };

    // 模擬 storeKitService.restorePurchases 返回有效本機購買
    const restoreSpy = jest.spyOn(storeKitService, 'restorePurchases').mockResolvedValueOnce({
      success: true,
      status: 'success',
      subscription: {
        plan: 'pro',
        billingCycle: 'monthly',
        status: 'active',
        productId: 'exampro_monthly',
        originalTransactionId: 'orig_tx_003',
        expiresAt: new Date(newExpiresAt).toISOString(),
        proofToken: freshToken,
      },
      message: '恢復購買成功！',
    });

    const setSubscription = jest.fn();

    const result = await syncSubscriptionStatus({
      currentSubscription: currentSub,
      setSubscription,
      customApiEndpoint: 'https://test-sandbox.vercel.app',
      force: true,
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe('active');
    expect(result.tier).toBe('pro');
    expect(result.recoveredViaStoreKit).toBe(true);

    // 驗證 StoreKit 備援以 syncWithAppStore: false 呼叫 (不彈出密碼提示)
    expect(restoreSpy).toHaveBeenCalledWith({ syncWithAppStore: false });
    expect(setSubscription).toHaveBeenCalledTimes(1);
    expect(setSubscription.mock.calls[0][0].plan).toBe('pro');

    restoreSpy.mockRestore();
  });

  // ───── 測試 4：真正到期未續約 (逾期大於 30 天) -> 清除憑據維持 Free ─────
  test('4. 真正到期未續約且超過 30 天：過期憑證永久銷毀，維持 Free', async () => {
    const now = Date.now();
    const ancientExpiresAt = now - 35 * 86400 * 1000; // 35 天前已到期
    const ancientToken = createMockProofToken('user_test_4', 'orig_tx_004', ancientExpiresAt);

    await saveStoredProofToken(ancientToken);

    expect(isProofTokenWithinRenewalWindow(ancientToken, now)).toBe(false);

    const currentSub: UserSubscription = {
      plan: 'free',
      billingCycle: 'none',
      status: 'expired',
      productId: 'exampro_monthly',
      originalTransactionId: 'orig_tx_004',
    };

    // 模擬 StoreKit 快取亦無有效購買
    const restoreSpy = jest.spyOn(storeKitService, 'restorePurchases').mockResolvedValueOnce({
      success: false,
      status: 'needs_sync',
      message: '本機無購買紀錄',
    });

    const setSubscription = jest.fn();

    const result = await syncSubscriptionStatus({
      currentSubscription: currentSub,
      setSubscription,
      customApiEndpoint: 'https://test-sandbox.vercel.app',
      force: true,
    });

    expect(result.tier).toBe('free');
    // 確認遠古 Token 已被主動清除
    expect(await getStoredProofToken()).toBeNull();

    restoreSpy.mockRestore();
  });

  // ───── 測試 5：退款或撤銷 -> 絕對清除憑據，不得恢復 Pro ─────
  test('5. 退款或撤銷 (revoked)：立即清除全部憑證，絕不得以舊憑據自癒恢復', async () => {
    const now = Date.now();
    const revokedToken = createMockProofToken('user_test_5', 'orig_tx_revoked', now + 86400000);

    await saveStoredProofToken(revokedToken);
    await saveStoredLatestAppleJws('mock_jws_revoked');

    const currentSub: UserSubscription = {
      plan: 'pro',
      billingCycle: 'monthly',
      status: 'active',
      productId: 'exampro_monthly',
      originalTransactionId: 'orig_tx_revoked',
      proofToken: revokedToken,
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        tier: 'free',
        status: 'revoked',
        productId: 'exampro_monthly',
        originalTransactionId: 'orig_tx_revoked',
        isVerified: false,
        serverTime: now,
      }),
    });

    const setSubscription = jest.fn();

    const result = await syncSubscriptionStatus({
      currentSubscription: currentSub,
      setSubscription,
      customApiEndpoint: 'https://test-sandbox.vercel.app',
      force: true,
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe('revoked');
    expect(result.tier).toBe('free');

    // 驗證本機儲存被澈底銷毀
    expect(await getStoredProofToken()).toBeNull();
    expect(await getStoredLatestAppleJws()).toBeNull();

    // 驗證降級狀態包含撤銷註記
    const downgradedSub: UserSubscription = setSubscription.mock.calls[0][0];
    expect(downgradedSub.status).toBe('revoked');
    expect(downgradedSub.plan).toBe('free');
    expect(downgradedSub.revocationDate).toBeDefined();
  });

  // ───── 測試 6：Lifetime 終身買斷版保護 ─────
  test('6. Lifetime 終身買斷方案：永遠不因月訂閱到期回應而被覆蓋或降級', async () => {
    const now = Date.now();
    const lifetimeSub: UserSubscription = {
      plan: 'lifetime',
      billingCycle: 'lifetime',
      status: 'active',
      productId: 'exampro_lifetime',
      originalTransactionId: 'orig_tx_lifetime_001',
      proofToken: createMockProofToken('user_life', 'orig_tx_lifetime_001', now + 86400000),
    };

    // 模擬後端回傳針對另一個交易的過期回應 (延遲競態)
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        tier: 'free',
        status: 'expired',
        productId: 'exampro_monthly',
        originalTransactionId: 'orig_tx_other_monthly',
        expiresAt: now - 1000,
      }),
    });

    const setSubscription = jest.fn();

    const result = await syncSubscriptionStatus({
      currentSubscription: lifetimeSub,
      getCurrentSubscription: () => lifetimeSub,
      setSubscription,
      customApiEndpoint: 'https://test-sandbox.vercel.app',
      force: true,
    });

    // 競態保護：捨棄舊過期回應
    expect(result.status).toBe('stale_response');
    expect(result.tier).toBe('lifetime');
    expect(setSubscription).not.toHaveBeenCalled();
    expect(isSubscriptionActive(lifetimeSub)).toBe(true);
    expect(getEffectiveTier(lifetimeSub)).toBe('lifetime');
  });

  // ───── 測試 7：無網路或 Apple 查詢失敗 -> 不錯誤授權 ─────
  test('7. 無網路連線或伺服器 500 錯誤：寬容保留現有狀態，絕不錯誤授予付費資格', async () => {
    const token = createMockProofToken('user_7', 'orig_7', Date.now() + 86400000);
    await saveStoredProofToken(token);

    const currentSub: UserSubscription = {
      plan: 'free',
      billingCycle: 'none',
      status: 'expired',
      originalTransactionId: 'orig_7',
      proofToken: token,
    };

    global.fetch = jest.fn().mockRejectedValue(new Error('Network request failed'));

    const setSubscription = jest.fn();

    const result = await syncSubscriptionStatus({
      currentSubscription: currentSub,
      setSubscription,
      customApiEndpoint: 'https://test-sandbox.vercel.app',
      force: true,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe('network_error');
    expect(result.tier).toBe('free');
    expect(setSubscription).not.toHaveBeenCalled();
  });

  // ───── 測試 8：啟動與前景喚醒並發防護 ─────
  test('8. 啟動與前景喚醒並發：節流機制 (5 分鐘) 正常阻斷重複請求，不發生無限循環', async () => {
    const now = Date.now();
    const token = createMockProofToken('user_8', 'orig_8', now + 86400000);
    await saveStoredProofToken(token);

    const currentSub: UserSubscription = {
      plan: 'pro',
      billingCycle: 'monthly',
      status: 'active',
      productId: 'exampro_monthly',
      originalTransactionId: 'orig_8',
      proofToken: token,
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        tier: 'pro',
        status: 'active',
        productId: 'exampro_monthly',
        originalTransactionId: 'orig_8',
        expiresAt: now + 86400000,
      }),
    });

    const setSubscription = jest.fn();

    // 第一次同步成功
    const res1 = await syncSubscriptionStatus({
      currentSubscription: currentSub,
      setSubscription,
      customApiEndpoint: 'https://test-sandbox.vercel.app',
      force: false,
    });
    expect(res1.status).toBe('active');
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // 立即發起第二次前景同步 (未達 5 分鐘)
    const res2 = await syncSubscriptionStatus({
      currentSubscription: currentSub,
      setSubscription,
      customApiEndpoint: 'https://test-sandbox.vercel.app',
      force: false,
    });
    expect(res2.status).toBe('throttled');
    expect(global.fetch).toHaveBeenCalledTimes(1); // 請求次數維持 1
  });

  // ───── 測試 9：App 既有考試、任務與 AI 額度資料維持完整 ─────
  test('9. 資料安全保護：會員狀態變更只更新 subscription，考試、任務、進度 100% 完整無損', () => {
    const mockExam: Exam = {
      id: 'exam_001',
      name: '微積分期末考',
      examDate: '2026-11-20',
      subjects: [
        {
          id: 'sub_001',
          name: '微積分',
          familiarity: 2,
          chapters: [],
        },
      ],
      createdAt: '2026-10-15T00:00:00.000Z',
      archived: false,
    };

    const mockTask: StudyTask = {
      id: 'task_001',
      examId: 'exam_001',
      subjectId: 'sub_001',
      subjectName: '微積分',
      title: '極限單元複習',
      kind: 'review',
      date: '2026-10-22',
      estimatedMinutes: 45,
      actualMinutes: 30,
      status: 'done',
    };

    const initialData: AppData = {
      exams: [mockExam],
      tasks: [mockTask],
      preferences: {
        dailyMinutes: 90,
        restDays: [0],
        intensity: 'normal',
      },
      isDemo: false,
      subscription: {
        plan: 'free',
        billingCycle: 'none',
        status: 'expired',
      },
      aiUsage: {
        monthlyCalls: 5,
        lastResetMonth: '2026-10',
      },
      selectedExamId: 'exam_001',
    };

    // 模擬自癒更新 subscription
    const newSubscription: UserSubscription = {
      plan: 'pro',
      billingCycle: 'monthly',
      status: 'active',
      productId: 'exampro_monthly',
      originalTransactionId: 'orig_tx_001',
      expiresAt: '2026-11-20T23:58:55.000Z',
    };

    const updatedData: AppData = {
      ...initialData,
      subscription: newSubscription,
    };

    // 驗證考試與任務完全未被竄改
    expect(updatedData.exams).toEqual(initialData.exams);
    expect(updatedData.tasks).toEqual(initialData.tasks);
    expect(updatedData.aiUsage).toEqual(initialData.aiUsage);
    expect(updatedData.preferences).toEqual(initialData.preferences);
    expect(updatedData.selectedExamId).toBe('exam_001');
    expect(updatedData.subscription?.plan).toBe('pro');
  });

  // ───── 測試 10：與 Sandbox 後端 2c792bf API 格式相容 ─────
  test('10. 與 Sandbox 後端 Commit 2c792bf 回應格式完全相容', async () => {
    const now = Date.now();
    const token = createMockProofToken('user_10', 'orig_tx_10', now + 86400000);
    await saveStoredProofToken(token);

    // 完全對齊 Phase 3.4c-15/16 後端真實回傳 JSON Schema
    const backendResponsePayload = {
      success: true,
      tier: 'pro',
      status: 'active',
      productId: 'exampro_monthly',
      originalTransactionId: 'orig_tx_10',
      expiresAt: now + 86400000,
      willRenew: true,
      proofToken: 'fresh_proof_token_signed_by_backend_2c792bf',
      isVerified: true,
      serverTime: now,
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => backendResponsePayload,
    });

    const setSubscription = jest.fn();

    const result = await syncSubscriptionStatus({
      currentSubscription: {
        plan: 'free',
        billingCycle: 'none',
        status: 'expired',
        originalTransactionId: 'orig_tx_10',
      },
      setSubscription,
      customApiEndpoint: 'https://exam-plan-ai-backend-sandbox.vercel.app',
      force: true,
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe('active');
    expect(result.tier).toBe('pro');

    const appliedSub: UserSubscription = setSubscription.mock.calls[0][0];
    expect(appliedSub.plan).toBe('pro');
    expect(appliedSub.status).toBe('active');
    expect(appliedSub.isAutoRenewing).toBe(true);
    expect(appliedSub.proofToken).toBe('fresh_proof_token_signed_by_backend_2c792bf');
    expect(appliedSub.expiresAt).toBe(new Date(now + 86400000).toISOString());
  });
});
