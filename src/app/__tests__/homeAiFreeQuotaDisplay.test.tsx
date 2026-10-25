/**
 * Phase 3.4c-46 永久回歸測試：Free 會員 AI 額度顯示改善與真實狀態測試
 *
 * 核心驗證：
 * 1. Free 歷史建議 + 成功取得真實額度：同時呈現歷史閱讀提示與即時額度。
 * 2. 查詢中狀態：查詢進行中時呈現「額度同步中…」。
 * 3. API 失敗時的狀態：API 失敗且無快取時呈現「目前無法取得額度」，且歷史建議絕不清空或隱藏。
 * 4. 離線時同日快取：API 失敗但有同日有效快取時呈現「上次同步 X/3 次」。
 * 5. 跨日舊額度不得冒充今日額度。
 * 6. Pro 1/15 舊額度不得顯示成 Free 額度。
 * 7. 閱讀歷史建議不發送 POST AI，不扣減額度。
 * 8. 切換考試與冷啟動不會重複產生 AI 建議。
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { createDemoData } from '../../data/demo';
import {
  saveCachedAiAdvice,
  saveLatestQuotaCache,
} from '../../services/aiAdviceCacheService';
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

let mockCurrentToday = '2026-10-25';
jest.mock('../../hooks/useToday', () => ({
  useToday: () => mockCurrentToday,
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const HomeScreen = require('../(tabs)/index').default;

describe('Phase 3.4c-46：Free 會員 AI 額度顯示改善測試套件', () => {
  const examAId = 'exam_test_a';
  const examBId = 'exam_test_b';

  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
    mockCurrentToday = '2026-10-25';

    // 初始化 AppData：設為 Free 會員狀態（模擬 Apple 訂閱過期後降級）
    mockAppData = createDemoData();
    mockAppData.subscription = {
      plan: 'free',
      billingCycle: 'none',
      status: 'none',
      isDevPreview: false,
    };
    mockAppData.exams[0].id = examAId;
    mockAppData.exams[0].name = '軟體架構認證';
    mockAppData.selectedExamId = examAId;
    mockAppData.tasks.forEach((t) => {
      t.examId = examAId;
    });
  });

  it('1. Free 歷史建議 + 成功取得真實額度：卡片同時顯示免費閱讀提示與今日真實額度', async () => {
    // 預先在兩天前儲存 Pro 建議（模擬 Build 8 在 Pro 時期生成的建議）
    await saveCachedAiAdvice({
      examId: examAId,
      date: '2026-10-23',
      tier: 'pro',
      createdAt: '2026-10-23T10:00:00.000Z',
      advice: {
        summary: 'Pro 專屬系統設計架構深層解析',
        focusSubjects: ['系統架構'],
        actionableTips: ['深入實作非同步隊列', '演練分散式交易'],
        estimatedFeasibility: '進度良好',
      },
      source: 'openai_ai',
      quotaSnapshot: {
        usedToday: 1,
        dailyLimit: 15,
        remainingToday: 14,
        resetsAt: '2026-10-24T00:00:00+08:00',
        tier: 'pro',
      },
    });

    // 後端回傳當前真實 Free 額度（0/3 次）
    mockFetchAiQuota.mockResolvedValueOnce({
      usedToday: 0,
      dailyLimit: 3,
      remainingToday: 3,
      resetsAt: '2026-10-26T00:00:00+08:00',
      tier: 'free',
    });

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });
    // 等待背景 fetchAiQuotaFromBackend 完成
    await act(async () => {
      await Promise.resolve();
    });

    const json = JSON.stringify(tree.toJSON());

    // 1. 歷史內容與提示存在
    expect(json).toContain('Pro 專屬系統設計架構深層解析');
    expect(json).toContain('免費版 · 舊內容可免費閱讀（新分析遵守目前免費版會員權益）');

    // 2. 真實額度存在，且標記為免費版 0/3 次
    expect(json).toContain('免費版 · 今日已用 0/3 次（剩餘 3 次 · 每日 00:00 重設）');
    expect(json).not.toContain('1/15'); // 舊 Pro 額度絕不得外洩
    expect(json).not.toContain('✦ Pro 會員 · ');

    // 3. 不扣額、不呼叫付費生成 API
    expect(mockRequestAiStudyAdvice).not.toHaveBeenCalled();
    expect(mockRecordAiUsage).not.toHaveBeenCalled();
  });

  it('2. 查詢中狀態：背景查詢尚未完成時，顯示「額度同步中…」且保留歷史免費閱讀提示', async () => {
    await saveCachedAiAdvice({
      examId: examAId,
      date: '2026-10-23',
      tier: 'pro',
      createdAt: '2026-10-23T10:00:00.000Z',
      advice: {
        summary: '歷史系統架構建議',
        focusSubjects: ['架構'],
        actionableTips: ['演練 CQRS'],
        estimatedFeasibility: '進度良好',
      },
      source: 'openai_ai',
    });

    // 保持 pending 狀態模擬查詢中
    let resolveQuota: (val: any) => void = () => {};
    const pendingPromise = new Promise((resolve) => {
      resolveQuota = resolve;
    });
    mockFetchAiQuota.mockReturnValueOnce(pendingPromise);

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });

    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain('歷史系統架構建議');
    expect(json).toContain('免費版 · 舊內容可免費閱讀（新分析遵守目前免費版會員權益）');
    expect(json).toContain('免費版 · 額度同步中…');

    // 清理 promise 避免掛起
    await act(async () => {
      resolveQuota(null);
    });
  });

  it('3. API 失敗時的狀態：查詢失敗且無快取時顯示「目前無法取得額度」，且歷史 AI 建議依然完整存在', async () => {
    await saveCachedAiAdvice({
      examId: examAId,
      date: '2026-10-23',
      tier: 'pro',
      createdAt: '2026-10-23T10:00:00.000Z',
      advice: {
        summary: '歷史系統架構建議完整內容',
        focusSubjects: ['架構'],
        actionableTips: ['演練分散式快取'],
        estimatedFeasibility: '進度良好',
      },
      source: 'openai_ai',
    });

    // 模擬後端回傳 null 或網路失敗
    mockFetchAiQuota.mockResolvedValueOnce(null);

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const json = JSON.stringify(tree.toJSON());
    // 歷史內容絕不被清除或隱藏
    expect(json).toContain('歷史系統架構建議完整內容');
    expect(json).toContain('免費版 · 舊內容可免費閱讀（新分析遵守目前免費版會員權益）');
    expect(json).toContain('免費版 · 目前無法取得額度');
  });

  it('4. 離線且有同日有效快取：查詢失敗但有同日快取時顯示「上次同步 X/3 次」', async () => {
    await saveCachedAiAdvice({
      examId: examAId,
      date: '2026-10-23',
      tier: 'pro',
      createdAt: '2026-10-23T10:00:00.000Z',
      advice: {
        summary: '歷史系統架構建議',
        focusSubjects: ['架構'],
        actionableTips: ['演練分散式快取'],
        estimatedFeasibility: '進度良好',
      },
      source: 'openai_ai',
    });

    // 今日稍早曾成功同步過 Free 額度（已用 1 次）
    await saveLatestQuotaCache(
      {
        usedToday: 1,
        dailyLimit: 3,
        remainingToday: 2,
        resetsAt: '2026-10-26T00:00:00+08:00',
        tier: 'free',
      },
      mockCurrentToday,
    );

    // 模擬當前離線
    mockFetchAiQuota.mockRejectedValueOnce(new Error('Network offline'));

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain('歷史系統架構建議');
    expect(json).toContain('免費版 · 舊內容可免費閱讀（新分析遵守目前免費版會員權益）');
    expect(json).toContain('免費版 · 上次同步 1/3 次（剩餘 2 次）');
  });

  it('5. Pro 1/15 舊額度在 Pro 到期降級 Free 後，絕對不得顯示成 Free 額度', async () => {
    // 儲存 Pro 時期的舊快取，帶有 1/15 額度快照
    await saveCachedAiAdvice({
      examId: examAId,
      date: '2026-10-23',
      tier: 'pro',
      createdAt: '2026-10-23T10:00:00.000Z',
      advice: {
        summary: 'Pro 專屬建議',
        focusSubjects: ['架構'],
        actionableTips: ['要點一'],
        estimatedFeasibility: '進度良好',
      },
      source: 'openai_ai',
      quotaSnapshot: {
        usedToday: 1,
        dailyLimit: 15,
        remainingToday: 14,
        resetsAt: '2026-10-24T00:00:00+08:00',
        tier: 'pro',
      },
    });

    // 離線且後端未回應
    mockFetchAiQuota.mockResolvedValueOnce(null);

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const json = JSON.stringify(tree.toJSON());
    // 絕不能把 15 次當作 Free 額度
    expect(json).not.toContain('1/15 次');
    expect(json).not.toContain('剩餘 14 次');
    expect(json).not.toContain('✦ Pro 會員');
    expect(json).toContain('免費版 · 目前無法取得額度');
  });

  it('6. 跨日舊額度不得冒充今日額度', async () => {
    // 存入考試建議
    await saveCachedAiAdvice({
      examId: examAId,
      date: '2026-10-23',
      tier: 'free',
      createdAt: '2026-10-23T10:00:00.000Z',
      advice: {
        summary: '系統架構建議',
        focusSubjects: ['架構'],
        actionableTips: ['要點一'],
        estimatedFeasibility: '進度良好',
      },
      source: 'fallback_rule_engine',
    });

    // 昨天存了 Free 額度（2/3 次）
    await saveLatestQuotaCache(
      {
        usedToday: 2,
        dailyLimit: 3,
        remainingToday: 1,
        resetsAt: '2026-10-25T00:00:00+08:00',
        tier: 'free',
      },
      '2026-10-24', // 昨天
    );

    // 今日離線
    mockFetchAiQuota.mockResolvedValueOnce(null);

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const json = JSON.stringify(tree.toJSON());
    // 昨天的 2/3 次不能被當成今天的額度
    expect(json).not.toContain('2/3 次');
    expect(json).toContain('免費版 · 目前無法取得額度');
  });

  it('7. 冷啟動與切換考試流程：僅讀取本機快取，絕不重複發起 POST AI 請求', async () => {
    const examB = {
      ...mockAppData.exams[0],
      id: examBId,
      name: '考試 B',
    };
    mockAppData.exams = [mockAppData.exams[0], examB];

    await saveCachedAiAdvice({
      examId: examAId,
      date: '2026-10-23',
      tier: 'pro',
      createdAt: '2026-10-23T10:00:00.000Z',
      advice: {
        summary: '考試 A 建議',
        focusSubjects: ['A'],
        actionableTips: ['A tips'],
        estimatedFeasibility: '進度良好',
      },
      source: 'openai_ai',
    });

    await saveCachedAiAdvice({
      examId: examBId,
      date: '2026-10-23',
      tier: 'pro',
      createdAt: '2026-10-23T10:00:00.000Z',
      advice: {
        summary: '考試 B 建議',
        focusSubjects: ['B'],
        actionableTips: ['B tips'],
        estimatedFeasibility: '進度良好',
      },
      source: 'openai_ai',
    });

    mockFetchAiQuota.mockResolvedValue({
      usedToday: 0,
      dailyLimit: 3,
      remainingToday: 3,
      resetsAt: '2026-10-26T00:00:00+08:00',
      tier: 'free',
    });

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockRequestAiStudyAdvice).not.toHaveBeenCalled();
    expect(mockRecordAiUsage).not.toHaveBeenCalled();

    // 切換至考試 B
    mockAppData.selectedExamId = examBId;
    await act(async () => {
      tree.update(<HomeScreen />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // 切換後依然不呼叫生成 API
    expect(mockRequestAiStudyAdvice).not.toHaveBeenCalled();
    expect(mockRecordAiUsage).not.toHaveBeenCalled();
  });

  it('8. 模擬午夜換日（23:59 → 00:00）：跨日後自動使昨日額度失效，並重新向後端取得今日新額度', async () => {
    // 1. 23:59 當時（2026-10-24），快取存有昨日已用 2 次的額度
    await saveCachedAiAdvice({
      examId: examAId,
      date: '2026-10-24',
      tier: 'free',
      createdAt: '2026-10-24T23:50:00.000Z',
      advice: {
        summary: '昨日深夜讀書建議',
        focusSubjects: ['架構'],
        actionableTips: ['睡前回顧'],
        estimatedFeasibility: '進度良好',
      },
      source: 'fallback_rule_engine',
    });

    await saveLatestQuotaCache(
      {
        usedToday: 2,
        dailyLimit: 3,
        remainingToday: 1,
        resetsAt: '2026-10-25T00:00:00+08:00',
        tier: 'free',
      },
      '2026-10-24',
    );

    // 2. 換日到 00:00（2026-10-25），後端回傳全新一天的 0/3 次額度
    mockCurrentToday = '2026-10-25';
    mockFetchAiQuota.mockResolvedValueOnce({
      usedToday: 0,
      dailyLimit: 3,
      remainingToday: 3,
      resetsAt: '2026-10-26T00:00:00+08:00',
      tier: 'free',
    });

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const json = JSON.stringify(tree.toJSON());
    // 絕不出現昨日 2/3 次
    expect(json).not.toContain('2/3 次');
    // 正確顯示今日重設後的 0/3 次
    expect(json).toContain('免費版 · 今日已用 0/3 次（剩餘 3 次 · 每日 00:00 重設）');
  });

  it('9. 快速切換 A、B 考試：前一場考試的慢速非同步額度回應被 isCancelled 安全阻斷，不得污染新考試', async () => {
    const examB = {
      ...mockAppData.exams[0],
      id: examBId,
      name: '考試 B',
    };
    mockAppData.exams = [mockAppData.exams[0], examB];

    await saveCachedAiAdvice({
      examId: examAId,
      date: '2026-10-25',
      tier: 'free',
      createdAt: '2026-10-25T10:00:00.000Z',
      advice: {
        summary: '考試 A 專屬建議',
        focusSubjects: ['A'],
        actionableTips: ['A tips'],
        estimatedFeasibility: '進度良好',
      },
      source: 'fallback_rule_engine',
    });

    await saveCachedAiAdvice({
      examId: examBId,
      date: '2026-10-25',
      tier: 'free',
      createdAt: '2026-10-25T10:00:00.000Z',
      advice: {
        summary: '考試 B 專屬建議',
        focusSubjects: ['B'],
        actionableTips: ['B tips'],
        estimatedFeasibility: '進度良好',
      },
      source: 'fallback_rule_engine',
    });

    // 模擬考試 A 的請求非常慢
    let resolveExamAQuota: (val: any) => void = () => {};
    const slowExamAPromise = new Promise((resolve) => {
      resolveExamAQuota = resolve;
    });

    mockFetchAiQuota.mockReturnValueOnce(slowExamAPromise);

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });

    // 尚未等考試 A 完成，使用者極速切換到考試 B
    mockFetchAiQuota.mockResolvedValueOnce({
      usedToday: 1,
      dailyLimit: 3,
      remainingToday: 2,
      resetsAt: '2026-10-26T00:00:00+08:00',
      tier: 'free',
    });

    mockAppData.selectedExamId = examBId;
    await act(async () => {
      tree.update(<HomeScreen />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // 此時考試 A 的慢速回應才返回
    await act(async () => {
      resolveExamAQuota({
        usedToday: 0,
        dailyLimit: 3,
        remainingToday: 3,
        resetsAt: '2026-10-26T00:00:00+08:00',
        tier: 'free',
      });
    });

    const json = JSON.stringify(tree.toJSON());
    // 當前畫面為考試 B，內容絕不被考試 A 污染
    expect(json).toContain('考試 B 專屬建議');
    expect(json).not.toContain('考試 A 專屬建議');
    // 額度為考試 B 完成時之狀態
    expect(json).toContain('免費版 · 今日已用 1/3 次（剩餘 2 次 · 每日 00:00 重設）');
  });

  it('10. 模擬離線與重新連線：從「上次同步」狀態平滑重整為即時同步狀態', async () => {
    await saveCachedAiAdvice({
      examId: examAId,
      date: '2026-10-25',
      tier: 'free',
      createdAt: '2026-10-25T10:00:00.000Z',
      advice: {
        summary: '離線恢復建議',
        focusSubjects: ['架構'],
        actionableTips: ['演練微服務'],
        estimatedFeasibility: '進度良好',
      },
      source: 'fallback_rule_engine',
    });

    // 1. 本機快取有同日紀錄（已用 1 次）
    await saveLatestQuotaCache(
      {
        usedToday: 1,
        dailyLimit: 3,
        remainingToday: 2,
        resetsAt: '2026-10-26T00:00:00+08:00',
        tier: 'free',
      },
      '2026-10-25',
    );

    // 2. 離線啟動，後端請求失敗
    mockFetchAiQuota.mockRejectedValueOnce(new Error('Network offline'));

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    let json = JSON.stringify(tree.toJSON());
    expect(json).toContain('免費版 · 上次同步 1/3 次（剩餘 2 次）');

    // 3. 恢復連線，使用者重新打開 App（回傳已用 2 次）
    mockFetchAiQuota.mockResolvedValueOnce({
      usedToday: 2,
      dailyLimit: 3,
      remainingToday: 1,
      resetsAt: '2026-10-26T00:00:00+08:00',
      tier: 'free',
    });

    let reloadedTree!: renderer.ReactTestRenderer;
    await act(async () => {
      reloadedTree = renderer.create(<HomeScreen />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    json = JSON.stringify(reloadedTree.toJSON());
    // 正確更新為即時同步的 2/3 次
    expect(json).toContain('免費版 · 今日已用 2/3 次（剩餘 1 次 · 每日 00:00 重設）');
  });
});
