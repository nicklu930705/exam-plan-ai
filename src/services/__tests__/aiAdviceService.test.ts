import {
  generateLocalRuleAdvice,
  requestAiStudyAdvice,
  type StudyAdviceRequest,
} from '../aiAdviceService';
import type { AiUsageRecord, UserSubscription } from '../../subscription/types';

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);


describe('aiAdviceService', () => {
  const sampleRequest: StudyAdviceRequest = {
    examName: '多益英語測驗',
    examDate: '2026-11-12',
    dailyAvailableMinutes: 90,
    intensity: 'normal',
    subjects: [
      { name: '聽力測驗', familiarity: 1 },
      { name: '閱讀測驗', familiarity: 2 },
    ],
    recentCompletionRate: 85,
    behindTasksCount: 0,
  };

  const proSubscription: UserSubscription = {
    plan: 'pro',
    billingCycle: 'monthly',
    status: 'active',
    expiresAt: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
  };

  const freeSubscription: UserSubscription = {
    plan: 'free',
    billingCycle: 'none',
    status: 'none',
  };

  const defaultUsage: AiUsageRecord = {
    monthlyCalls: 5,
    lastResetMonth: new Date().toISOString().slice(0, 7),
  };

  describe('generateLocalRuleAdvice', () => {
    it('應正確產生弱科聚焦與行動建議', () => {
      const advice = generateLocalRuleAdvice(sampleRequest);
      expect(advice.summary).toContain('多益英語測驗');
      expect(advice.focusSubjects).toContain('聽力測驗');
      expect(advice.actionableTips.length).toBeGreaterThanOrEqual(2);
      expect(advice.estimatedFeasibility.length).toBeGreaterThan(0);
    });

    it('有落後任務時應包含智慧重新排程之提示', () => {
      const advice = generateLocalRuleAdvice({
        ...sampleRequest,
        behindTasksCount: 3,
      });
      expect(advice.summary).toContain('3 項任務進度落後');
      expect(advice.actionableTips.some((t) => t.includes('智慧重新排程'))).toBe(true);
    });
  });

  describe('requestAiStudyAdvice 權限與額度測試', () => {
    it('免費版使用者應優雅降級為本機排程演算法，不發送外部請求', async () => {
      const result = await requestAiStudyAdvice({
        request: sampleRequest,
        subscription: freeSubscription,
        aiUsage: defaultUsage,
        customBackendUrl: 'https://test-api.example.com',
      });

      expect(result.success).toBe(true);
      expect(result.source).toBe('fallback_rule_engine');
      expect(result.note).toContain('免費版');
      expect(result.advice?.summary).toBeDefined();
    });

    it('Pro 會員額度用盡時應降級為本機演算法', async () => {
      const exceededUsage: AiUsageRecord = {
        monthlyCalls: 100,
        lastResetMonth: new Date().toISOString().slice(0, 7),
      };

      const result = await requestAiStudyAdvice({
        request: sampleRequest,
        subscription: proSubscription,
        aiUsage: exceededUsage,
        customBackendUrl: 'https://test-api.example.com',
      });

      expect(result.success).toBe(true);
      expect(result.source).toBe('fallback_rule_engine');
      expect(result.quotaStatus?.isExceeded).toBe(true);
      expect(result.note).toContain('上限');
    });

    it('未設定後端伺服器網址時應友善提示並使用本機分析', async () => {
      const result = await requestAiStudyAdvice({
        request: sampleRequest,
        subscription: proSubscription,
        aiUsage: defaultUsage,
        customBackendUrl: null,
      });

      expect(result.success).toBe(true);
      expect(result.source).toBe('fallback_rule_engine');
      expect(result.disclaimer).toContain('尚未設定 AI 雲端伺服器網址');
      expect(result.note).toContain('設定 > AI 雲端服務');
    });

  });

  describe('requestAiStudyAdvice 網路與 API 模擬測試', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('後端成功回傳時應傳回 gemini_ai 建議', async () => {
      const mockGeminiAdvice = {
        summary: '根據目前的進度，建議加強文法題型。',
        focusSubjects: ['閱讀測驗'],
        actionableTips: ['每天固定做 20 題閱讀題', '檢視錯誤題型筆記'],
        estimatedFeasibility: '可行性高，穩健推進即可。',
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          advice: mockGeminiAdvice,
          source: 'gemini_ai',
          disclaimer: 'AI 建議僅供參考',
        }),
      } as any);

      const result = await requestAiStudyAdvice({
        request: sampleRequest,
        subscription: proSubscription,
        aiUsage: defaultUsage,
        customBackendUrl: 'https://my-exam-ai.vercel.app',
      });

      expect(result.success).toBe(true);
      expect(result.source).toBe('gemini_ai');
      expect(result.advice?.summary).toBe(mockGeminiAdvice.summary);
      expect(result.advice?.focusSubjects).toEqual(['閱讀測驗']);
    });

    it('後端回傳 429 配額錯誤時應安全降級為本機演算法', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({
          success: false,
          code: 'QUOTA_EXCEEDED',
          error: 'Gemini API 配額暫時耗盡',
        }),
      } as any);

      const result = await requestAiStudyAdvice({
        request: sampleRequest,
        subscription: proSubscription,
        aiUsage: defaultUsage,
        customBackendUrl: 'https://my-exam-ai.vercel.app',
      });

      expect(result.success).toBe(true);
      expect(result.source).toBe('fallback_rule_engine');
      expect(result.note).toContain('免費額度暫時用盡');
      expect(result.advice?.actionableTips.length).toBeGreaterThan(0);
    });

    it('網路超時或斷線時應自動切換為本機建議且不崩潰', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Network request failed'));

      const result = await requestAiStudyAdvice({
        request: sampleRequest,
        subscription: proSubscription,
        aiUsage: defaultUsage,
        customBackendUrl: 'https://my-exam-ai.vercel.app',
      });

      expect(result.success).toBe(true);
      expect(result.source).toBe('fallback_rule_engine');
      expect(result.note).toContain('AI 伺服器暫時無法回應');
      expect(result.advice?.summary).toBeDefined();
    });

    it('啟用 strictError 時，網路失敗應真實回傳錯誤狀態與說明，不冒充假資料', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Network offline'));

      const result = await requestAiStudyAdvice({
        request: sampleRequest,
        forceAi: true,
        strictError: true,
        customBackendUrl: 'https://my-exam-ai.vercel.app',
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe('network_error');
      expect(result.error).toContain('網路連線失敗');
      expect(result.advice).toBeUndefined();
    });

    it('啟用 strictError 時，配額超額應回傳 quota_exceeded 且不產生本機假建議', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({
          success: false,
          code: 'RATE_LIMIT_EXCEEDED',
          error: '請求過於頻繁，請於 30 秒後再試。',
        }),
      } as any);

      const result = await requestAiStudyAdvice({
        request: sampleRequest,
        forceAi: true,
        strictError: true,
        customBackendUrl: 'https://my-exam-ai.vercel.app',
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe('quota_exceeded');
      expect(result.error).toContain('請求過於頻繁');
      expect(result.advice).toBeUndefined();
    });

    it('forceAi: true 能直接連線呼叫後端 API，取得真實 gemini_ai 建議', async () => {
      const mockGeminiAdvice = {
        summary: '學測衝刺重點在單字文法扎實複習。',
        focusSubjects: ['單字文法'],
        actionableTips: ['每天早晨 40 分鐘背誦核心單字'],
        estimatedFeasibility: '時間充裕，可行性高。',
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          advice: mockGeminiAdvice,
          source: 'gemini_ai',
          disclaimer: 'AI 建議僅供學習策略參考',
        }),
      } as any);

      const result = await requestAiStudyAdvice({
        request: sampleRequest,
        subscription: freeSubscription, // 即使方案為 free
        forceAi: true,
        strictError: true,
        customBackendUrl: 'https://my-exam-ai.vercel.app',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('success');
      expect(result.source).toBe('gemini_ai');
      expect(result.advice?.summary).toBe(mockGeminiAdvice.summary);
    });

    it('後端網址帶有結尾 /api 時應自動規範化為 /api/study-advice，不產生重複 /api', async () => {
      const fetchSpy = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          advice: {
            summary: '好的',
            focusSubjects: [],
            actionableTips: [],
            estimatedFeasibility: '可',
          },
          source: 'gemini_ai',
          disclaimer: '',
        }),
      } as any);
      global.fetch = fetchSpy;

      await requestAiStudyAdvice({
        request: sampleRequest,
        forceAi: true,
        strictError: true,
        customBackendUrl: 'https://my-exam-ai.vercel.app/api/',
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://my-exam-ai.vercel.app/api/study-advice',
        expect.anything(),
      );
    });

    it('後端回傳 504 逾時時應正確辨識為 timeout 狀態並提供繁體中文提示', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 504,
        json: async () => ({
          success: false,
          code: 'GATEWAY_TIMEOUT',
          error: 'AI 服務回應逾時 (超過 12 秒)，請稍後再試。',
        }),
      } as any);

      const result = await requestAiStudyAdvice({
        request: sampleRequest,
        forceAi: true,
        strictError: true,
        customBackendUrl: 'https://my-exam-ai.vercel.app',
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe('timeout');
      expect(result.error).toContain('AI 服務回應逾時');
      expect(result.errorCode).toBe('GATEWAY_TIMEOUT');
    });

    it('後端回傳 503 或模型忙碌時應正確辨識並結束載入', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({
          success: false,
          code: 'SERVICE_UNAVAILABLE',
          error: 'Google Gemini 模型目前忙碌中',
        }),
      } as any);

      const result = await requestAiStudyAdvice({
        request: sampleRequest,
        forceAi: true,
        strictError: true,
        customBackendUrl: 'https://my-exam-ai.vercel.app',
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe('error');
      expect(result.error).toContain('Google Gemini 模型目前忙碌中');
    });
  });
});
