import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getStoredLatestAppleJws,
  getStoredProofToken,
  saveStoredLatestAppleJws,
  saveStoredProofToken,
} from '../../storage';
import {
  FOREGROUND_THROTTLE_MS,
  resetSyncServiceForTesting,
  setLastSyncTimestampForTesting,
  setupForegroundSubscriptionSync,
  syncSubscriptionStatus,
} from '../subscriptionSyncService';
import type { UserSubscription } from '../types';

// 模擬 AsyncStorage
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

describe('會員狀態背景靜默同步服務 (subscriptionSyncService)', () => {
  const originalFetch = global.fetch;

  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    resetSyncServiceForTesting();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  describe('1. 啟動靜默同步與基本查詢', () => {
    test('Pro 訂閱使用者啟動時：發送 Proof Token 並成功維持 active 狀態', async () => {
      const mockSub: UserSubscription = {
        plan: 'pro',
        billingCycle: 'monthly',
        status: 'active',
        productId: 'exampro_monthly',
        originalTransactionId: 'orig_tx_001',
        expiresAt: new Date(Date.now() + 10 * 86400 * 1000).toISOString(),
        proofToken: 'valid.proof.token.base64',
      };

      await saveStoredProofToken('valid.proof.token.base64');

      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          tier: 'pro',
          status: 'active',
          productId: 'exampro_monthly',
          originalTransactionId: 'orig_tx_001',
          expiresAt: Date.now() + 10 * 86400 * 1000,
          willRenew: true,
          proofToken: 'refreshed.proof.token.new',
          serverTime: Date.now(),
        }),
      });
      global.fetch = mockFetch;

      const setSubscription = jest.fn();

      const result = await syncSubscriptionStatus({
        currentSubscription: mockSub,
        setSubscription,
        customApiEndpoint: 'https://test-api.example.com',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('active');
      expect(result.tier).toBe('pro');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // 確認 setSubscription 被呼叫且包含換發的全新 Proof Token
      expect(setSubscription).toHaveBeenCalledTimes(1);
      const updatedSub: UserSubscription = setSubscription.mock.calls[0][0];
      expect(updatedSub.plan).toBe('pro');
      expect(updatedSub.status).toBe('active');
      expect(updatedSub.proofToken).toBe('refreshed.proof.token.new');

      // 確認新 Token 已存入 AsyncStorage
      const savedToken = await getStoredProofToken();
      expect(savedToken).toBe('refreshed.proof.token.new');
    });

    test('純免費使用者 (無任何付費憑證)：啟動時安全略過伺服器查詢，節省頻寬與電力', async () => {
      const mockFetch = jest.fn();
      global.fetch = mockFetch;
      const setSubscription = jest.fn();

      const result = await syncSubscriptionStatus({
        currentSubscription: {
          plan: 'free',
          billingCycle: 'none',
          status: 'none',
        },
        setSubscription,
        customApiEndpoint: 'https://test-api.example.com',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('skipped_free');
      expect(result.tier).toBe('free');
      expect(mockFetch).not.toHaveBeenCalled();
      expect(setSubscription).not.toHaveBeenCalled();
    });
  });

  describe('2. 前景切換 5 分鐘冷卻節流 (Throttle)', () => {
    test('5 分鐘內連續呼叫：第二次請求被節流阻擋，不重複連線後端', async () => {
      const mockSub: UserSubscription = {
        plan: 'pro',
        billingCycle: 'monthly',
        status: 'active',
        originalTransactionId: 'orig_tx_throttle',
        proofToken: 'token_throttle',
      };

      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          tier: 'pro',
          status: 'active',
          serverTime: Date.now(),
        }),
      });
      global.fetch = mockFetch;

      const setSubscription = jest.fn();

      // 第一次呼叫 (成功)
      const res1 = await syncSubscriptionStatus({
        currentSubscription: mockSub,
        setSubscription,
        customApiEndpoint: 'https://test-api.example.com',
      });
      expect(res1.status).toBe('active');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // 立即進行第二次呼叫 (冷卻中)
      const res2 = await syncSubscriptionStatus({
        currentSubscription: mockSub,
        setSubscription,
        customApiEndpoint: 'https://test-api.example.com',
      });
      expect(res2.status).toBe('throttled');
      expect(res2.message).toContain('冷卻中');
      expect(mockFetch).toHaveBeenCalledTimes(1); // 未產生第二次 fetch

      // 強制呼叫 (force: true) 應能繞過節流
      const res3 = await syncSubscriptionStatus({
        currentSubscription: mockSub,
        setSubscription,
        customApiEndpoint: 'https://test-api.example.com',
        force: true,
      });
      expect(res3.status).toBe('active');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    test('超過 5 分鐘冷卻時間後呼叫：成功發起新查詢', async () => {
      const mockSub: UserSubscription = {
        plan: 'pro',
        billingCycle: 'monthly',
        status: 'active',
        originalTransactionId: 'orig_tx_cool',
        proofToken: 'token_cool',
      };

      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          tier: 'pro',
          status: 'active',
          serverTime: Date.now(),
        }),
      });
      global.fetch = mockFetch;

      const setSubscription = jest.fn();

      // 設定上次同步時間為 6 分鐘前
      setLastSyncTimestampForTesting(Date.now() - (FOREGROUND_THROTTLE_MS + 60000));

      const result = await syncSubscriptionStatus({
        currentSubscription: mockSub,
        setSubscription,
        customApiEndpoint: 'https://test-api.example.com',
      });

      expect(result.status).toBe('active');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('3. 網路異常與暫時故障寬容保護 (絕不誤殺合法會員)', () => {
    test('網路離線或 fetch 拋出例外：寬容保留現有未到期 Pro 權益，不呼叫 setSubscription 降級', async () => {
      const mockSub: UserSubscription = {
        plan: 'pro',
        billingCycle: 'monthly',
        status: 'active',
        originalTransactionId: 'orig_tx_offline',
        expiresAt: new Date(Date.now() + 5 * 86400 * 1000).toISOString(),
        proofToken: 'token_offline',
      };

      global.fetch = jest.fn().mockRejectedValue(new Error('Network request failed'));

      const setSubscription = jest.fn();

      const result = await syncSubscriptionStatus({
        currentSubscription: mockSub,
        setSubscription,
        customApiEndpoint: 'https://test-api.example.com',
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe('network_error');
      expect(result.tier).toBe('pro'); // 依然回傳 pro 等級
      expect(setSubscription).not.toHaveBeenCalled(); // 絕不降級
    });

    test('伺服器回傳 500/502/503 內部錯誤：寬容保留現有會員權益', async () => {
      const validPayload = Buffer.from(`dev_user:orig_tx_life_server_err:${Date.now() + 86400000}`).toString('base64url');
      const validToken = `${validPayload}.dummy_sig`;
      const mockSub: UserSubscription = {
        plan: 'lifetime',
        billingCycle: 'lifetime',
        status: 'active',
        productId: 'exampro_lifetime',
        originalTransactionId: 'orig_tx_life_server_err',
        proofToken: validToken,
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ error: 'Service Unavailable' }),
      });

      const setSubscription = jest.fn();

      const result = await syncSubscriptionStatus({
        currentSubscription: mockSub,
        setSubscription,
        customApiEndpoint: 'https://test-api.example.com',
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe('network_error');
      expect(result.tier).toBe('lifetime');
      expect(setSubscription).not.toHaveBeenCalled();
    });
  });

  describe('4. Apple 伺服端確認撤銷與過期安全降級 (保障使用者學習資料)', () => {
    test('伺服端確認交易已退款撤銷 (revoked)：安全降級為 Free，清理 Token 與 JWS 快取', async () => {
      const mockSub: UserSubscription = {
        plan: 'pro',
        billingCycle: 'monthly',
        status: 'active',
        originalTransactionId: 'orig_tx_revoked_test',
        proofToken: 'token_to_clear',
        signedTransaction: 'jws_to_clear',
      };

      await saveStoredProofToken('token_to_clear');
      await saveStoredLatestAppleJws('jws_to_clear');

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          tier: 'free',
          status: 'revoked',
          productId: 'exampro_monthly',
          originalTransactionId: 'orig_tx_revoked_test',
          serverTime: Date.now(),
        }),
      });

      const setSubscription = jest.fn();

      const result = await syncSubscriptionStatus({
        currentSubscription: mockSub,
        setSubscription,
        customApiEndpoint: 'https://test-api.example.com',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('revoked');
      expect(result.tier).toBe('free');

      // 檢查 setSubscription 呼叫
      expect(setSubscription).toHaveBeenCalledTimes(1);
      const downgradedSub: UserSubscription = setSubscription.mock.calls[0][0];
      expect(downgradedSub.plan).toBe('free');
      expect(downgradedSub.status).toBe('revoked');
      expect(downgradedSub.proofToken).toBeUndefined();
      expect(downgradedSub.signedTransaction).toBeUndefined();

      // 確認本機儲存已清除
      expect(await getStoredProofToken()).toBeNull();
      expect(await getStoredLatestAppleJws()).toBeNull();
    });

    test('伺服端確認訂閱已到期 (expired)：安全降級為 Free', async () => {
      const mockSub: UserSubscription = {
        plan: 'pro',
        billingCycle: 'monthly',
        status: 'active',
        originalTransactionId: 'orig_tx_expired_test',
        proofToken: 'token_expired',
      };

      await saveStoredProofToken('token_expired');

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          tier: 'free',
          status: 'expired',
          productId: 'exampro_monthly',
          originalTransactionId: 'orig_tx_expired_test',
          expiresAt: Date.now() - 3600000,
          serverTime: Date.now(),
        }),
      });

      const setSubscription = jest.fn();

      const result = await syncSubscriptionStatus({
        currentSubscription: mockSub,
        setSubscription,
        customApiEndpoint: 'https://test-api.example.com',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('expired');
      expect(result.tier).toBe('free');

      expect(setSubscription).toHaveBeenCalledTimes(1);
      const downgradedSub: UserSubscription = setSubscription.mock.calls[0][0];
      expect(downgradedSub.plan).toBe('free');
      expect(downgradedSub.status).toBe('expired');
    });
  });

  describe('5. 並行與延遲回應競態防護 (Race Condition Guard)', () => {
    test('舊請求延遲回應時：安全捨棄，不覆蓋較新請求之狀態', async () => {
      const mockSub: UserSubscription = {
        plan: 'pro',
        billingCycle: 'monthly',
        status: 'active',
        originalTransactionId: 'orig_tx_race',
        proofToken: 'token_race',
      };

      let resolveSlowRequest: any;
      const slowPromise = new Promise((resolve) => {
        resolveSlowRequest = resolve;
      });

      let callCount = 0;
      global.fetch = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // 第一筆請求：慢速延遲回應 (過期)
          return slowPromise;
        }
        // 第二筆請求：快速完成 (有效續訂)
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            tier: 'pro',
            status: 'active',
            serverTime: Date.now(),
          }),
        });
      });

      const setSubscription = jest.fn();

      // 觸發第一筆請求 (慢)
      const p1 = syncSubscriptionStatus({
        currentSubscription: mockSub,
        setSubscription,
        customApiEndpoint: 'https://test-api.example.com',
        force: true,
      });

      // 觸發第二筆請求 (快)
      const p2 = syncSubscriptionStatus({
        currentSubscription: mockSub,
        setSubscription,
        customApiEndpoint: 'https://test-api.example.com',
        force: true,
      });

      // 第二筆先完成
      const res2 = await p2;
      expect(res2.status).toBe('active');
      expect(setSubscription).toHaveBeenCalledTimes(1);

      // 第一筆現在才回傳 (慢速回應 expired)
      resolveSlowRequest({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          tier: 'free',
          status: 'expired',
          serverTime: Date.now(),
        }),
      });

      const res1 = await p1;
      // 驗證第一筆慢速回應被判定為 stale_response 捨棄
      expect(res1.status).toBe('stale_response');
      // setSubscription 依然只有第二筆呼叫的 1 次，未被舊請求覆蓋！
      expect(setSubscription).toHaveBeenCalledTimes(1);
    });

    test('背景慢速查詢回傳 expired，但使用者在期間已完成新購買：安全捨棄舊查詢，絕不覆蓋新購買', async () => {
      const oldSub: UserSubscription = {
        plan: 'free',
        billingCycle: 'none',
        status: 'expired',
        originalTransactionId: 'orig_tx_old_expired',
        proofToken: 'old_expired_token',
      };

      let resolveSlowOldQuery: any;
      const slowOldQueryPromise = new Promise((resolve) => {
        resolveSlowOldQuery = resolve;
      });

      global.fetch = jest.fn().mockReturnValue(slowOldQueryPromise);

      const setSubscription = jest.fn();

      let currentStoreSub: UserSubscription = oldSub;

      // 1. 啟動背景同步 (慢速)
      const syncPromise = syncSubscriptionStatus({
        currentSubscription: oldSub,
        getCurrentSubscription: () => currentStoreSub,
        setSubscription,
        customApiEndpoint: 'https://test-api.example.com',
        force: true,
      });

      // 2. 使用者在畫面上成功購買了全新的 Lifetime 方案！
      currentStoreSub = {
        plan: 'lifetime',
        billingCycle: 'lifetime',
        status: 'active',
        productId: 'exampro_lifetime',
        originalTransactionId: 'orig_tx_brand_new_lifetime',
        proofToken: 'brand_new_lifetime_token',
      };

      // 3. 此時舊背景查詢終於回傳（回傳過期與免費）
      resolveSlowOldQuery({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          tier: 'free',
          status: 'expired',
          originalTransactionId: 'orig_tx_old_expired',
          serverTime: Date.now(),
        }),
      });

      const syncResult = await syncPromise;

      // 驗證舊回應被捨棄，且 setSubscription 絕不被調用去降級新購買！
      expect(syncResult.status).toBe('stale_response');
      expect(syncResult.tier).toBe('lifetime'); // 保留 Lifetime
      expect(setSubscription).not.toHaveBeenCalled();
    });
  });

  describe('6. 前景喚醒監聽 (setupForegroundSubscriptionSync)', () => {
    test('正確註冊 AppState 監聽器，並在卸載時移除', () => {
      const removeMock = jest.fn();
      const addEventListenerSpy = jest.spyOn(AppState, 'addEventListener').mockReturnValue({
        remove: removeMock,
      } as any);

      const unsubscribe = setupForegroundSubscriptionSync({
        getSubscription: () => ({ plan: 'pro', billingCycle: 'monthly', status: 'active' }),
        setSubscription: jest.fn(),
      });

      expect(addEventListenerSpy).toHaveBeenCalledWith('change', expect.any(Function));

      unsubscribe();
      expect(removeMock).toHaveBeenCalledTimes(1);

      addEventListenerSpy.mockRestore();
    });
  });
});
