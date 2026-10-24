import { Platform } from 'react-native';
import {
  ALL_STOREKIT_PRODUCT_IDS,
  APPLE_MANAGE_SUBSCRIPTIONS_URL,
  isValidProductId,
  STOREKIT_PRODUCT_IDS,
} from '../storeKitConfig';
import {
  ClientSideTransactionValidator,
  DevStoreKitService,
  evaluatePurchasesEntitlement,
  isStoreKitCode14,
  isStoreKitUserCancelled,
  ProductionStoreKitService,
  ServerSideTransactionValidator,
} from '../storeKitService';

// 模擬 AsyncStorage
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

export const mockGetAvailablePurchases = jest.fn();
export const mockRestorePurchases = jest.fn();
export const mockFinishTransaction = jest.fn().mockResolvedValue(true);
export const mockShowManageSubscriptionsIOS = jest.fn();

jest.mock('expo-iap', () => ({
  initConnection: jest.fn().mockResolvedValue(true),
  getAvailablePurchases: (...args: any[]) => mockGetAvailablePurchases(...args),
  restorePurchases: (...args: any[]) => mockRestorePurchases(...args),
  finishTransaction: (...args: any[]) => mockFinishTransaction(...args),
  requestPurchase: jest.fn(),
  purchaseUpdatedListener: jest.fn(() => ({ remove: jest.fn() })),
  purchaseErrorListener: jest.fn(() => ({ remove: jest.fn() })),
  fetchProducts: jest.fn().mockResolvedValue([]),
  showManageSubscriptionsIOS: (...args: any[]) => mockShowManageSubscriptionsIOS(...args),
  isUserCancelledError: (err: any) =>
    err?.code === 'user-cancelled' ||
    err?.code === 'E_USER_CANCELLED' ||
    err?.message?.includes('user-cancelled'),
}));

