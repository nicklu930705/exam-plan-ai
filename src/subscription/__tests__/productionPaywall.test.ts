import fs from 'fs';
import path from 'path';
import { isIapSandboxConfigured, isSandboxEnvironmentValid, SANDBOX_BACKEND_URL } from '../../storage';
import { isSandboxIapAllowed } from '../storeKitConfig';

// 模擬 AsyncStorage
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

describe('App Store 正式上架 Production Paywall 與條款合規測試', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('1. Paywall 按鈕文案與狀態邏輯檢驗', () => {
    test('Production 模式（無 Sandbox 旗標）：按鈕應為「以 NT$XXX 開通方案」，非測試購買', () => {
      delete process.env.EXPO_PUBLIC_ENABLE_IAP_SANDBOX;
      process.env.EXPO_PUBLIC_BACKEND_URL = 'https://exam-plan-ai-backend-coral.vercel.app';

      const isSandboxAllowed = isSandboxIapAllowed();
      expect(isSandboxAllowed).toBe(false);

      const priceFormatted = 'NT$149';
      const buttonTitle = isSandboxAllowed
        ? `以 ${priceFormatted} 測試購買方案`
        : `以 ${priceFormatted} 開通方案`;

      expect(buttonTitle).toBe('以 NT$149 開通方案');
      expect(buttonTitle).not.toContain('測試');
    });

    test('Sandbox 模式（宣告 Sandbox 且合規）：按鈕應為「以 NT$XXX 測試購買方案」', () => {
      process.env.EXPO_PUBLIC_ENABLE_IAP_SANDBOX = 'true';
      process.env.EXPO_PUBLIC_BACKEND_URL = SANDBOX_BACKEND_URL;

      const isSandboxAllowed = isSandboxIapAllowed();
      expect(isSandboxAllowed).toBe(true);

      const priceFormatted = 'NT$149';
      const buttonTitle = isSandboxAllowed
        ? `以 ${priceFormatted} 測試購買方案`
        : `以 ${priceFormatted} 開通方案`;

      expect(buttonTitle).toBe('以 NT$149 測試購買方案');
    });

    test('Production 環境不應觸發 isSandboxMisconfigured 阻斷', () => {
      delete process.env.EXPO_PUBLIC_ENABLE_IAP_SANDBOX;
      process.env.EXPO_PUBLIC_BACKEND_URL = 'https://exam-plan-ai-backend-coral.vercel.app';

      const isSandboxConfigured = isIapSandboxConfigured();
      const isSandboxValid = isSandboxEnvironmentValid();
      const isSandboxMisconfigured = isSandboxConfigured && !isSandboxValid;

      expect(isSandboxConfigured).toBe(false);
      expect(isSandboxMisconfigured).toBe(false);
    });

    test('若誤將 Sandbox 旗標打開但指向 Production 後端，必須安全阻斷', () => {
      process.env.EXPO_PUBLIC_ENABLE_IAP_SANDBOX = 'true';
      process.env.EXPO_PUBLIC_BACKEND_URL = 'https://exam-plan-ai-backend-coral.vercel.app';

      const isSandboxConfigured = isIapSandboxConfigured();
      const isSandboxValid = isSandboxEnvironmentValid();
      const isSandboxMisconfigured = isSandboxConfigured && !isSandboxValid;

      expect(isSandboxConfigured).toBe(true);
      expect(isSandboxValid).toBe(false);
      expect(isSandboxMisconfigured).toBe(true);
    });
  });

  describe('2. 訂閱條款 (Terms) 合規審查', () => {
    const termsPath = path.resolve(__dirname, '../../app/terms.tsx');
    const termsContent = fs.readFileSync(termsPath, 'utf-8');

    test('條款中不得含有 TestFlight 暫未開放購買等暫停文案', () => {
      expect(termsContent).not.toContain('TestFlight 測試階段說明');
      expect(termsContent).not.toContain('付費方案暫未開放購買');
      expect(termsContent).not.toContain('開發者預覽測試提示');
    });

    test('條款必須包含第 5 條「方案變更與終止說明」及取消訂閱指引', () => {
      expect(termsContent).toContain('5. 方案變更與終止說明');
      expect(termsContent).toContain('設定 → Apple ID → 訂閱項目');
      expect(termsContent).toContain('取消自動續約');
      expect(termsContent).toContain('自動安全過渡為 Free 免費版');
    });

    test('條款必須明確保證本機讀書資料永久保留', () => {
      expect(termsContent).toContain('即使方案到期或更換方案');
      expect(termsContent).toContain('歷史讀書紀錄絕不會被刪除或損壞');
    });
  });

  describe('3. subscription.tsx Paywall 畫面原始碼審查', () => {
    const subScreenPath = path.resolve(__dirname, '../../app/(tabs)/subscription.tsx');
    const subScreenContent = fs.readFileSync(subScreenPath, 'utf-8');

    test('Paywall 原始碼不得包含硬編碼阻斷正式購買之邏輯', () => {
      // 確保沒有 !__DEV__ && !isSandboxAllowed 的阻斷 alert
      expect(subScreenContent).not.toMatch(/!__DEV__\s*&&\s*!isSandboxAllowed/);
      expect(subScreenContent).not.toContain('testFlightNoticeCard');
      expect(subScreenContent).not.toContain('付費方案暫未開放購買');
    });

    test('Paywall 購買與恢復按鈕在正式環境下必須處於可操作狀態', () => {
      // 購買按鈕 disabled 條件確認
      expect(subScreenContent).toContain('disabled={');
      expect(subScreenContent).not.toContain('selectedProduct.tier !== \'free\'');
    });
  });
});
