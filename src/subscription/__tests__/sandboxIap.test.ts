import fs from 'fs';
import path from 'path';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  DEFAULT_BACKEND_URL,
  getBackendUrlFromStorage,
  isIapSandboxConfigured,
  isSandboxEnvironmentValid,
  SANDBOX_BACKEND_URL,
} from '../../storage';
import {
  isSandboxIapAllowed,
  STOREKIT_PRODUCT_IDS,
} from '../storeKitConfig';
import { ServerSideTransactionValidator } from '../storeKitService';
import { fetchFromBackendApi } from '../../services/aiAdviceService';

// 模擬 AsyncStorage
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

describe('Apple Sandbox 內購實機測試環境整合防護測試', () => {
  const originalEnv = process.env;

  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('1. eas.json 設定檢驗', () => {
    const easPath = path.resolve(__dirname, '../../../eas.json');
    let easJson: any;

    beforeAll(() => {
      const content = fs.readFileSync(easPath, 'utf-8');
      easJson = JSON.parse(content);
    });

    test('eas.json 必須包含獨立的 build.sandbox Profile', () => {
      expect(easJson.build.sandbox).toBeDefined();
      expect(easJson.build.sandbox.distribution).toBe('internal');
      expect(easJson.build.sandbox.ios?.simulator).toBe(false);
    });

    test('eas.json 必須包含獨立的 build["sandbox-testflight"] Profile (StoreKit TestFlight 模式)', () => {
      const stf = easJson.build['sandbox-testflight'];
      expect(stf).toBeDefined();
      expect(stf.distribution).toBe('store');
      expect(stf.ios?.simulator).toBe(false);
      expect(stf.env.EXPO_PUBLIC_BACKEND_URL).toBe(
        'https://exam-plan-ai-backend-sandbox.vercel.app',
      );
      expect(stf.env.EXPO_PUBLIC_ENABLE_IAP_SANDBOX).toBe('true');
    });

    test('sandbox Profile 必須精確指向 Sandbox 後端網址並啟用 Sandbox 旗標', () => {
      const sandboxEnv = easJson.build.sandbox.env;
      expect(sandboxEnv.EXPO_PUBLIC_BACKEND_URL).toBe(
        'https://exam-plan-ai-backend-sandbox.vercel.app',
      );
      expect(sandboxEnv.EXPO_PUBLIC_ENABLE_IAP_SANDBOX).toBe('true');
    });

    test('production Profile 絕不繼承 Sandbox 變數且嚴格指向正式後端', () => {
      const prodEnv = easJson.build.production.env;
      expect(prodEnv.EXPO_PUBLIC_BACKEND_URL).toBe(
        'https://exam-plan-ai-backend-coral.vercel.app',
      );
      expect(prodEnv.EXPO_PUBLIC_ENABLE_IAP_SANDBOX).toBeUndefined();
    });

    test('eas.json 絕不包含任何 API Key、Redis Token 或私鑰', () => {
      const easString = JSON.stringify(easJson);
      expect(easString).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);
      expect(easString).not.toMatch(/upstash/i);
      expect(easString).not.toMatch(/secret/i);
      expect(easString).not.toMatch(/token/i);
    });
  });

  describe('2. Sandbox 環境隔離與 URL 解析防禦', () => {
    test('合規 Sandbox 環境：同時設定旗標與官方指定 Sandbox URL 時，允許進入測試', async () => {
      process.env.EXPO_PUBLIC_ENABLE_IAP_SANDBOX = 'true';
      process.env.EXPO_PUBLIC_BACKEND_URL =
        'https://exam-plan-ai-backend-sandbox.vercel.app';

      expect(isIapSandboxConfigured()).toBe(true);
      expect(isSandboxEnvironmentValid()).toBe(true);
      expect(isSandboxIapAllowed()).toBe(true);

      const resolvedUrl = await getBackendUrlFromStorage();
      expect(resolvedUrl).toBe(SANDBOX_BACKEND_URL);
    });

    test('異常 Sandbox 環境（缺少 URL）：宣告 Sandbox 但未給 URL 時，安全阻斷且絕不回退正式後端', async () => {
      process.env.EXPO_PUBLIC_ENABLE_IAP_SANDBOX = 'true';
      delete process.env.EXPO_PUBLIC_BACKEND_URL;

      expect(isIapSandboxConfigured()).toBe(true);
      expect(isSandboxEnvironmentValid()).toBe(false);
      expect(isSandboxIapAllowed()).toBe(false);

      const resolvedUrl = await getBackendUrlFromStorage();
      expect(resolvedUrl).toBeNull();
      expect(resolvedUrl).not.toBe(DEFAULT_BACKEND_URL);
    });

    test('異常 Sandbox 環境（指向正式後端）：宣告 Sandbox 但誤填正式後端時，安全阻斷', async () => {
      process.env.EXPO_PUBLIC_ENABLE_IAP_SANDBOX = 'true';
      process.env.EXPO_PUBLIC_BACKEND_URL =
        'https://exam-plan-ai-backend-coral.vercel.app';

      expect(isIapSandboxConfigured()).toBe(true);
      expect(isSandboxEnvironmentValid()).toBe(false);
      expect(isSandboxIapAllowed()).toBe(false);

      const resolvedUrl = await getBackendUrlFromStorage();
      expect(resolvedUrl).toBeNull();
      expect(resolvedUrl).not.toBe(DEFAULT_BACKEND_URL);
    });

    test('異常 Sandbox 環境（指向未知網址）：宣告 Sandbox 但填入未知網址時，安全阻斷', async () => {
      process.env.EXPO_PUBLIC_ENABLE_IAP_SANDBOX = 'true';
      process.env.EXPO_PUBLIC_BACKEND_URL = 'https://malicious-server.example.com';

      expect(isIapSandboxConfigured()).toBe(true);
      expect(isSandboxEnvironmentValid()).toBe(false);
      expect(isSandboxIapAllowed()).toBe(false);

      const resolvedUrl = await getBackendUrlFromStorage();
      expect(resolvedUrl).toBeNull();
    });

    test('正式版環境（無 Sandbox 旗標）：正確解析正式環境後端且不開放 Sandbox 內購', async () => {
      delete process.env.EXPO_PUBLIC_ENABLE_IAP_SANDBOX;
      process.env.EXPO_PUBLIC_BACKEND_URL =
        'https://exam-plan-ai-backend-coral.vercel.app';

      expect(isIapSandboxConfigured()).toBe(false);
      expect(isSandboxEnvironmentValid()).toBe(false);
      expect(isSandboxIapAllowed()).toBe(false);

      const resolvedUrl = await getBackendUrlFromStorage();
      expect(resolvedUrl).toBe(DEFAULT_BACKEND_URL);
    });

    test('本機 AsyncStorage 殘留舊網址時，會被自動清除且絕不蓋過 Sandbox 指定網址', async () => {
      await AsyncStorage.setItem(
        '@exam_plan_ai:backend_url',
        'https://legacy-custom-url.com',
      );

      process.env.EXPO_PUBLIC_ENABLE_IAP_SANDBOX = 'true';
      process.env.EXPO_PUBLIC_BACKEND_URL =
        'https://exam-plan-ai-backend-sandbox.vercel.app';

      const resolvedUrl = await getBackendUrlFromStorage();
      expect(resolvedUrl).toBe(SANDBOX_BACKEND_URL);

      const savedAfter = await AsyncStorage.getItem('@exam_plan_ai:backend_url');
      expect(savedAfter).toBeNull();
    });
  });

  describe('3. AI 建議與交易驗證端點一致性測試', () => {
    test('合規 Sandbox 環境下，AI 與 StoreKit 驗證共用完全相同的 Sandbox URL', async () => {
      process.env.EXPO_PUBLIC_ENABLE_IAP_SANDBOX = 'true';
      process.env.EXPO_PUBLIC_BACKEND_URL =
        'https://exam-plan-ai-backend-sandbox.vercel.app';

      const backendUrl = await getBackendUrlFromStorage();
      expect(backendUrl).toBe(SANDBOX_BACKEND_URL);

      // 驗證 AI 服務建構之 URL
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          source: 'openai_ai',
          advice: {
            summary: '測試建議',
            focusSubjects: [],
            actionableTips: [],
            estimatedFeasibility: '良好',
          },
        }),
      });
      global.fetch = mockFetch as any;

      await fetchFromBackendApi(
        {
          examName: '測試考試',
          examDate: '2026-11-01',
          dailyAvailableMinutes: 60,
          subjects: [],
        },
        backendUrl!,
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://exam-plan-ai-backend-sandbox.vercel.app/api/study-advice',
        expect.anything(),
      );

      // 驗證 StoreKit 交易驗證器建構之 URL
      const validator = new ServerSideTransactionValidator();
      await validator.validate({
        productId: STOREKIT_PRODUCT_IDS.MONTHLY,
        signedTransaction: 'mock_sandbox_jws_payload',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://exam-plan-ai-backend-sandbox.vercel.app/api/verify-transaction',
        expect.anything(),
      );
    });

    test('Sandbox 環境不合規時，交易驗證器安全阻斷且絕不發送網路請求至正式後端', async () => {
      process.env.EXPO_PUBLIC_ENABLE_IAP_SANDBOX = 'true';
      process.env.EXPO_PUBLIC_BACKEND_URL = 'https://wrong-domain.com';

      const mockFetch = jest.fn();
      global.fetch = mockFetch as any;

      const validator = new ServerSideTransactionValidator();
      const res = await validator.validate({
        productId: STOREKIT_PRODUCT_IDS.MONTHLY,
        signedTransaction: 'mock_sandbox_jws_payload',
      });

      expect(res.valid).toBe(false);
      expect(res.reason).toContain('Sandbox 測試環境後端網址設定不合規');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('4. Apple 內購安全規則驗證', () => {
    test('環境旗標不能直接賦予 Pro 或 Lifetime 權限，交易無 JWS 時在正式/打包模式下必須被拒絕', async () => {
      process.env.EXPO_PUBLIC_ENABLE_IAP_SANDBOX = 'true';
      process.env.EXPO_PUBLIC_BACKEND_URL =
        'https://exam-plan-ai-backend-sandbox.vercel.app';

      // 模擬非開發模式 (__DEV__ = false)
      const originalDev = (global as any).__DEV__;
      (global as any).__DEV__ = false;

      try {
        const validator = new ServerSideTransactionValidator();
        // 傳入無 signedTransaction 的購買資訊
        const result = await validator.validate({
          productId: STOREKIT_PRODUCT_IDS.MONTHLY,
        });

        expect(result.valid).toBe(false);
        expect(result.reason).toContain('Apple 交易憑證遺漏必要之 JWS 數位簽署');
      } finally {
        (global as any).__DEV__ = originalDev;
      }
    });
  });
});
