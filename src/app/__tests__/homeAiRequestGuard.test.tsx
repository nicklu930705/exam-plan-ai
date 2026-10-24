/**
 * TC-B8-11 回歸測試：首頁 AI 建議請求防重入、競態與快取行為
 *
 * 本測試直接渲染「實際生產使用的 HomeScreen」，透過 Jest Mock 隔離網路與儲存層，
 * 驗證 handleRequestAiAdvice / handleOpenOrRequestAiAdvice 的真實處理邏輯。
 * 嚴禁真實 AI API 呼叫：requestAiStudyAdvice 全部為 jest.fn()。
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';

import { createDemoData } from '../../data/demo';
import type { AiAdviceServiceResult } from '../../services/aiAdviceService';
import type { AppData, Exam, StudyTask } from '../../types/models';

// ───── Mocks ─────
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
jest.mock('../../services/aiAdviceService', () => ({
  logDiagnostic: jest.fn(),
  requestAiStudyAdvice: (...args: unknown[]) => mockRequestAiStudyAdvice(...args),
  fetchAiQuotaFromBackend: (...args: unknown[]) => mockFetchAiQuota(...args),
}));

const mockGetCachedAiAdvice = jest.fn();
const mockSaveCachedAiAdvice = jest.fn();
const mockSaveLatestQuotaCache = jest.fn();
jest.mock('../../services/aiAdviceCacheService', () => {
  const actual = jest.requireActual('../../services/aiAdviceCacheService');
  return {
    ...actual,
    getCachedAiAdvice: (...args: unknown[]) => mockGetCachedAiAdvice(...args),
    saveCachedAiAdvice: (...args: unknown[]) => mockSaveCachedAiAdvice(...args),
    saveLatestQuotaCache: (...args: unknown[]) => mockSaveLatestQuotaCache(...args),
  };
});

const mockRecordAiUsage = jest.fn();
let mockData: AppData;
jest.mock('../../store/AppStore', () => ({
  useAppStore: () => ({
    data: mockData,
    setTaskStatus: jest.fn(),
    setSelectedExamId: jest.fn(),
    loadDemo: jest.fn(),
    recordAiUsage: mockRecordAiUsage,
  }),
}));

jest.mock('../../hooks/useToday', () => ({ useToday: () => '2026-10-12' }));
jest.mock('../../hooks/useStudyTimer', () => ({
  useStudyTimer: () => ({ activeTimer: null, formattedTime: '00:00', startTimer: jest.fn() }),
}));

// eslint-disable-next-line import/first
import HomeScreen from '../(tabs)/index';

// ───── 測試輔助 ─────
const NOW = new Date('2026-10-12T08:00:00+08:00');
const OPEN_LABEL = '取得 AI 讀書教練建議';
const REFRESH_LABEL = '重新取得 AI 建議（將消耗 1 次本日配額）';

const sampleAdvice = {
  summary: '備考策略重點',
  focusSubjects: ['科目一'],
  actionableTips: ['要點一'],
  estimatedFeasibility: '可行性高',
};

function okResult(label = 'A', cached = false): AiAdviceServiceResult {
  return {
    success: true,
    status: 'success',
    source: 'openai_ai',
    advice: { ...sampleAdvice, summary: `建議-${label}` },
    disclaimer: 'x',
    cached,
    quota: {
      usedToday: 1,
      dailyLimit: 15,
      remainingToday: 14,
      resetsAt: '2026-10-13T00:00:00+08:00',
      tier: 'pro',
    },
  } as AiAdviceServiceResult;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function buildTwoExamData(selectedExamId: string): AppData {
  const base = createDemoData(NOW);
  const examA: Exam = base.exams[0];
  const examB: Exam = { ...examA, id: 'exam_b', name: '第二個考試' };
  const tasksB: StudyTask[] = base.tasks
    .filter((t) => t.examId === examA.id)
    .map((t) => ({ ...t, id: `${t.id}_b`, examId: 'exam_b' }));
  return {
    ...base,
    exams: [examA, examB],
    tasks: [...base.tasks, ...tasksB],
    selectedExamId,
    subscription: { ...base.subscription },
  } as AppData;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function findByLabel(tree: renderer.ReactTestRenderer, label: string) {
  const nodes = tree.root.findAll(
    (n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
  );
  return nodes[0];
}

async function mountHome(selectedExamId = 'exam_a_placeholder') {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<HomeScreen />);
  });
  await flush();
  return tree;
}

describe('首頁 AI 建議請求防重入與競態（實際 HomeScreen）', () => {
  let examAId: string;

  beforeEach(() => {
    jest.clearAllMocks();
    mockData = buildTwoExamData(createDemoData(NOW).exams[0].id);
    examAId = mockData.exams[0].id;
    mockGetCachedAiAdvice.mockResolvedValue({ cachedAdvice: null });
    mockFetchAiQuota.mockResolvedValue(null);
    mockSaveCachedAiAdvice.mockResolvedValue(undefined);
    mockSaveLatestQuotaCache.mockResolvedValue(undefined);
  });

  it('1. 單次點擊只發出 1 次 AI 請求，成功後記錄 1 次用量並寫入快取', async () => {
    mockRequestAiStudyAdvice.mockResolvedValue(okResult('A'));
    const tree = await mountHome();
    const btn = findByLabel(tree, OPEN_LABEL);
    expect(btn).toBeDefined();

    await act(async () => {
      await btn.props.onPress();
    });
    await flush();

    expect(mockRequestAiStudyAdvice).toHaveBeenCalledTimes(1);
    expect(mockRecordAiUsage).toHaveBeenCalledTimes(1);
    expect(mockSaveCachedAiAdvice).toHaveBeenCalledTimes(1);
    expect(mockSaveCachedAiAdvice.mock.calls[0][0].examId).toBe(examAId);
  });

  it.each([2, 5])('2. 同步快速連擊 %i 次（同一 React 批次），只發出 1 次請求', async (clicks) => {
    const d = deferred<AiAdviceServiceResult>();
    mockRequestAiStudyAdvice.mockReturnValue(d.promise);
    const tree = await mountHome();
    const btn = findByLabel(tree, OPEN_LABEL);

    // 同一 act 批次內連擊：React 尚未重新渲染，closure 中的 isLoadingAi 仍為 false
    await act(async () => {
      for (let i = 0; i < clicks; i++) {
        btn.props.onPress();
      }
    });

    expect(mockRequestAiStudyAdvice).toHaveBeenCalledTimes(1);

    await act(async () => {
      d.resolve(okResult('A'));
    });
    await flush();

    expect(mockRequestAiStudyAdvice).toHaveBeenCalledTimes(1);
    expect(mockRecordAiUsage).toHaveBeenCalledTimes(1);
  });

  it('3. 載入中重新整理按鈕被隱藏，且再次觸發不會發出新請求', async () => {
    const d = deferred<AiAdviceServiceResult>();
    mockRequestAiStudyAdvice.mockReturnValue(d.promise);
    const tree = await mountHome();
    const staleHandler = findByLabel(tree, OPEN_LABEL).props.onPress as () => void;

    await act(async () => {
      staleHandler();
    });
    await flush();

    // 載入中：卡片顯示載入視圖，無重新整理按鈕
    expect(findByLabel(tree, REFRESH_LABEL)).toBeUndefined();
    expect(JSON.stringify(tree.toJSON())).toContain('AI 讀書教練深度分析中');

    // 即使以過期的 handler 參考再次觸發，也被同步鎖攔截
    await act(async () => {
      staleHandler();
    });
    expect(mockRequestAiStudyAdvice).toHaveBeenCalledTimes(1);

    await act(async () => {
      d.resolve(okResult('A'));
    });
    await flush();
  });

  it('4. 請求成功後鎖正常釋放，按鈕恢復，可再手動重新整理並再次扣額', async () => {
    mockRequestAiStudyAdvice
      .mockResolvedValueOnce(okResult('first'))
      .mockResolvedValueOnce(okResult('second'));
    const tree = await mountHome();

    await act(async () => {
      await findByLabel(tree, OPEN_LABEL).props.onPress();
    });
    await flush();
    expect(mockRequestAiStudyAdvice).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(tree.toJSON())).not.toContain('AI 讀書教練深度分析中');

    const refresh = findByLabel(tree, REFRESH_LABEL);
    expect(refresh).toBeDefined();
    expect(refresh.props.disabled).toBe(false);

    await act(async () => {
      await refresh.props.onPress();
    });
    await flush();

    expect(mockRequestAiStudyAdvice).toHaveBeenCalledTimes(2);
    expect(mockRecordAiUsage).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(tree.toJSON())).toContain('建議-second');
  });

  it('5. 請求失敗（回傳失敗結果）後鎖釋放，可重試', async () => {
    mockRequestAiStudyAdvice
      .mockResolvedValueOnce({
        success: false,
        status: 'network_error',
        source: 'fallback_rule_engine',
        disclaimer: 'x',
        error: '網路失敗',
        errorCode: 'NETWORK_ERROR',
      })
      .mockResolvedValueOnce(okResult('retry'));
    const tree = await mountHome();

    await act(async () => {
      await findByLabel(tree, OPEN_LABEL).props.onPress();
    });
    await flush();
    expect(mockRecordAiUsage).not.toHaveBeenCalled();

    const retry = findByLabel(tree, '重新嘗試呼叫 AI');
    expect(retry).toBeDefined();
    await act(async () => {
      await retry.props.onPress();
    });
    await flush();

    expect(mockRequestAiStudyAdvice).toHaveBeenCalledTimes(2);
    expect(mockRecordAiUsage).toHaveBeenCalledTimes(1);
  });

  it('6. 請求逾時／拋出例外後鎖釋放，不扣額，可再次請求', async () => {
    const timeoutErr = Object.assign(new Error('TIMEOUT'), { name: 'TimeoutError' });
    mockRequestAiStudyAdvice
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValueOnce(okResult('after-timeout'));
    const tree = await mountHome();

    await act(async () => {
      await findByLabel(tree, OPEN_LABEL).props.onPress();
    });
    await flush();
    expect(mockRecordAiUsage).not.toHaveBeenCalled();
    expect(JSON.stringify(tree.toJSON())).not.toContain('AI 讀書教練深度分析中');

    const retry = findByLabel(tree, '重新嘗試呼叫 AI');
    expect(retry).toBeDefined();
    await act(async () => {
      await retry.props.onPress();
    });
    await flush();

    expect(mockRequestAiStudyAdvice).toHaveBeenCalledTimes(2);
    expect(mockRecordAiUsage).toHaveBeenCalledTimes(1);
  });

  it('7. 快速切換考試：A 考試的舊請求結果不覆蓋目前顯示的 B 考試，但仍寫入 A 專屬快取', async () => {
    const d = deferred<AiAdviceServiceResult>();
    mockRequestAiStudyAdvice.mockReturnValue(d.promise);
    const tree = await mountHome();

    await act(async () => {
      findByLabel(tree, OPEN_LABEL).props.onPress();
    });
    await flush();
    expect(mockRequestAiStudyAdvice).toHaveBeenCalledTimes(1);

    // 切換到 B 考試（請求仍在進行中）
    mockData = buildTwoExamData('exam_b');
    await act(async () => {
      tree.update(<HomeScreen />);
    });
    await flush();

    await act(async () => {
      d.resolve(okResult('FROM-A'));
    });
    await flush();

    // 畫面不得出現 A 的建議
    expect(JSON.stringify(tree.toJSON())).not.toContain('建議-FROM-A');
    // 已扣額的成功結果仍存入 A 考試自己的快取，不遺失
    expect(mockSaveCachedAiAdvice).toHaveBeenCalledTimes(1);
    expect(mockSaveCachedAiAdvice.mock.calls[0][0].examId).toBe(examAId);
    // 鎖已釋放：B 考試可立即請求
    mockRequestAiStudyAdvice.mockResolvedValueOnce(okResult('FROM-B'));
    const openB = findByLabel(tree, OPEN_LABEL);
    if (openB) {
      await act(async () => {
        await openB.props.onPress();
      });
      await flush();
      expect(mockRequestAiStudyAdvice).toHaveBeenCalledTimes(2);
    }
  });

  it('8. 已快取的建議：冷啟動恢復與開啟卡片都不會呼叫付費 AI', async () => {
    mockGetCachedAiAdvice.mockResolvedValue({
      cachedAdvice: {
        examId: examAId,
        date: '2026-10-12',
        tier: 'free',
        advice: { ...sampleAdvice, summary: '建議-CACHED' },
        source: 'openai_ai',
        disclaimer: 'x',
        createdAt: '2026-10-12T01:00:00.000Z',
        taskSnapshot: { totalTasks: 1, completedTasks: 0, completionRate: 0 },
        quotaSnapshot: {
          usedToday: 1,
          dailyLimit: 3,
          remainingToday: 2,
          resetsAt: '2026-10-13T00:00:00+08:00',
          tier: 'free',
        },
      },
    });
    const tree = await mountHome();

    expect(JSON.stringify(tree.toJSON())).toContain('建議-CACHED');
    expect(mockRequestAiStudyAdvice).not.toHaveBeenCalled();
    expect(mockRecordAiUsage).not.toHaveBeenCalled();
  });
});
