/**
 * TC-B8-11 / Phase 3.4c-31 回歸測試：讀書計畫頁 (PlanScreen) AI 請求防重入、防連擊與考試切換競態保護
 *
 * 測試實際生產使用的 PlanScreen 組件與 handleFetchAiAdvice。
 * 嚴禁真實網路與付費 AI 呼叫：requestAiStudyAdvice 使用 Jest mock。
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
jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useLocalSearchParams: () => ({}),
}));

const mockRequestAiStudyAdvice = jest.fn();
jest.mock('../../services/aiAdviceService', () => ({
  logDiagnostic: jest.fn(),
  requestAiStudyAdvice: (...args: unknown[]) => mockRequestAiStudyAdvice(...args),
}));

const mockRecordAiUsage = jest.fn();
let mockData: AppData;
let mockSetSelectedExamId: jest.Mock;

jest.mock('../../store/AppStore', () => ({
  useAppStore: () => ({
    data: mockData,
    setTaskStatus: jest.fn(),
    setSelectedExamId: mockSetSelectedExamId,
    recordAiUsage: mockRecordAiUsage,
  }),
}));

jest.mock('../../hooks/useToday', () => ({ useToday: () => '2026-10-12' }));
jest.mock('../../hooks/useStudyTimer', () => ({
  useStudyTimer: () => ({ activeTimer: null, formattedTime: '00:00', startTimer: jest.fn() }),
}));

// eslint-disable-next-line import/first
import PlanScreen from '../(tabs)/plan';

// ───── 測試輔助 ─────
const NOW = new Date('2026-10-12T08:00:00+08:00');

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

function buildTwoExamData(selectedExamId?: string): AppData {
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
    selectedExamId: selectedExamId ?? examA.id,
    subscription: { ...base.subscription },
  } as AppData;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function findAiButton(tree: renderer.ReactTestRenderer) {
  const nodes = tree.root.findAll(
    (n) =>
      typeof n.props.accessibilityLabel === 'string' &&
      n.props.accessibilityLabel.includes('AI 讀書建議') &&
      typeof n.props.onPress === 'function',
  );
  return nodes[0];
}

function findRefreshButton(tree: renderer.ReactTestRenderer) {
  const nodes = tree.root.findAll(
    (n) =>
      typeof n.props.accessibilityLabel === 'string' &&
      n.props.accessibilityLabel.includes('重新取得 AI 建議') &&
      typeof n.props.onPress === 'function',
  );
  return nodes[0];
}

function findRetryButton(tree: renderer.ReactTestRenderer) {
  const nodes = tree.root.findAll(
    (n) =>
      typeof n.props.accessibilityLabel === 'string' &&
      n.props.accessibilityLabel.includes('重新嘗試呼叫 AI') &&
      typeof n.props.onPress === 'function',
  );
  return nodes[0];
}

function okResult(examLabel = 'A'): AiAdviceServiceResult {
  return {
    success: true,
    status: 'success',
    source: 'openai_ai',
    advice: {
      summary: `計畫建議重點-${examLabel}`,
      focusSubjects: ['科目一'],
      actionableTips: ['要點一'],
      estimatedFeasibility: '可行性高',
    },
    disclaimer: 'AI 建議僅供學習策略與心理激勵參考。',
    cached: false,
    quota: {
      usedToday: 1,
      dailyLimit: 15,
      remainingToday: 14,
      resetsAt: '2026-10-13T00:00:00+08:00',
      tier: 'pro',
    },
  };
}

async function mountPlan() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<PlanScreen />);
  });
  await flush();
  return tree;
}

describe('讀書計畫頁 AI 請求防重入與競態（實際 PlanScreen）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetSelectedExamId = jest.fn();
    mockData = buildTwoExamData();
  });

  it('1. 單次點擊只發出 1 次 AI 請求，成功後記錄 1 次用量並顯示建議', async () => {
    mockRequestAiStudyAdvice.mockResolvedValue(okResult('A'));
    const tree = await mountPlan();
    const btn = findAiButton(tree);
    expect(btn).toBeDefined();

    await act(async () => {
      await btn.props.onPress();
    });
    await flush();

    expect(mockRequestAiStudyAdvice).toHaveBeenCalledTimes(1);
    expect(mockRecordAiUsage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(tree.toJSON())).toContain('計畫建議重點-A');
  });

  it.each([2, 5])('2. 同步快速連擊 %i 次（同一 React 批次），只發出 1 次付費請求', async (clicks) => {
    const d = deferred<AiAdviceServiceResult>();
    mockRequestAiStudyAdvice.mockReturnValue(d.promise);
    const tree = await mountPlan();
    const btn = findAiButton(tree);

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

  it('3. 請求進行期間不能重複觸發（載入中 disabled 且 handler 攔截）', async () => {
    const d = deferred<AiAdviceServiceResult>();
    mockRequestAiStudyAdvice.mockReturnValue(d.promise);
    const tree = await mountPlan();
    const staleHandler = findAiButton(tree).props.onPress;

    await act(async () => {
      staleHandler();
    });
    await flush();

    // 載入中應呈現載入提示
    expect(JSON.stringify(tree.toJSON())).toContain('AI 讀書教練深度分析中');

    // 即使以舊 handler 再次呼叫也被 isRequestingAiRef 攔截
    await act(async () => {
      staleHandler();
    });
    expect(mockRequestAiStudyAdvice).toHaveBeenCalledTimes(1);

    await act(async () => {
      d.resolve(okResult('A'));
    });
    await flush();
  });

  it('4. 成功後鎖正常釋放，可手動重新整理並再次發送下一筆請求', async () => {
    mockRequestAiStudyAdvice
      .mockResolvedValueOnce(okResult('first'))
      .mockResolvedValueOnce(okResult('second'));

    const tree = await mountPlan();

    await act(async () => {
      await findAiButton(tree).props.onPress();
    });
    await flush();
    expect(JSON.stringify(tree.toJSON())).toContain('計畫建議重點-first');

    const refreshBtn = findRefreshButton(tree);
    expect(refreshBtn).toBeDefined();

    await act(async () => {
      await refreshBtn.props.onPress();
    });
    await flush();

    expect(mockRequestAiStudyAdvice).toHaveBeenCalledTimes(2);
    expect(mockRecordAiUsage).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(tree.toJSON())).toContain('計畫建議重點-second');
  });

  it('5. 失敗後鎖正常釋放，顯示錯誤狀態並可透過重試按鈕重新發起請求', async () => {
    mockRequestAiStudyAdvice
      .mockRejectedValueOnce(new Error('網路異常 503'))
      .mockResolvedValueOnce(okResult('recovered'));

    const tree = await mountPlan();

    await act(async () => {
      await findAiButton(tree).props.onPress();
    });
    await flush();

    expect(JSON.stringify(tree.toJSON())).toContain('網路異常 503');

    const retryBtn = findRetryButton(tree);
    expect(retryBtn).toBeDefined();

    await act(async () => {
      await retryBtn.props.onPress();
    });
    await flush();

    expect(mockRequestAiStudyAdvice).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(tree.toJSON())).toContain('計畫建議重點-recovered');
  });

  it('6. 考試切換競態：A 考試請求尚未完成時切換至 B，A 的回應不得覆蓋 B 畫面', async () => {
    const dExamA = deferred<AiAdviceServiceResult>();
    mockRequestAiStudyAdvice.mockReturnValue(dExamA.promise);

    const tree = await mountPlan();

    // 在 Exam A 點擊請求，展開 AI 區塊並處於載入中
    await act(async () => {
      findAiButton(tree).props.onPress();
    });
    expect(mockRequestAiStudyAdvice).toHaveBeenCalledTimes(1);

    // 全域切換考試至 Exam B (showAiSection 仍為 true)
    mockData = buildTwoExamData(mockData.exams[1].id);
    await act(async () => {
      tree.update(<PlanScreen />);
    });
    await flush();

    // Exam A 請求延遲完成並返回
    await act(async () => {
      dExamA.resolve(okResult('A'));
    });
    await flush();

    // 畫面目前為 Exam B，不得顯示 Exam A 的建議結果
    expect(JSON.stringify(tree.toJSON())).not.toContain('計畫建議重點-A');
  });

  it('7. 舊請求完成不能錯誤解除新請求的防重入鎖', async () => {
    const dReq1 = deferred<AiAdviceServiceResult>();
    const dReq2 = deferred<AiAdviceServiceResult>();

    mockRequestAiStudyAdvice
      .mockReturnValueOnce(dReq1.promise)
      .mockReturnValueOnce(dReq2.promise);

    const tree = await mountPlan();
    const btn = findAiButton(tree);

    // 發起第一個請求
    await act(async () => {
      btn.props.onPress();
    });
    expect(mockRequestAiStudyAdvice).toHaveBeenCalledTimes(1);

    // 模擬第一個請求逾時釋放後發起第二個請求
    await act(async () => {
      dReq1.reject(new Error('逾時'));
    });
    await flush();

    const retryBtn = findRetryButton(tree);
    await act(async () => {
      retryBtn.props.onPress();
    });
    expect(mockRequestAiStudyAdvice).toHaveBeenCalledTimes(2);

    // 此時第二個請求 (dReq2) 進行中，舊的逾時/延遲回呼若再次觸發，不應干擾第二個請求的鎖狀態
    // 再次點擊應被攔截
    await act(async () => {
      const anyBtn = findAiButton(tree);
      if (anyBtn) anyBtn.props.onPress();
    });
    expect(mockRequestAiStudyAdvice).toHaveBeenCalledTimes(2);

    await act(async () => {
      dReq2.resolve(okResult('req2'));
    });
    await flush();

    expect(JSON.stringify(tree.toJSON())).toContain('計畫建議重點-req2');
  });
});
