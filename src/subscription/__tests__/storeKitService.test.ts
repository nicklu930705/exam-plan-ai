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
  ProductionStoreKitService,
  ServerSideTransactionValidator,
} from '../storeKitService';

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

    test('ServerSideTransactionValidator 支援預留之遠端驗證端點', async () => {
      const serverValidator = new ServerSideTransactionValidator('https://api.examplanai.com');
      const res = await serverValidator.validate({ productId: 'exampro_monthly', id: '123' });
      expect(res.valid).toBe(true);
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
});
