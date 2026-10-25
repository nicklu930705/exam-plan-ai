import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  clearAllAiAdviceCache,
  createTaskProgressSnapshot,
  getCachedAiAdvice,
  getLatestQuotaCache,
  isProgressChanged,
  removeCachedAiAdviceForExam,
  saveCachedAiAdvice,
  saveLatestQuotaCache,
  type CachedAiAdviceItem,
  type TaskProgressSnapshot,
} from '../aiAdviceCacheService';
import { fetchAiQuotaFromBackend, type QuotaInfo, type StructuredAdvice } from '../aiAdviceService';

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

describe('aiAdviceCacheService', () => {
  const today = '2026-10-22';
  const yesterday = '2026-10-21';

  const sampleAdvice: StructuredAdvice = {
    summary: '多益衝刺計畫：聚焦聽力弱項',
    focusSubjects: ['聽力測驗'],
    actionableTips: ['每天練習聽力 30 分鐘', '檢討錯題筆記'],
    estimatedFeasibility: '進度良好，可行性高',
  };

  const sampleQuota: QuotaInfo = {
    usedToday: 1,
    dailyLimit: 15,
    remainingToday: 14,
    resetsAt: '2026-10-23T00:00:00+08:00',
    tier: 'pro',
  };

  const sampleSnapshot: TaskProgressSnapshot = {
    totalTasks: 10,
    completedTasks: 4,
    completionRate: 40,
  };

  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
  });

  describe('快取存取與基本功能', () => {
    it('應成功儲存並讀取符合當日與方案之 AI 建議', async () => {
      const item: CachedAiAdviceItem = {
        examId: 'exam-1',
        date: today,
        tier: 'pro',
        advice: sampleAdvice,
        source: 'openai_ai',
        disclaimer: 'AI 建議僅供參考',
        createdAt: '2026-10-22T08:30:00.000Z',
        quota: sampleQuota,
        taskSnapshot: sampleSnapshot,
      };

      const saved = await saveCachedAiAdvice(item);
      expect(saved).toBe(true);

      const res = await getCachedAiAdvice('exam-1', today, 'pro');
      expect(res.item).not.toBeNull();
      expect(res.cachedAdvice).not.toBeNull();
      expect(res.item?.advice.summary).toBe(sampleAdvice.summary);
      expect(res.item?.quota?.usedToday).toBe(1);
      expect(res.item?.quota?.remainingToday).toBe(14);
      expect(res.item?.taskSnapshot?.completedTasks).toBe(4);
      expect(res.isExpiredDay).toBe(false);
      expect(res.isTierMismatch).toBe(false);
    });

    it('跨日（如前一天、前兩天）在 7 天保留期內應標記為歷史過期建議，但仍回傳供使用者免費閱讀', async () => {
      await saveCachedAiAdvice({
        examId: 'exam-1',
        date: yesterday,
        tier: 'pro',
        advice: sampleAdvice,
        source: 'openai_ai',
        disclaimer: 'AI 建議僅供參考',
        createdAt: '2026-10-21T08:30:00.000Z',
      });

      const res = await getCachedAiAdvice('exam-1', today, 'pro');
      expect(res.item).not.toBeNull();
      expect(res.cachedAdvice).not.toBeNull();
      expect(res.cachedAdvice?.advice.summary).toBe(sampleAdvice.summary);
      expect(res.isExpiredDay).toBe(true);
      expect(res.isHistorical).toBe(true);
      expect(res.isTierMismatch).toBe(false);
    });

    it('跨日超過 7 天保留期之歷史紀錄應視為失效不予回傳', async () => {
      const eightDaysAgoIso = new Date(Date.now() - 8 * 86400 * 1000).toISOString();
      await saveCachedAiAdvice({
        examId: 'exam-1',
        date: '2026-10-10',
        tier: 'pro',
        advice: sampleAdvice,
        source: 'openai_ai',
        disclaimer: 'AI 建議僅供參考',
        createdAt: eightDaysAgoIso,
      });

      const res = await getCachedAiAdvice('exam-1', today, 'pro');
      expect(res.item).toBeNull();
      expect(res.cachedAdvice).toBeNull();
    });

    it('會員等級變更時（如 Pro 降為 Free）應標記方案不符且不倒灌舊等級建議', async () => {
      await saveCachedAiAdvice({
        examId: 'exam-1',
        date: today,
        tier: 'pro',
        advice: sampleAdvice,
        source: 'openai_ai',
        disclaimer: 'AI 建議僅供參考',
        createdAt: '2026-10-22T08:30:00.000Z',
      });

      const res = await getCachedAiAdvice('exam-1', today, 'free');
      expect(res.item).toBeNull();
      expect(res.cachedAdvice).toBeNull();
      expect(res.isExpiredDay).toBe(false);
      expect(res.isTierMismatch).toBe(true);
    });
  });

  describe('多考試隔離與刪除連帶清理', () => {
    it('不同考試之間的 AI 建議快取應嚴格隔離', async () => {
      const exam1Advice: StructuredAdvice = {
        ...sampleAdvice,
        summary: '考試一建議',
      };
      const exam2Advice: StructuredAdvice = {
        ...sampleAdvice,
        summary: '考試二建議',
      };

      await saveCachedAiAdvice({
        examId: 'exam-1',
        date: today,
        tier: 'pro',
        advice: exam1Advice,
        source: 'openai_ai',
        disclaimer: 'AI 建議僅供參考',
        createdAt: '2026-10-22T09:00:00.000Z',
      });

      await saveCachedAiAdvice({
        examId: 'exam-2',
        date: today,
        tier: 'pro',
        advice: exam2Advice,
        source: 'gemini_ai',
        disclaimer: 'AI 建議僅供參考',
        createdAt: '2026-10-22T10:00:00.000Z',
      });

      const res1 = await getCachedAiAdvice('exam-1', today, 'pro');
      const res2 = await getCachedAiAdvice('exam-2', today, 'pro');
      const res3 = await getCachedAiAdvice('exam-3', today, 'pro');

      expect(res1.item?.advice.summary).toBe('考試一建議');
      expect(res2.item?.advice.summary).toBe('考試二建議');
      expect(res3.item).toBeNull();
    });

    it('刪除考試時應連帶移除該場考試的 AI 建議快取，且不影響其他考試', async () => {
      await saveCachedAiAdvice({
        examId: 'exam-1',
        date: today,
        tier: 'pro',
        advice: sampleAdvice,
        source: 'openai_ai',
        disclaimer: 'AI 建議僅供參考',
        createdAt: '2026-10-22T09:00:00.000Z',
      });

      await saveCachedAiAdvice({
        examId: 'exam-2',
        date: today,
        tier: 'pro',
        advice: sampleAdvice,
        source: 'gemini_ai',
        disclaimer: 'AI 建議僅供參考',
        createdAt: '2026-10-22T10:00:00.000Z',
      });

      await removeCachedAiAdviceForExam('exam-1');

      const res1 = await getCachedAiAdvice('exam-1', today, 'pro');
      const res2 = await getCachedAiAdvice('exam-2', today, 'pro');

      expect(res1.item).toBeNull();
      expect(res2.item).not.toBeNull();
    });

    it('clearAllAiAdviceCache 應清除所有快取資料', async () => {
      await saveCachedAiAdvice({
        examId: 'exam-1',
        date: today,
        tier: 'pro',
        advice: sampleAdvice,
        source: 'openai_ai',
        disclaimer: 'AI 建議僅供參考',
        createdAt: '2026-10-22T09:00:00.000Z',
      });

      await clearAllAiAdviceCache();
      const res = await getCachedAiAdvice('exam-1', today, 'pro');
      expect(res.item).toBeNull();
    });
  });

  describe('進度快照與變動感應', () => {
    it('createTaskProgressSnapshot 應正確計算完成率與任務總數', () => {
      const tasks = [
        { status: 'done' },
        { status: 'done' },
        { status: 'todo' },
        { status: 'todo' },
      ];
      const snapshot = createTaskProgressSnapshot(tasks);
      expect(snapshot.totalTasks).toBe(4);
      expect(snapshot.completedTasks).toBe(2);
      expect(snapshot.completionRate).toBe(50);
    });

    it('isProgressChanged 應於任務完成數或總數變更時回傳 true', () => {
      const original: TaskProgressSnapshot = {
        totalTasks: 4,
        completedTasks: 2,
        completionRate: 50,
      };

      // 進度相同
      expect(isProgressChanged(original, original)).toBe(false);

      // 新增 1 個完成任務
      const updatedDone: TaskProgressSnapshot = {
        totalTasks: 4,
        completedTasks: 3,
        completionRate: 75,
      };
      expect(isProgressChanged(original, updatedDone)).toBe(true);

      // 支援傳入原生任務陣列
      expect(
        isProgressChanged(original, [
          { status: 'done' },
          { status: 'done' },
          { status: 'done' },
          { status: 'todo' },
        ]),
      ).toBe(true);
    });
  });

  describe('配額快取存取', () => {
    it('應能正常儲存與讀取最新每日額度快照', async () => {
      await saveLatestQuotaCache(sampleQuota);
      const cached = await getLatestQuotaCache(today);
      expect(cached).not.toBeNull();
      expect(cached?.usedToday).toBe(1);
      expect(cached?.dailyLimit).toBe(15);
      expect(cached?.remainingToday).toBe(14);
    });
  });

  describe('fetchAiQuotaFromBackend 唯讀額度 API 查詢', () => {
    it('伺服器回傳成功時應解析出正確 QuotaInfo', async () => {
      const mockQuota: QuotaInfo = {
        usedToday: 3,
        dailyLimit: 15,
        remainingToday: 12,
        resetsAt: '2026-10-23T00:00:00+08:00',
        tier: 'pro',
      };

      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, quota: mockQuota }),
      }) as any;

      try {
        const res = await fetchAiQuotaFromBackend('https://test-backend.vercel.app');
        expect(res).not.toBeNull();
        expect(res?.usedToday).toBe(3);
        expect(res?.remainingToday).toBe(12);
        expect(res?.tier).toBe('pro');
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('離線或伺服器錯誤時應安全回傳 null 絕不拋出例外', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockRejectedValue(new Error('Network request failed')) as any;

      try {
        const res = await fetchAiQuotaFromBackend('https://test-backend.vercel.app');
        expect(res).toBeNull();
      } finally {
        global.fetch = originalFetch;
      }
    });
  });
});
