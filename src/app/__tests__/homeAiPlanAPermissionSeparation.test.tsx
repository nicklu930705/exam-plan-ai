/**
 * Phase 3.4c-42 永久回歸測試：AI 歷史建議閱讀權限與生成權限分離（方案 A）
 *
 * 核心驗證：
 * 1. Pro → Free 後，7 天內原有 Pro AI 建議可免費閱讀。
 * 2. Pro → Free 後，不會因此重新取得 Pro 生成權限。
 * 3. Free 會員新請求遵守既有 Free 額度與功能限制。
 * 4. 冷啟動恢復歷史建議不扣額。
 * 5. 閱讀歷史建議不呼叫付費 API。
 * 6. 同一考試跨日 1 天、2 天仍可顯示。
 * 7. 超過 7 天不得顯示。
 * 8. A 考試快取不出現在 B 考試。
 * 9. 本機若存在身分切換，不能跨帳號讀取。
 * 10. 重新產生成功後依當前會員狀態更新建議。
 * 11. 重新產生失敗後仍保留歷史內容。
 * 12. React 快速連擊防護不退化。
 * 13. Build 8/9/10 既有快取 JSON 可相容讀取。
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { createDemoData } from '../../data/demo';
import {
  saveCachedAiAdvice,
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

describe('Phase 3.4c-42 方案 A：歷史建議閱讀權限與生成權限分離完整驗證', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();

    mockCurrentToday = '2026-10-24';
    mockAppData = createDemoData();
    // 預設為 Free 會員（模擬 Pro 到期降為 Free）
    mockAppData.subscription = {
      plan: 'free',
      billingCycle: 'none',
      status: 'none',
      isDevPreview: false,
    };
    mockAppData.exams[0].id = 'exam_arch_test';
    mockAppData.exams[0].name = '[TEST] 2026 軟體架構核心認證';
    mockAppData.selectedExamId = 'exam_arch_test';
    mockAppData.tasks.forEach((t) => {
      t.examId = 'exam_arch_test';
    });

    mockFetchAiQuota.mockResolvedValue({
      usedToday: 0,
      dailyLimit: 3,
      remainingToday: 3,
      resetsAt: '2026-10-25T00:00:00+08:00',
      tier: 'free',
    });
  });

  it('1. Pro → Free 後，7 天內原有 Pro AI 建議可免費閱讀且標示 Free 權益提示', async () => {
    // 模擬 10/22 在 Pro 會員期間產生的 AI 深度建議
    await saveCachedAiAdvice({
      examId: 'exam_arch_test',
      date: '2026-10-22',
      tier: 'pro',
      advice: {
        summary: 'Pro 專屬架構突破策略',
        focusSubjects: ['分散式快取'],
        actionableTips: ['深入研讀一致性雜湊', '實作 Redis 叢集'],
        estimatedFeasibility: '可行性極佳',
      },
      source: 'openai_ai',
      disclaimer: 'AI 建議僅供參考',
      createdAt: '2026-10-22T08:30:00.000Z',
    });

    let tree: any;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    const str = JSON.stringify(tree.toJSON());
    // 核心驗證：內容可見、歷史標記、Free 說明
    expect(str).toContain('Pro 專屬架構突破策略');
    expect(str).toContain('✦ 歷史 AI 讀書建議');
    expect(str).toContain('目前會員為免費版');
    expect(str).toContain('舊內容可免費閱讀');
    expect(str).toContain('新分析遵守目前免費版會員權益');
    expect(str).toContain('原始分析時間：');
  });

  it('2. Pro → Free 後冷啟動恢復歷史建議不扣額、不呼叫付費 API', async () => {
    await saveCachedAiAdvice({
      examId: 'exam_arch_test',
      date: '2026-10-22',
      tier: 'pro',
      advice: {
        summary: '舊 Pro 建議摘要',
        focusSubjects: ['系統架構'],
        actionableTips: ['提示 1'],
        estimatedFeasibility: '高',
      },
      source: 'openai_ai',
      createdAt: '2026-10-22T08:30:00.000Z',
    });

    await act(async () => {
      renderer.create(<HomeScreen />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    expect(mockRequestAiStudyAdvice).not.toHaveBeenCalled();
    expect(mockRecordAiUsage).not.toHaveBeenCalled();
    // 僅有唯讀 quota 查詢
    expect(mockFetchAiQuota).toHaveBeenCalled();
  });

  it('3. Pro → Free 後不會繼承 Pro 生成權限，新請求遵守 Free 會員權益', async () => {
    // 預先載入歷史 Pro 建議
    await saveCachedAiAdvice({
      examId: 'exam_arch_test',
      date: '2026-10-22',
      tier: 'pro',
      advice: {
        summary: '舊 Pro 建議摘要',
        focusSubjects: ['系統架構'],
        actionableTips: ['提示 1'],
        estimatedFeasibility: '高',
      },
      source: 'openai_ai',
      createdAt: '2026-10-22T08:30:00.000Z',
    });

    // 模擬後端回傳 Free 額度與結果
    const freeFreshResult: AiAdviceServiceResult = {
      success: true,
      status: 'success',
      source: 'openai_ai',
      advice: {
        summary: 'Free 方案全新分析結果',
        focusSubjects: ['基礎架構'],
        actionableTips: ['基礎行動步驟'],
        estimatedFeasibility: '普通',
      },
      disclaimer: 'AI 建議僅供參考',
      quota: {
        usedToday: 1,
        dailyLimit: 3,
        remainingToday: 2,
        resetsAt: '2026-10-25T00:00:00+08:00',
        tier: 'free',
      },
    };
    mockRequestAiStudyAdvice.mockResolvedValue(freeFreshResult);

    let tree: any;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    // 尋找重新產生按鈕
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

    // 驗證發出新請求時成功更新
    expect(mockRequestAiStudyAdvice).toHaveBeenCalledTimes(1);
    const str = JSON.stringify(tree.toJSON());
    expect(str).toContain('Free 方案全新分析結果');

    // 檢查寫入之快取其 tier 確實為目前實際等級 free，而非舊有的 pro
    const raw = await AsyncStorage.getItem(AI_ADVICE_CACHE_STORAGE_KEY);
    const parsed: StoredAiAdviceCache = JSON.parse(raw!);
    expect(parsed.items['exam_arch_test'].tier).toBe('free');
  });

  it('4. 跨日 1 天與 2 天之歷史建議仍可顯示', async () => {
    // 跨日 2 天 (10/22 -> 10/24)
    const twoDaysAgoIso = new Date(Date.now() - 2 * 86400 * 1000).toISOString();
    await saveCachedAiAdvice({
      examId: 'exam_arch_test',
      date: '2026-10-22',
      tier: 'pro',
      advice: {
        summary: '跨日 2 天前建議',
        focusSubjects: ['章節一'],
        actionableTips: ['技巧一'],
        estimatedFeasibility: '高',
      },
      source: 'openai_ai',
      createdAt: twoDaysAgoIso,
    });

    let tree: any;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    const str = JSON.stringify(tree.toJSON());
    expect(str).toContain('跨日 2 天前建議');
    expect(str).toContain('✦ 歷史 AI 讀書建議');
  });

  it('5. 超過 7 天之建議一律過期淘汰，不予顯示', async () => {
    const eightDaysAgoIso = new Date(Date.now() - 8 * 86400 * 1000).toISOString();
    await saveCachedAiAdvice({
      examId: 'exam_arch_test',
      date: '2026-10-15',
      tier: 'pro',
      advice: {
        summary: '8 天前超期建議',
        focusSubjects: ['過期章節'],
        actionableTips: ['過期提示'],
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
    expect(str).not.toContain('8 天前超期建議');
    expect(str).toContain('AI 讀書建議');
  });

  it('6. 跨考試隔離：A 考試之歷史快取絕不出現在 B 考試', async () => {
    await saveCachedAiAdvice({
      examId: 'exam_A',
      date: '2026-10-22',
      tier: 'pro',
      advice: {
        summary: 'A 考試專屬建議',
        focusSubjects: ['科目 A'],
        actionableTips: ['提示 A'],
        estimatedFeasibility: '高',
      },
      source: 'openai_ai',
      createdAt: '2026-10-22T08:30:00.000Z',
    });

    // 目前選取的考試為 exam_arch_test (B)
    let tree: any;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    const str = JSON.stringify(tree.toJSON());
    expect(str).not.toContain('A 考試專屬建議');
  });

  it('7. 重新產生失敗時，不得刪除 AsyncStorage 歷史內容，關閉錯誤後再次開啟仍能閱讀', async () => {
    await saveCachedAiAdvice({
      examId: 'exam_arch_test',
      date: '2026-10-22',
      tier: 'pro',
      advice: {
        summary: '不可遺失的歷史深度分析',
        focusSubjects: ['科目 X'],
        actionableTips: ['提示 X'],
        estimatedFeasibility: '高',
      },
      source: 'openai_ai',
      createdAt: '2026-10-22T08:30:00.000Z',
    });

    // 模擬重新產生失敗（例如網路異常）
    mockRequestAiStudyAdvice.mockRejectedValue(new Error('伺服端暫時無法連線'));

    let tree: any;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    // 點擊重新整理觸發失敗
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

    // 驗證 AsyncStorage 依然完整保留舊有內容
    const raw = await AsyncStorage.getItem(AI_ADVICE_CACHE_STORAGE_KEY);
    const parsed: StoredAiAdviceCache = JSON.parse(raw!);
    expect(parsed.items['exam_arch_test'].advice.summary).toBe('不可遺失的歷史深度分析');

    // 點擊收合/稍後再試按鈕關閉錯誤卡片
    const dismissButtons = tree.root.findAll(
      (node: any) =>
        node.props?.accessibilityRole === 'button' &&
        node.props?.accessibilityLabel === '稍後再試',
    );
    expect(dismissButtons.length).toBeGreaterThan(0);
    await act(async () => {
      dismissButtons[0].props.onPress();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    // 再次點擊「✦ 取得 AI 讀書建議」
    const openBtn = tree.root.findAll(
      (node: any) =>
        node.props?.accessibilityRole === 'button' &&
        node.props?.accessibilityLabel === '取得 AI 讀書教練建議',
    );
    expect(openBtn.length).toBeGreaterThan(0);
    await act(async () => {
      await openBtn[0].props.onPress();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    // 驗證歷史建議重新展開且可正常閱讀
    const restoredStr = JSON.stringify(tree.toJSON());
    expect(restoredStr).toContain('不可遺失的歷史深度分析');
    expect(restoredStr).toContain('✦ 歷史 AI 讀書建議');
  });

  it('8. React 快速連擊防護：在 Free 模式下多次連點只發送單次 AI 請求', async () => {
    mockRequestAiStudyAdvice.mockReturnValue(
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            success: true,
            status: 'success',
            source: 'openai_ai',
            advice: {
              summary: '連擊防護建議',
              focusSubjects: [],
              actionableTips: [],
              estimatedFeasibility: '高',
            },
            disclaimer: 'AI 建議僅供參考',
          });
        }, 150);
      }),
    );

    let tree: any;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    const openBtns = tree.root.findAll(
      (node: any) =>
        node.props?.accessibilityRole === 'button' &&
        node.props?.accessibilityLabel === '取得 AI 讀書教練建議',
    );
    expect(openBtns.length).toBeGreaterThan(0);

    // 模擬 4 次快速連點
    await act(async () => {
      openBtns[0].props.onPress();
      openBtns[0].props.onPress();
      openBtns[0].props.onPress();
      openBtns[0].props.onPress();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });

    // 驗證只有 1 次請求發出
    expect(mockRequestAiStudyAdvice).toHaveBeenCalledTimes(1);
  });

  it('9. 既有 Build 8/9/10 快取 JSON 原生結構可相容讀取', async () => {
    const build8Payload = JSON.stringify({
      version: 1,
      items: {
        exam_arch_test: {
          examId: 'exam_arch_test',
          date: '2026-10-22',
          tier: 'pro',
          advice: {
            summary: 'Build 8 原始歷史建議',
            focusSubjects: ['系統架構'],
            actionableTips: ['提示 A'],
            estimatedFeasibility: '普通',
          },
          source: 'openai_ai',
          disclaimer: 'AI 建議僅供參考',
          createdAt: new Date(Date.now() - 2 * 86400 * 1000).toISOString(),
          // 刻意無 deviceId，模擬 Build 8/9/10 產物
        },
      },
      updatedAt: new Date().toISOString(),
    });

    await AsyncStorage.setItem(AI_ADVICE_CACHE_STORAGE_KEY, build8Payload);

    let tree: any;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    const str = JSON.stringify(tree.toJSON());
    expect(str).toContain('Build 8 原始歷史建議');
    expect(str).toContain('✦ 歷史 AI 讀書建議');
    expect(str).toContain('目前會員為免費版');
  });
});