describe('StoreKit 2 與 Apple 內購系統核心邏輯', () => {
  describe('1. 產品 ID 集中管理與合法性檢驗', () => {
    test('包含指定的三種產品 ID 常數', () => {
      expect(STOREKIT_PRODUCT_IDS.MONTHLY).toBe('exampro_monthly');
      expect(STOREKIT_PRODUCT_IDS.YEARLY).toBe('exampro_yearly');
      expect(STOREKIT_PRODUCT_IDS.LIFETIME).toBe('exampro_lifetime');
    });

    test('ALL_STOREKIT_PRODUCT_IDS 包含所有三個產品', () => {
      expect(ALL_STOREKIT_PRODUCT_IDS).toHaveLength(3);
      expect(ALL_STOREKIT_PRODUCT_IDS).toContain('exampro_monthly');
      expect(ALL_STOREKIT_PRODUCT_IDS).toContain('exampro_yearly');
      expect(ALL_STOREKIT_PRODUCT_IDS).toContain('exampro_lifetime');
    });

    test('isValidProductId 正確識別有效與無效 ID', () => {
      expect(isValidProductId('exampro_monthly')).toBe(true);
      expect(isValidProductId('exampro_yearly')).toBe(true);
      expect(isValidProductId('exampro_lifetime')).toBe(true);
      expect(isValidProductId('invalid_id')).toBe(false);
      expect(isValidProductId('exampro_quarterly')).toBe(false);
    });

    test('Apple 訂閱管理網址格式正確', () => {
      expect(APPLE_MANAGE_SUBSCRIPTIONS_URL).toBe(
        'https://apps.apple.com/account/subscriptions',
      );
    });
  });

  describe('2. 權限評估引擎 (evaluatePurchasesEntitlement)', () => {
    test('傳入空陣列或無效購買時回傳 free 等級', () => {
      const res1 = evaluatePurchasesEntitlement([]);
      expect(res1.tier).toBe('free');
      expect(res1.status).toBe('none');

      const res2 = evaluatePurchasesEntitlement(null as any);
      expect(res2.tier).toBe('free');
      expect(res2.status).toBe('none');
    });

    test('終身買斷版 (exampro_lifetime) 給予永久 lifetime 權限，不受過期限制', () => {
      const purchases = [
        {
          id: 'txn-life-1',
          productId: 'exampro_lifetime',
          transactionDate: 1700000000000,
          originalTransactionIdentifierIOS: 'orig-life-1',
          purchaseState: 'purchased',
        },
      ];

      const res = evaluatePurchasesEntitlement(purchases);
      expect(res.tier).toBe('lifetime');
      expect(res.status).toBe('active');
      expect(res.subscription?.plan).toBe('lifetime');
      expect(res.subscription?.billingCycle).toBe('lifetime');
      expect(res.subscription?.productId).toBe('exampro_lifetime');
      expect(res.subscription?.expiresAt).toBeUndefined();
    });

    test('若終身買斷版已被 Apple 退款或撤銷 (revocationDateIOS != null)，不給予會員權限', () => {
      const purchases = [
        {
          id: 'txn-life-revoked',
          productId: 'exampro_lifetime',
          transactionDate: 1700000000000,
          revocationDateIOS: 1700100000000, // 已被退款撤銷
          purchaseState: 'purchased',
        },
      ];

      const res = evaluatePurchasesEntitlement(purchases);
      expect(res.tier).toBe('free');
      expect(res.status).toBe('none');
    });

    test('有效之 Pro 年訂閱 (exampro_yearly) 賦予 Pro 權限並具備精確到期日', () => {
      const futureExp = Date.now() + 180 * 24 * 3600 * 1000;
      const purchases = [
        {
          id: 'txn-year-1',
          productId: 'exampro_yearly',
          transactionDate: Date.now() - 30 * 24 * 3600 * 1000,
          expirationDateIOS: futureExp,
          originalTransactionIdentifierIOS: 'orig-year-1',
          isAutoRenewing: true,
          purchaseState: 'purchased',
        },
      ];

      const res = evaluatePurchasesEntitlement(purchases);
      expect(res.tier).toBe('pro');
      expect(res.status).toBe('active');
      expect(res.subscription?.plan).toBe('pro');
      expect(res.subscription?.billingCycle).toBe('annual');
      expect(res.subscription?.expiresAt).toBe(new Date(futureExp).toISOString());
      expect(res.subscription?.isAutoRenewing).toBe(true);
    });

    test('有效之 Pro 月訂閱 (exampro_monthly) 賦予 Pro 權限', () => {
      const futureExp = Date.now() + 15 * 24 * 3600 * 1000;
      const purchases = [
        {
          id: 'txn-month-1',
          productId: 'exampro_monthly',
          transactionDate: Date.now() - 15 * 24 * 3600 * 1000,
          expirationDateIOS: futureExp,
          originalTransactionIdentifierIOS: 'orig-month-1',
          isAutoRenewing: true,
          purchaseState: 'purchased',
        },
      ];

      const res = evaluatePurchasesEntitlement(purchases);
      expect(res.tier).toBe('pro');
      expect(res.status).toBe('active');
      expect(res.subscription?.plan).toBe('pro');
      expect(res.subscription?.billingCycle).toBe('monthly');
    });

    test('訂閱已過期 (expirationDateIOS 在過去) 時降回 Free，狀態標記為 expired', () => {
      const pastExp = Date.now() - 5 * 24 * 3600 * 1000;
      const purchases = [
        {
          id: 'txn-expired-1',
          productId: 'exampro_monthly',
          transactionDate: Date.now() - 35 * 24 * 3600 * 1000,
          expirationDateIOS: pastExp,
          isAutoRenewing: false,
          purchaseState: 'purchased',
        },
      ];

      const res = evaluatePurchasesEntitlement(purchases);
      expect(res.tier).toBe('free');
      expect(res.status).toBe('expired');
      expect(res.subscription?.status).toBe('expired');
    });

    test('同時有終身版與過期月訂閱時，優先維持終身版授權', () => {
      const purchases = [
        {
          id: 'txn-exp-sub',
          productId: 'exampro_monthly',
          transactionDate: Date.now() - 100 * 86400 * 1000,
          expirationDateIOS: Date.now() - 70 * 86400 * 1000,
        },
        {
          id: 'txn-life-active',
          productId: 'exampro_lifetime',
          transactionDate: Date.now() - 50 * 86400 * 1000,
        },
      ];

      const res = evaluatePurchasesEntitlement(purchases);
      expect(res.tier).toBe('lifetime');
      expect(res.status).toBe('active');
    });

    test('由月訂閱切換為年訂閱時，即使月訂閱尚未到期，仍以最新交易之年訂閱為準', () => {
      const now = Date.now();
      const purchases = [
        {
          id: 'txn-month-early',
          productId: 'exampro_monthly',
          transactionDate: now - 10 * 86400 * 1000,
          expirationDateIOS: now + 20 * 86400 * 1000,
          originalTransactionIdentifierIOS: 'orig-sub-chain',
        },
        {
          id: 'txn-year-upgrade',
          productId: 'exampro_yearly',
          transactionDate: now - 1 * 86400 * 1000, // 較新升級交易
          expirationDateIOS: now + 364 * 86400 * 1000,
          originalTransactionIdentifierIOS: 'orig-sub-chain',
        },
      ];

      const res = evaluatePurchasesEntitlement(purchases);
      expect(res.tier).toBe('pro');
      expect(res.status).toBe('active');
      expect(res.subscription?.plan).toBe('pro');
      expect(res.subscription?.billingCycle).toBe('annual');
      expect(res.subscription?.productId).toBe('exampro_yearly');
      expect(res.subscription?.transactionId).toBe('txn-year-upgrade');
    });

    test('月訂閱已過期但年訂閱有效時，正確挑選有效之年訂閱方案', () => {
      const now = Date.now();
      const purchases = [
        {
          id: 'txn-month-old',
          productId: 'exampro_monthly',
          transactionDate: now - 40 * 86400 * 1000,
          expirationDateIOS: now - 10 * 86400 * 1000, // 已過期
        },
        {
          id: 'txn-year-current',
          productId: 'exampro_yearly',
          transactionDate: now - 5 * 86400 * 1000,
          expirationDateIOS: now + 360 * 86400 * 1000, // 有效
        },
      ];

      const res = evaluatePurchasesEntitlement(purchases);
      expect(res.tier).toBe('pro');
      expect(res.status).toBe('active');
      expect(res.subscription?.billingCycle).toBe('annual');
    });

    test('多筆訂閱皆已過期時，以最新交易之方案為準且標記 status=expired', () => {
      const now = Date.now();
      const purchases = [
        {
          id: 'txn-month-old',
          productId: 'exampro_monthly',
          transactionDate: now - 90 * 86400 * 1000,
          expirationDateIOS: now - 60 * 86400 * 1000,
        },
        {
          id: 'txn-year-later',
          productId: 'exampro_yearly',
          transactionDate: now - 40 * 86400 * 1000, // 較新交易
          expirationDateIOS: now - 5 * 86400 * 1000,
        },
      ];

      const res = evaluatePurchasesEntitlement(purchases);
      expect(res.tier).toBe('free');
      expect(res.status).toBe('expired');
      expect(res.subscription?.productId).toBe('exampro_yearly');
      expect(res.subscription?.billingCycle).toBe('annual');
    });

    test('月訂閱有效但年訂閱生效日期在未來時，不可提前授權未生效之年訂閱，應維持當前有效之月訂閱', () => {
      const now = Date.now();
      const purchases = [
        {
          id: 'txn-month-active-now',
          productId: 'exampro_monthly',
          transactionDate: now - 10 * 86400 * 1000,
          expirationDateIOS: now + 20 * 86400 * 1000,
        },
        {
          id: 'txn-year-scheduled-future',
          productId: 'exampro_yearly',
          transactionDate: now + 20 * 86400 * 1000, // 未來生效
          expirationDateIOS: now + 385 * 86400 * 1000,
        },
      ];

      const res = evaluatePurchasesEntitlement(purchases);
      expect(res.tier).toBe('pro');
      expect(res.status).toBe('active');
      expect(res.subscription?.productId).toBe('exampro_monthly');
      expect(res.subscription?.billingCycle).toBe('monthly');
    });
  });

  describe('3. 交易驗證器架構 (Transaction Validators)', () => {
    test('ClientSideTransactionValidator 能攔截無效 SKU 與撤銷交易', async () => {
      const validator = new ClientSideTransactionValidator();

      // 有效交易
      const validTxn = { productId: 'exampro_monthly', id: '123' };
      const resValid = await validator.validate(validTxn);
      expect(resValid.valid).toBe(true);

      // 無效 SKU
      const invalidSku = { productId: 'unknown_product', id: '124' };
      const resInvalid = await validator.validate(invalidSku);
      expect(resInvalid.valid).toBe(false);
      expect(resInvalid.reason).toContain('未知的產品識別碼');

      // 已退款撤銷交易
      const revokedTxn = {
        productId: 'exampro_monthly',
        id: '125',
        revocationDateIOS: 1700000000000,
      };
      const resRevoked = await validator.validate(revokedTxn);
      expect(resRevoked.valid).toBe(false);
      expect(resRevoked.reason).toContain('撤銷或退款');
    });

    test('ServerSideTransactionValidator 支援預留之遠端驗證端點與 JWS 處理', async () => {
      const serverValidator = new ServerSideTransactionValidator('https://api.examplanai.com');

      // 1. 開發模式下無 JWS 之平滑回退
      const resDev = await serverValidator.validate({ productId: 'exampro_monthly', id: '123' });
      expect(resDev.valid).toBe(true);

      // 2. 有 JWS 時模擬後端 /api/verify-transaction 成功回應
      const originalFetch = global.fetch;
      try {
        global.fetch = jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            tier: 'pro',
            status: 'active',
            productId: 'exampro_yearly',
            originalTransactionId: 'orig_123',
            proofToken: 'mock_proof_token_123',
          }),
        } as any);

        const resServer = await serverValidator.validate({
          productId: 'exampro_yearly',
          id: 'txn_999',
          purchaseToken: 'mock_signed_jws_string',
        });

        expect(resServer.valid).toBe(true);
        expect(resServer.tier).toBe('pro');
        expect(resServer.proofToken).toBe('mock_proof_token_123');
        expect(resServer.originalTransactionId).toBe('orig_123');

        // 3. 模擬後端回傳退款 (revoked) 狀態
        global.fetch = jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            success: false,
            code: 'TRANSACTION_REVOKED',
            status: 'revoked',
            tier: 'free',
            error: '此交易已被 Apple 撤銷或退款。',
          }),
        } as any);

        const resRevoked = await serverValidator.validate({
          productId: 'exampro_yearly',
          id: 'txn_999',
          purchaseToken: 'mock_revoked_jws_string',
        });

        expect(resRevoked.valid).toBe(false);
        expect(resRevoked.status).toBe('revoked');
        expect(resRevoked.reason).toContain('撤銷或退款');
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('4. DevStoreKitService 運作測試', () => {
    const devService = new DevStoreKitService();

    test('取得之產品清單使用集中化常數 ID', async () => {
      const prods = await devService.getProducts();
      const ids = prods.map((p) => p.id);
      expect(ids).toContain('exampro_monthly');
      expect(ids).toContain('exampro_yearly');
      expect(ids).toContain('exampro_lifetime');
    });

    test('模擬購買月繳與年繳正確產生到期日', async () => {
      const buyMonth = await devService.purchase('exampro_monthly');
      expect(buyMonth.success).toBe(true);
      expect(buyMonth.subscription?.plan).toBe('pro');
      expect(buyMonth.subscription?.billingCycle).toBe('monthly');
      expect(buyMonth.subscription?.expiresAt).toBeDefined();

      const buyYear = await devService.purchase('exampro_yearly');
      expect(buyYear.success).toBe(true);
      expect(buyYear.subscription?.plan).toBe('pro');
      expect(buyYear.subscription?.billingCycle).toBe('annual');
    });

    test('模擬購買終身版無過期時間', async () => {
      const buyLife = await devService.purchase('exampro_lifetime');
      expect(buyLife.success).toBe(true);
      expect(buyLife.subscription?.plan).toBe('lifetime');
      expect(buyLife.subscription?.expiresAt).toBeUndefined();
    });

    test('非開發環境 (!__DEV__) 下，Mock 服務嚴禁通過付費方案購買', async () => {
      const originalDev = (global as any).__DEV__;
      try {
        (global as any).__DEV__ = false;
        const buyResult = await devService.purchase('exampro_monthly');
        expect(buyResult.success).toBe(false);
        expect(buyResult.status).toBe('failed');
        expect(buyResult.subscription).toBeUndefined();
      } finally {
        (global as any).__DEV__ = originalDev;
      }
    });
  });

  describe('5. ProductionStoreKitService 測試預覽模式與狀態回報', () => {
    test('強制開啟 devMode 時回報 dev_preview 環境與說明', () => {
      const prodService = new ProductionStoreKitService();
      prodService.setDevPreviewMode(true);
      expect(prodService.isDevPreviewMode()).toBe(true);

      const status = prodService.getStoreStatus();
      expect(status.environment).toBe('dev_preview');
      expect(status.notice).toContain('開發測試模式');
    });

    test('非開發環境 (!__DEV__) 下，ProductionStoreKitService 回退時嚴禁通過付費購買', async () => {
      const originalDev = (global as any).__DEV__;
      try {
        (global as any).__DEV__ = false;
        const prod = new ProductionStoreKitService();
        prod.setDevPreviewMode(true);
        const res = await prod.purchase('exampro_yearly');
        expect(res.success).toBe(false);
        expect(res.status).toBe('failed');
        expect(res.subscription).toBeUndefined();
      } finally {
        (global as any).__DEV__ = originalDev;
      }
    });
  });

  describe('6. StoreKit 2 錯誤識別與取消判斷', () => {
    test('正確識別 SKInternalErrorDomain Code 14 錯誤字串與物件', () => {
      // 情況 1: 標準 iOS 系統錯誤字串
      const err1 = new Error(
        "The operation couldn't be completed. (SKInternalErrorDomain error 14.)",
      );
      expect(isStoreKitCode14(err1)).toBe(true);

      // 情況 2: 物件形式具備 code: 14 與 domain
      const err2 = { code: 14, domain: 'SKInternalErrorDomain' };
      expect(isStoreKitCode14(err2)).toBe(true);

      // 情況 3: code: '14' 字串
      const err3 = { code: '14', domain: 'SKInternalErrorDomain' };
      expect(isStoreKitCode14(err3)).toBe(true);

      // 情況 4: 包含 SKInternalErrorDomain 與 14 之訊息
      const err4 = new Error('Error: [SKInternalErrorDomain:14] Sync failed');
      expect(isStoreKitCode14(err4)).toBe(true);

      // 情況 5: 一般網路或非 Code 14 錯誤，不應誤判
      expect(isStoreKitCode14(new Error('Network request failed'))).toBe(false);
      expect(isStoreKitCode14(new Error('SKErrorDomain error 2'))).toBe(false);
      expect(isStoreKitCode14(null)).toBe(false);
    });

    test('正確識別使用者主動取消操作', () => {
      expect(isStoreKitUserCancelled({ code: 'user-cancelled' })).toBe(true);
      expect(isStoreKitUserCancelled({ code: 'E_USER_CANCELLED' })).toBe(true);
      expect(
        isStoreKitUserCancelled(
          new Error('User cancelled the authorization modal'),
        ),
      ).toBe(true);
      expect(isStoreKitUserCancelled(new Error('使用者取消交易'))).toBe(true);
      expect(isStoreKitUserCancelled(new Error('Network timeout'))).toBe(false);
    });
  });

  describe('7. 兩階段恢復購買 (Two-Phase Restore Purchases)', () => {
    beforeEach(() => {
      mockGetAvailablePurchases.mockReset();
      mockRestorePurchases.mockReset();
      mockFinishTransaction.mockReset().mockResolvedValue(true);
    });

    test('階段一：裝置端快取已有購買紀錄時，不調用 AppStore.sync() 即可成功恢復', async () => {
      const now = Date.now();
      mockGetAvailablePurchases.mockResolvedValue([
        {
          id: 'txn-cached-1',
          productId: 'exampro_yearly',
          transactionDate: now - 5 * 86400 * 1000,
          expirationDateIOS: now + 360 * 86400 * 1000,
          originalTransactionIdentifierIOS: 'orig-chain-1',
          isAutoRenewing: true,
          purchaseToken: 'mock-valid-jws-token',
        },
      ]);

      const mockValidator = {
        validate: jest.fn().mockResolvedValue({
          valid: true,
          tier: 'pro',
          status: 'active',
          proofToken: 'mock-proof-token-abc',
          expiresDate: now + 360 * 86400 * 1000,
        }),
      };

      const prod = new ProductionStoreKitService(mockValidator as any);
      prod.setNativeModeForTesting(true);

      const result = await prod.restorePurchases({ syncWithAppStore: false });

      expect(result.success).toBe(true);
      expect(result.status).toBe('success');
      expect(result.subscription?.plan).toBe('pro');
      expect(result.subscription?.billingCycle).toBe('annual');
      expect(result.subscription?.proofToken).toBe('mock-proof-token-abc');

      // 核心安全驗證：階段一絕不調用 expo-iap 的 restorePurchases (即不觸發 AppStore.sync())
      expect(mockRestorePurchases).not.toHaveBeenCalled();
      expect(mockValidator.validate).toHaveBeenCalledTimes(1);
    });

    test('階段一：裝置端快取查無紀錄且未要求深度同步時，回傳 needs_sync 並允許重試', async () => {
      mockGetAvailablePurchases.mockResolvedValue([]);

      const prod = new ProductionStoreKitService();
      prod.setNativeModeForTesting(true);

      const result = await prod.restorePurchases({ syncWithAppStore: false });

      expect(result.success).toBe(false);
      expect(result.status).toBe('needs_sync');
      expect(result.canRetrySync).toBe(true);
      expect(mockRestorePurchases).not.toHaveBeenCalled();
    });

    test('階段二：向 Apple 深度同步遭遇 SKInternalErrorDomain Code 14 時，回傳 sync_error 友善提示且不清除狀態', async () => {
      mockRestorePurchases.mockRejectedValue(
        new Error(
          "The operation couldn't be completed. (SKInternalErrorDomain error 14.)",
        ),
      );

      const prod = new ProductionStoreKitService();
      prod.setNativeModeForTesting(true);

      const result = await prod.restorePurchases({ syncWithAppStore: true });

      expect(result.success).toBe(false);
      expect(result.status).toBe('sync_error');
      expect(result.errorCode).toBe('SKInternalErrorDomain:14');
      expect(result.canRetrySync).toBe(true);
      expect(result.message).toContain('Apple App Store 伺服器同步暫時中斷');
      expect(result.message).toContain('錯誤代碼: 14');
      // 確保未給出錯誤覆寫訂閱
      expect(result.subscription).toBeUndefined();
    });

    test('階段二：向 Apple 深度同步時使用者取消驗證，回傳 cancelled 狀態', async () => {
      mockRestorePurchases.mockRejectedValue({ code: 'user-cancelled' });

      const prod = new ProductionStoreKitService();
      prod.setNativeModeForTesting(true);

      const result = await prod.restorePurchases({ syncWithAppStore: true });

      expect(result.success).toBe(false);
      expect(result.status).toBe('cancelled');
      expect(result.message).toContain('取消');
    });

    test('Lifetime 購買紀錄可正確恢復為永久會員，無過期時間且標記 active', async () => {
      mockGetAvailablePurchases.mockResolvedValue([
        {
          id: 'txn-life-1',
          productId: 'exampro_lifetime',
          transactionDate: Date.now() - 30 * 86400 * 1000,
          purchaseToken: 'mock-life-jws',
        },
      ]);

      const mockValidator = {
        validate: jest.fn().mockResolvedValue({
          valid: true,
          tier: 'lifetime',
          status: 'active',
          proofToken: 'proof-life-xyz',
        }),
      };

      const prod = new ProductionStoreKitService(mockValidator as any);
      prod.setNativeModeForTesting(true);

      const result = await prod.restorePurchases({ syncWithAppStore: false });

      expect(result.success).toBe(true);
      expect(result.status).toBe('success');
      expect(result.subscription?.plan).toBe('lifetime');
      expect(result.subscription?.billingCycle).toBe('lifetime');
      expect(result.subscription?.expiresAt).toBeUndefined();
      expect(result.subscription?.proofToken).toBe('proof-life-xyz');
    });

    test('後端驗證失敗時，不可開通付費會員權益並回傳 verification_failed', async () => {
      mockGetAvailablePurchases.mockResolvedValue([
        {
          id: 'txn-forged-1',
          productId: 'exampro_yearly',
          transactionDate: Date.now(),
          purchaseToken: 'invalid-jws-signature',
        },
      ]);

      const mockValidator = {
        validate: jest.fn().mockResolvedValue({
          valid: false,
          reason: 'Apple JWS 數位簽章無效或憑證已被撤銷。',
        }),
      };

      const prod = new ProductionStoreKitService(mockValidator as any);
      prod.setNativeModeForTesting(true);

      const result = await prod.restorePurchases({ syncWithAppStore: false });

      expect(result.success).toBe(false);
      expect(result.status).toBe('verification_failed');
      expect(result.subscription).toBeUndefined();
      expect(result.message).toContain('數位簽章無效');
    });

    test('並行防護：當恢復購買正在進行中時，重複呼叫回傳 busy 狀態', async () => {
      let resolveFirstCall: (v: any) => void = () => {};
      const slowPromise = new Promise((resolve) => {
        resolveFirstCall = resolve;
      });

      mockGetAvailablePurchases.mockReturnValue(slowPromise);

      const prod = new ProductionStoreKitService();
      prod.setNativeModeForTesting(true);

      // 第一個請求發起（仍在進行中）
      const promise1 = prod.restorePurchases({ syncWithAppStore: false });

      // 第二個請求立即跟進
      const promise2 = prod.restorePurchases({ syncWithAppStore: false });

      const result2 = await promise2;
      expect(result2.success).toBe(false);
      expect(result2.status).toBe('busy');
      expect(result2.message).toContain('處理中');

      // 結束第一個請求
      resolveFirstCall([]);
      await promise1;
    });

    test('多筆交易恢復時，確保回傳之 proofToken 精確匹配勝出方案的交易識別碼，不因陣列順序錯配', async () => {
      const now = Date.now();
      mockGetAvailablePurchases.mockResolvedValue([
        {
          id: 'txn-month-earlier',
          productId: 'exampro_monthly',
          transactionDate: now - 15 * 86400 * 1000,
          expirationDateIOS: now + 15 * 86400 * 1000,
          originalTransactionIdentifierIOS: 'orig-chain-month',
        },
        {
          id: 'txn-year-winner',
          productId: 'exampro_yearly',
          transactionDate: now - 1 * 86400 * 1000,
          expirationDateIOS: now + 364 * 86400 * 1000,
          originalTransactionIdentifierIOS: 'orig-chain-year',
        },
      ]);

      const mockValidator = {
        validate: jest.fn().mockImplementation(async (p: any) => {
          if (p.productId === 'exampro_yearly') {
            return {
              valid: true,
              tier: 'pro',
              status: 'active',
              proofToken: 'proof-token-YEARLY-CORRECT',
              expiresDate: now + 364 * 86400 * 1000,
            };
          }
          return {
            valid: true,
            tier: 'pro',
            status: 'active',
            proofToken: 'proof-token-MONTHLY-OLD',
            expiresDate: now + 15 * 86400 * 1000,
          };
        }),
      };

      const prod = new ProductionStoreKitService(mockValidator as any);
      prod.setNativeModeForTesting(true);

      const result = await prod.restorePurchases({ syncWithAppStore: false });

      expect(result.success).toBe(true);
      expect(result.status).toBe('success');
      expect(result.subscription?.billingCycle).toBe('annual');
      expect(result.subscription?.productId).toBe('exampro_yearly');
      // 確保 proofToken 絕對是勝出年繳方案的 proofToken，絕不被月繳覆蓋
      expect(result.subscription?.proofToken).toBe('proof-token-YEARLY-CORRECT');
    });
  });

  describe('11. Apple 官方訂閱管理 (manageSubscriptions) 原生工作表與安全防護', () => {
    let originalPlatform: string;

    beforeEach(() => {
      jest.clearAllMocks();
      originalPlatform = Platform.OS;
    });

    afterEach(() => {
      Platform.OS = originalPlatform as any;
    });

    test('1. 在 iOS 原生環境成功開啟 StoreKit 2 工作表，回傳 sheet_presented', async () => {
      Platform.OS = 'ios';
      mockShowManageSubscriptionsIOS.mockResolvedValueOnce([]);

      const prod = new ProductionStoreKitService();
      prod.setNativeModeForTesting(true);
      prod.setDevPreviewMode(false);

      const result = await prod.manageSubscriptions();

      expect(mockShowManageSubscriptionsIOS).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(result.status).toBe('sheet_presented');
    });

    test('2. 當 showManageSubscriptionsIOS 拋出錯誤時，安全回傳 failed，不無提示跳轉外部網址', async () => {
      Platform.OS = 'ios';
      mockShowManageSubscriptionsIOS.mockRejectedValueOnce(
        new Error('StoreKit sheet presentation failed'),
      );

      const prod = new ProductionStoreKitService();
      prod.setNativeModeForTesting(true);
      prod.setDevPreviewMode(false);

      const result = await prod.manageSubscriptions();

      expect(mockShowManageSubscriptionsIOS).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('StoreKit sheet presentation failed');
    });

    test('3. 在非 iOS 平台 (如 Android) 調用時，安全攔截並回傳 unsupported_platform', async () => {
      Platform.OS = 'android';

      const prod = new ProductionStoreKitService();
      prod.setDevPreviewMode(false);

      const result = await prod.manageSubscriptions();

      expect(mockShowManageSubscriptionsIOS).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.status).toBe('unsupported_platform');
      expect(result.error).toContain('僅支援 iOS');
    });

    test('4. 當處於開發預覽模式 (isDevPreviewMode = true) 時，安全回傳 dev_preview', async () => {
      Platform.OS = 'ios';

      const prod = new ProductionStoreKitService();
      prod.setDevPreviewMode(true);

      const result = await prod.manageSubscriptions();

      expect(mockShowManageSubscriptionsIOS).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.status).toBe('dev_preview');
    });

    test('5. DevStoreKitService 一致回傳 dev_preview 狀態', async () => {
      const dev = new DevStoreKitService();
      const result = await dev.manageSubscriptions();

      expect(result.success).toBe(false);
      expect(result.status).toBe('dev_preview');
      expect(result.error).toContain('開發測試模式下無真實 Apple 訂閱');
    });
  });
});
