/**
 * Phase 3.4c-37B 永久回歸測試：首頁 AI 深度建議跨日持續顯示、歷史提示與隔離防護
 *
 * 覆蓋真實 HomeScreen 完整快取恢復、跨日、多考試、會員方案隔離與失敗防護流程。
 * 絕不發送真實付費 AI 請求。
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { createDemoData } from '../../data/demo';
import {
  saveCachedAiAdvice,
  getCachedAiAdvice,
  AI_ADVICE_CACHE_STORAGE_KEY,
  type StoredAiAdviceCache,
} from '../../services/aiAdviceCacheService';
import type { AiAdviceServiceResult } from '../../services/aiAdviceService';
import type { AppData } from '../../types/models';

// Mocks
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

const mockRequestAiStudyAdvice = jest.fn();
const mockFetchAiQuota = jest.fn();
const mockLogDiagnostic = jest.fn();

jest.mock('../../services/aiAdviceService', () => ({
  logDiagnostic: (...args: unknown[]) => mockLogDiagnostic(...args),
  requestAiStudyAdvice: (...args: unknown[]) => mockRequestAiStudyAdvice(...args),
  fetchAiQuotaFromBackend: (...args: unknown[]) => mockFetchAiQuota(...args),
}));

let mockAppData: AppData;
const mockRecordAiUsage = jest.fn();

jest.mock('../../store/AppStore', () => ({
  useAppStore: () => ({
    data: mockAppData,
    setTaskStatus: jest.fn(),
    setSelectedExamId: jest.fn(),
    loadDemo: jest.fn(),
    recordAiUsage: mockRecordAiUsage,
  }),
}));

let mockCurrentToday = '2026-10-24';
jest.mock('../../hooks/useToday', () => ({
  useToday: () => mockCurrentToday,
}));
jest.mock('../../hooks/useStudyTimer', () => ({
  useStudyTimer: () => ({ activeTimer: null, formattedTime: '00:00', startTimer: jest.fn() }),
}));

// eslint-disable-next-line import/first
import HomeScreen from '../(tabs)/index';

describe('Phase 3.4c-37B 首頁 AI 歷史建議跨日顯示與隔離回歸測試', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();

    mockCurrentToday = '2026-10-24';
    mockAppData = createDemoData();
    mockAppData.subscription = {
      plan: 'pro',
      billingCycle: 'monthly',
      status: 'active',
      expiresAt: '2026-11-24T00:00:00.000Z',
      isDevPreview: false,
    };
    mockAppData.exams[0].id = 'exam_arch_test';
    mockAppData.exams[0].name = '[TEST] 2026 軟體架構核心認證';
    mockAppData.selectedExamId = 'exam_arch_test';
    mockAppData.tasks.forEach((t) => {
      t.examId = 'exam_arch_test';
    });

    mockFetchAiQuota.mockResolvedValue({
      usedToday: 1,
      dailyLimit: 15,
      remainingToday: 14,
      resetsAt: '2026-10-25T00:00:00+08:00',
      tier: 'pro',
    });
  });

  it('1. 同日建議：當天產生的建議正常顯示為「✦ AI 讀書教練深度建議」，不標記為歷史建議', async () => {
    await saveCachedAiAdvice({
      examId: 'exam_arch_test',
      date: '2026-10-24',
      tier: 'pro',
      advice: {
        summary: '今日最新架構策略',
        focusSubjects: ['系統架構'],
        actionableTips: ['深入了解分散式快取'],
        estimatedFeasibility: '可行性高',
      },
      source: 'openai_ai',
      createdAt: '2026-10-24T09:00:00.000Z',
    });

    let tree: any;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    const str = JSON.stringify(tree.toJSON());
    expect(str).toContain('今日最新架構策略');
    expect(str).toContain('✦ AI 讀書教練深度建議');
    expect(str).not.toContain('✦ 歷史 AI 讀書建議');
    expect(str).not.toContain('此為前次分析建議');
    // 冷啟動不調用付費 AI
    expect(mockRequestAiStudyAdvice).not.toHaveBeenCalled();
    expect(mockRecordAiUsage).not.toHaveBeenCalled();
  });

  it('2. 跨日一天與兩天（Build 8 於 10/22 產生）：在 10/24 冷啟動仍可顯示歷史建議並清楚標記', async () => {
    // 模擬 Build 8 於 2026-10-22 存入快取
    await saveCachedAiAdvice({
      examId: 'exam_arch_test',
      date: '2026-10-22',
      tier: 'pro',
      advice: {
        summary: '10/22 生成之架構建議',
        focusSubjects: ['分散式系統'],
        actionableTips: ['閱讀 CAP 定理'],
        estimatedFeasibility: '進度良好',
      },
      source: 'openai_ai',
      createdAt: '2026-10-22T14:30:00.000Z',
    });

    let tree: any;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    const str = JSON.stringify(tree.toJSON());
    expect(str).toContain('10/22 生成之架構建議');
    expect(str).toContain('✦ 歷史 AI 讀書建議');
    expect(str).toContain('此為前次分析建議（已跨日）');
    expect(str).toContain('前次分析：');
    // 確保未呼叫付費推論
    expect(mockRequestAiStudyAdvice).not.toHaveBeenCalled();
  });

  it('3. 超出 7 天保留期：舊建議依既有清理策略自動過期，首頁不顯示歷史建議卡片', async () => {
    const eightDaysAgoIso = new Date(Date.now() - 8 * 86400 * 1000).toISOString();
    await saveCachedAiAdvice({
      examId: 'exam_arch_test',
      date: '2026-10-10',
      tier: 'pro',
      advice: {
        summary: '過舊的建議',
        focusSubjects: ['舊科目'],
        actionableTips: ['舊提示'],
        estimatedFeasibility: '低',
      },
      source: 'openai_ai',
      createdAt: eightDaysAgoIso,
    });

    let tree: any;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    const str = JSON.stringify(tree.toJSON());
    expect(str).not.toContain('過舊的建議');
    expect(str).toContain('取得 AI 讀書教練建議');
  });

  it('4. 多考試隔離：考試 A 的歷史建議絕不會顯示在考試 B 的首頁畫面上', async () => {
    // 建立考試 A 與考試 B 的歷史快取
    await saveCachedAiAdvice({
      examId: 'exam_arch_test',
      date: '2026-10-22',
      tier: 'pro',
      advice: {
        summary: '考試 A 專屬建議',
        focusSubjects: ['架構科目'],
        actionableTips: ['提示 A'],
        estimatedFeasibility: '高',
      },
      source: 'openai_ai',
      createdAt: '2026-10-22T10:00:00.000Z',
    });

    await saveCachedAiAdvice({
      examId: 'exam_toeic',
      date: '2026-10-22',
      tier: 'pro',
      advice: {
        summary: '考試 B 多益聽力建議',
        focusSubjects: ['多益聽力'],
        actionableTips: ['提示 B'],
        estimatedFeasibility: '高',
      },
      source: 'openai_ai',
      createdAt: '2026-10-22T11:00:00.000Z',
    });

    // 目前選取 exam_arch_test
    let tree: any;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    const str = JSON.stringify(tree.toJSON());
    expect(str).toContain('考試 A 專屬建議');
    expect(str).not.toContain('考試 B 多益聽力建議');
  });

  it('5. 會員層級變更隔離：用戶由 Pro 降為 Free 時，不得呈現不符合權限之 Pro 歷史建議', async () => {
    await saveCachedAiAdvice({
      examId: 'exam_arch_test',
      date: '2026-10-22',
      tier: 'pro',
      advice: {
        summary: 'Pro 專屬深度建議',
        focusSubjects: ['高級架構'],
        actionableTips: ['Pro 提示'],
        estimatedFeasibility: '高',
      },
      source: 'openai_ai',
      createdAt: '2026-10-22T10:00:00.000Z',
    });

    // 用戶降為 Free
    mockAppData.subscription = {
      plan: 'free',
      billingCycle: 'none',
      status: 'none',
      isDevPreview: false,
    };

    let tree: any;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    const str = JSON.stringify(tree.toJSON());
    expect(str).not.toContain('Pro 專屬深度建議');
    expect(str).toContain('取得 AI 讀書教練建議');
  });

  it('6. 手動重新產生成功：歷史內容即時更新為最新建議，且標記轉為非歷史', async () => {
    // 預先載入歷史建議
    await saveCachedAiAdvice({
      examId: 'exam_arch_test',
      date: '2026-10-22',
      tier: 'pro',
      advice: {
        summary: '前次歷史建議',
        focusSubjects: ['歷史科目'],
        actionableTips: ['歷史提示'],
        estimatedFeasibility: '普通',
      },
      source: 'openai_ai',
      createdAt: '2026-10-22T10:00:00.000Z',
    });

    const freshResult: AiAdviceServiceResult = {
      success: true,
      status: 'success',
      source: 'openai_ai',
      advice: {
        summary: '10/24 全新即時深度分析',
        focusSubjects: ['微服務架構'],
        actionableTips: ['今日最新行動建議'],
        estimatedFeasibility: '極佳',
      },
      disclaimer: 'AI 建議僅供參考',
      quota: {
        usedToday: 2,
        dailyLimit: 15,
        remainingToday: 13,
        resetsAt: '2026-10-25T00:00:00+08:00',
        tier: 'pro',
      },
    };
    mockRequestAiStudyAdvice.mockResolvedValue(freshResult);

    let tree: any;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    // 觸發重新整理按鈕
    const refreshButtons = tree.root.findAll(
      (node: any) =>
        node.props?.accessibilityRole === 'button' &&
        node.props?.accessibilityLabel === '重新取得 AI 建議（將消耗 1 次本日配額）',
    );
    expect(refreshButtons.length).toBeGreaterThan(0);

    await act(async () => {
      refreshButtons[0].props.onPress();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    const str = JSON.stringify(tree.toJSON());
    expect(str).toContain('10/24 全新即時深度分析');
    expect(str).toContain('✦ AI 讀書教練深度建議');
    expect(str).not.toContain('✦ 歷史 AI 讀書建議');
    expect(str).not.toContain('此為前次分析建議');
    // 驗證消耗額度計數
    expect(mockRecordAiUsage).toHaveBeenCalledTimes(1);

    // 驗證 AsyncStorage 已更新為今日最新
    const raw = await AsyncStorage.getItem(AI_ADVICE_CACHE_STORAGE_KEY);
    const parsed: StoredAiAdviceCache = JSON.parse(raw!);
    expect(parsed.items['exam_arch_test'].date).toBe('2026-10-24');
    expect(parsed.items['exam_arch_test'].advice.summary).toBe('10/24 全新即時深度分析');
  });

  it('7. 重新產生失敗時：不得刪除 AsyncStorage 中原本可讀取的歷史建議', async () => {
    await saveCachedAiAdvice({
      examId: 'exam_arch_test',
      date: '2026-10-22',
      tier: 'pro',
      advice: {
        summary: '原本可讀取的歷史建議',
        focusSubjects: ['架構科目'],
        actionableTips: ['重要提示'],
        estimatedFeasibility: '良好',
      },
      source: 'openai_ai',
      createdAt: '2026-10-22T10:00:00.000Z',
    });

    mockRequestAiStudyAdvice.mockRejectedValue(new Error('網路斷線模擬'));

    let tree: any;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    // 觸發重新整理
    const refreshButtons = tree.root.findAll(
      (node: any) =>
        node.props?.accessibilityRole === 'button' &&
        node.props?.accessibilityLabel === '重新取得 AI 建議（將消耗 1 次本日配額）',
    );
    await act(async () => {
      refreshButtons[0].props.onPress();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    // 檢查 AsyncStorage，歷史建議依然完整保留未被破壞或刪除
    const raw = await AsyncStorage.getItem(AI_ADVICE_CACHE_STORAGE_KEY);
    const parsed: StoredAiAdviceCache = JSON.parse(raw!);
    expect(parsed.items['exam_arch_test']).toBeDefined();
    expect(parsed.items['exam_arch_test'].advice.summary).toBe('原本可讀取的歷史建議');
    expect(parsed.items['exam_arch_test'].date).toBe('2026-10-22');
  });

  it('8. 相容性：驗證 Build 8 原生 JSON 序列化快取直接載入時相容恢復', async () => {
    // 構造 Build 8 完全原生之 AsyncStorage JSON 字串
    const build8StoragePayload = JSON.stringify({
      version: 1,
      items: {
        exam_arch_test: {
          examId: 'exam_arch_test',
          date: '2026-10-22',
          tier: 'pro',
          advice: {
            summary: 'Build 8 產生物件',
            focusSubjects: ['系統架構重點'],
            actionableTips: ['行動重點一', '行動重點二'],
            estimatedFeasibility: '極佳',
          },
          source: 'openai_ai',
          disclaimer: 'AI 建議僅供學習策略與心理激勵參考。',
          createdAt: '2026-10-22T08:30:00.000Z',
          quota: {
            usedToday: 1,
            dailyLimit: 15,
            remainingToday: 14,
            resetsAt: '2026-10-23T00:00:00+08:00',
            tier: 'pro',
          },
          taskSnapshot: {
            totalTasks: 8,
            completedTasks: 3,
            completionRate: 38,
          },
        },
      },
      updatedAt: '2026-10-22T08:30:00.000Z',
    });

    await AsyncStorage.setItem(AI_ADVICE_CACHE_STORAGE_KEY, build8StoragePayload);

    // 直接呼叫 getCachedAiAdvice
    const cacheResult = await getCachedAiAdvice('exam_arch_test', '2026-10-24', 'pro');
    expect(cacheResult.cachedAdvice).not.toBeNull();
    expect(cacheResult.cachedAdvice?.advice.summary).toBe('Build 8 產生物件');
    expect(cacheResult.isHistorical).toBe(true);

    // 透過 HomeScreen 渲染
    let tree: any;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    const str = JSON.stringify(tree.toJSON());
    expect(str).toContain('Build 8 產生物件');
    expect(str).toContain('✦ 歷史 AI 讀書建議');
    expect(str).toContain('此為前次分析建議（已跨日');
  });
});
