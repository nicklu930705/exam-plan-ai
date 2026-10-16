import { reducer as appReducer, INITIAL_EMPTY_DATA } from '../../store/AppStore';
import { requestAiStudyAdvice, type AiAdviceServiceResult, type StudyAdviceRequest } from '../aiAdviceService';
import type { AppData } from '../../types/models';

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

/**
 * 輔助判斷是否為應扣抵/記錄之正式雲端 AI 呼叫（與首頁、讀書計畫頁、進度頁邏輯完全一致）
 */
function shouldRecordAiUsage(result: AiAdviceServiceResult): boolean {
  return (
    result.success &&
    (result.source === 'openai_ai' || result.source === 'gemini_ai') &&
    !result.cached
  );
}

describe('AI 用量計數邏輯與規則驗證 (AI Usage Tracking)', () => {
  const sampleRequest: StudyAdviceRequest = {
    examName: '學測衝刺',
    examDate: '2026-11-20',
    dailyAvailableMinutes: 120,
    intensity: 'intense',
    subjects: [{ name: '數學', familiarity: 2 }],
  };

  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('AppStore recordAiUsage reducer 行為', () => {
    it('初次或一般成功時，monthlyCalls 應累加 1', () => {
      const state: AppData = {
        ...INITIAL_EMPTY_DATA,
        aiUsage: {
          monthlyCalls: 2,
          lastResetMonth: new Date().toISOString().slice(0, 7),
        },
      };

      const nextState = appReducer(state, { type: 'recordAiUsage' });
      expect(nextState.aiUsage?.monthlyCalls).toBe(3);
      expect(nextState.aiUsage?.lastResetMonth).toBe(new Date().toISOString().slice(0, 7));
    });

    it('跨月時應自動重設為 0 並加 1', () => {
      const state: AppData = {
        ...INITIAL_EMPTY_DATA,
        aiUsage: {
          monthlyCalls: 10,
          lastResetMonth: '2026-01', // 過去月份
        },
      };

      const nextState = appReducer(state, { type: 'recordAiUsage' });
      expect(nextState.aiUsage?.monthlyCalls).toBe(1);
      expect(nextState.aiUsage?.lastResetMonth).toBe(new Date().toISOString().slice(0, 7));
    });
  });

  describe('用量記錄條件判定 (shouldRecordAiUsage)', () => {
    it('1. 成功且為全新 openai_ai 請求時應記錄用量', () => {
      const result: AiAdviceServiceResult = {
        success: true,
        source: 'openai_ai',
        cached: false,
        disclaimer: 'AI 建議僅供參考',
        advice: {
          summary: '建議重點複習',
          focusSubjects: ['數學'],
          actionableTips: ['做題目'],
          estimatedFeasibility: '高',
        },
      };
      expect(shouldRecordAiUsage(result)).toBe(true);
    });

    it('2. 成功且為全新 gemini_ai 請求時應記錄用量', () => {
      const result: AiAdviceServiceResult = {
        success: true,
        source: 'gemini_ai',
        cached: false,
        disclaimer: 'AI 建議僅供參考',
        advice: {
          summary: '建議重點複習',
          focusSubjects: ['數學'],
          actionableTips: ['做題目'],
          estimatedFeasibility: '高',
        },
      };
      expect(shouldRecordAiUsage(result)).toBe(true);
    });

    it('3. 本地規則引擎降級 (fallback_rule_engine) 絕對不計入用量', () => {
      const result: AiAdviceServiceResult = {
        success: true,
        source: 'fallback_rule_engine',
        disclaimer: '由本機排程分析引擎提供',
        advice: {
          summary: '本機分析建議',
          focusSubjects: ['數學'],
          actionableTips: ['規律作息'],
          estimatedFeasibility: '可行',
        },
      };
      expect(shouldRecordAiUsage(result)).toBe(false);
    });

    it('4. HTTP 429 配額用盡或頻率限制失敗時絕對不計入用量', () => {
      const result: AiAdviceServiceResult = {
        success: false,
        source: 'fallback_rule_engine',
        disclaimer: '連線問題或額度用盡時，可隨時使用本機排程演算法進行備考規劃。',
        status: 'quota_exceeded',
        error: '今日免費額度已用完（每日 3 次）。',
      };
      expect(shouldRecordAiUsage(result)).toBe(false);
    });

    it('5. 網路斷線或逾時失敗時絕對不計入用量', () => {
      const result: AiAdviceServiceResult = {
        success: false,
        source: 'fallback_rule_engine',
        disclaimer: '連線問題或額度用盡時，可隨時使用本機排程演算法進行備考規劃。',
        status: 'network_error',
        error: '無法連線至 AI 伺服器',
      };
      expect(shouldRecordAiUsage(result)).toBe(false);
    });

    it('6. 伺服器冪等性快取重試 (cached: true) 絕對不重複計入用量', () => {
      const result: AiAdviceServiceResult = {
        success: true,
        source: 'openai_ai',
        cached: true,
        disclaimer: 'AI 建議僅供參考',
        advice: {
          summary: '快取建議',
          focusSubjects: ['數學'],
          actionableTips: ['重整'],
          estimatedFeasibility: '高',
        },
      };
      expect(shouldRecordAiUsage(result)).toBe(false);
    });
  });

  describe('服務整合測試：requestAiStudyAdvice 回傳 cached 標記', () => {
    it('後端回傳 cached: true 時，客戶端服務能正確透通 cached 旗標', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          cached: true,
          source: 'openai_ai',
          advice: {
            summary: '快取命中建議',
            focusSubjects: ['數學'],
            actionableTips: ['做習題'],
            estimatedFeasibility: '高',
          },
        }),
      } as any);

      const result = await requestAiStudyAdvice({
        request: sampleRequest,
        forceAi: true,
        customBackendUrl: 'https://test-backend.com',
      });

      expect(result.success).toBe(true);
      expect(result.source).toBe('openai_ai');
      expect(result.cached).toBe(true);
      expect(shouldRecordAiUsage(result)).toBe(false);
    });

    it('後端回傳全新 openai_ai 且 cached: false 時，客戶端能識別為全新請求', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          cached: false,
          source: 'openai_ai',
          advice: {
            summary: '全新 AI 建議',
            focusSubjects: ['數學'],
            actionableTips: ['做習題'],
            estimatedFeasibility: '高',
          },
        }),
      } as any);

      const result = await requestAiStudyAdvice({
        request: sampleRequest,
        forceAi: true,
        customBackendUrl: 'https://test-backend.com',
      });

      expect(result.success).toBe(true);
      expect(result.source).toBe('openai_ai');
      expect(result.cached).toBe(false);
      expect(shouldRecordAiUsage(result)).toBe(true);
    });
  });
});
