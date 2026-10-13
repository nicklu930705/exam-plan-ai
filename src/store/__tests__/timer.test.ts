import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadAppDataFromStorage, saveAppDataToStorage } from '../../storage';
import { createId, DEFAULT_PREFERENCES, reducer } from '../AppStore';
import type { AppData, Exam, ISODate, StudyTask } from '../../types/models';

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

describe('讀書計時功能與狀態完整測試 (Study Timer Suite)', () => {
  const today: ISODate = '2026-10-12';

  const mockExam: Exam = {
    id: createId('exam'),
    name: '全民英檢中高級',
    examDate: '2026-11-20',
    createdAt: '2026-10-12T00:00:00.000Z',
    subjects: [
      {
        id: 'sub_1',
        name: '閱讀能力',
        familiarity: 3,
        chapters: [{ id: 'ch_1', title: '篇章結構分析' }],
      },
    ],
  };

  const mockTask1: StudyTask = {
    id: 'task_1',
    examId: mockExam.id,
    subjectId: 'sub_1',
    subjectName: '閱讀能力',
    chapterId: 'ch_1',
    title: '閱讀能力 - 篇章結構分析',
    date: today,
    estimatedMinutes: 45,
    status: 'pending',
    kind: 'study',
  };

  const mockTask2: StudyTask = {
    id: 'task_2',
    examId: mockExam.id,
    subjectId: 'sub_1',
    subjectName: '閱讀能力',
    chapterId: 'ch_1',
    title: '閱讀能力 - 模擬題演練',
    date: today,
    estimatedMinutes: 30,
    status: 'pending',
    kind: 'review',
  };

  const baseState: AppData = {
    exams: [mockExam],
    tasks: [mockTask1, mockTask2],
    preferences: DEFAULT_PREFERENCES,
    isDemo: false,
    activeTimer: null,
  };

  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
  });

  test('1. 開始計時：正確建立 activeTimer 結構', () => {
    const startTime = 1700000000000;
    const state = reducer(baseState, {
      type: 'startTimer',
      taskId: 'task_1',
      now: startTime,
    });

    expect(state.activeTimer).not.toBeNull();
    expect(state.activeTimer?.taskId).toBe('task_1');
    expect(state.activeTimer?.taskTitle).toBe('閱讀能力 - 篇章結構分析');
    expect(state.activeTimer?.subjectName).toBe('閱讀能力');
    expect(state.activeTimer?.examId).toBe(mockExam.id);
    expect(state.activeTimer?.startedAt).toBe(startTime);
    expect(state.activeTimer?.accumulatedSeconds).toBe(0);
    expect(state.activeTimer?.isRunning).toBe(true);
  });

  test('2. 暫停與繼續計時：累加秒數且不遺失時間', () => {
    const t0 = 1700000000000;
    // 啟動
    let state = reducer(baseState, {
      type: 'startTimer',
      taskId: 'task_1',
      now: t0,
    });

    // 進行 120 秒後暫停
    const t1 = t0 + 120 * 1000;
    state = reducer(state, {
      type: 'pauseTimer',
      now: t1,
    });

    expect(state.activeTimer?.isRunning).toBe(false);
    expect(state.activeTimer?.accumulatedSeconds).toBe(120);

    // 暫停期間過 60 秒後恢復（不應計入暫停的 60 秒）
    const t2 = t1 + 60 * 1000;
    state = reducer(state, {
      type: 'resumeTimer',
      now: t2,
    });

    expect(state.activeTimer?.isRunning).toBe(true);
    expect(state.activeTimer?.startedAt).toBe(t2);
    expect(state.activeTimer?.accumulatedSeconds).toBe(120);

    // 再進行 180 秒後暫停
    const t3 = t2 + 180 * 1000;
    state = reducer(state, {
      type: 'pauseTimer',
      now: t3,
    });

    expect(state.activeTimer?.isRunning).toBe(false);
    expect(state.activeTimer?.accumulatedSeconds).toBe(300); // 120 + 180
  });

  test('3. 結束計時並保存：正確計算 actualMinutes 並更新至任務', () => {
    const t0 = 1700000000000;
    let state = reducer(baseState, {
      type: 'startTimer',
      taskId: 'task_1',
      now: t0,
    });

    // 進行 25 分鐘 (1500 秒)
    const tEnd = t0 + 1500 * 1000;
    state = reducer(state, {
      type: 'stopTimer',
      now: tEnd,
    });

    // activeTimer 應被清除
    expect(state.activeTimer).toBeNull();

    // 任務 actualMinutes 應為 25
    const task = state.tasks.find((t) => t.id === 'task_1');
    expect(task?.actualMinutes).toBe(25);
  });

  test('4. 多次讀書累計：同任務再次計時應累加 actualMinutes', () => {
    const t0 = 1700000000000;
    // 第一次讀 15 分鐘
    let state = reducer(baseState, {
      type: 'startTimer',
      taskId: 'task_1',
      now: t0,
    });
    state = reducer(state, {
      type: 'stopTimer',
      now: t0 + 15 * 60 * 1000,
    });

    expect(state.tasks.find((t) => t.id === 'task_1')?.actualMinutes).toBe(15);

    // 第二次讀 20 分鐘
    const t1 = t0 + 3600 * 1000;
    state = reducer(state, {
      type: 'startTimer',
      taskId: 'task_1',
      now: t1,
    });
    state = reducer(state, {
      type: 'stopTimer',
      now: t1 + 20 * 60 * 1000,
    });

    expect(state.tasks.find((t) => t.id === 'task_1')?.actualMinutes).toBe(35); // 15 + 20
  });

  test('5. 切換任務計時：自動結算前一項任務，避免雙重計時與資料遺失', () => {
    const t0 = 1700000000000;
    // 開始計時 task_1
    let state = reducer(baseState, {
      type: 'startTimer',
      taskId: 'task_1',
      now: t0,
    });

    // 10 分鐘後直接開始計時 task_2
    const t1 = t0 + 10 * 60 * 1000;
    state = reducer(state, {
      type: 'startTimer',
      taskId: 'task_2',
      now: t1,
    });

    // task_1 應已自動結算 10 分鐘
    expect(state.tasks.find((t) => t.id === 'task_1')?.actualMinutes).toBe(10);

    // activeTimer 應切換至 task_2
    expect(state.activeTimer?.taskId).toBe('task_2');
    expect(state.activeTimer?.isRunning).toBe(true);
    expect(state.activeTimer?.startedAt).toBe(t1);
  });

  test('6. 放棄計時 (discardTimer)：不更新任務 actualMinutes', () => {
    const t0 = 1700000000000;
    let state = reducer(baseState, {
      type: 'startTimer',
      taskId: 'task_1',
      now: t0,
    });

    state = reducer(state, {
      type: 'discardTimer',
    });

    expect(state.activeTimer).toBeNull();
    expect(state.tasks.find((t) => t.id === 'task_1')?.actualMinutes).toBeUndefined();
  });

  test('7. 手動調整讀書時間 (setTaskActualMinutes)：支援手動輸入且防止負數', () => {
    let state = reducer(baseState, {
      type: 'setTaskActualMinutes',
      taskId: 'task_1',
      minutes: 40,
    });

    expect(state.tasks.find((t) => t.id === 'task_1')?.actualMinutes).toBe(40);

    // 嘗試輸入負數應自動修正為 0
    state = reducer(state, {
      type: 'setTaskActualMinutes',
      taskId: 'task_1',
      minutes: -15,
    });

    expect(state.tasks.find((t) => t.id === 'task_1')?.actualMinutes).toBe(0);
  });

  test('8. 極限保護：防止異常暴衝時間 (單次計時上限 12 小時 / 720 分鐘)', () => {
    const t0 = 1700000000000;
    let state = reducer(baseState, {
      type: 'startTimer',
      taskId: 'task_1',
      now: t0,
    });

    // 模擬設備放置 3 天 (72 小時) 後結束
    const tRunaway = t0 + 72 * 3600 * 1000;
    state = reducer(state, {
      type: 'stopTimer',
      now: tRunaway,
    });

    expect(state.tasks.find((t) => t.id === 'task_1')?.actualMinutes).toBe(720);
  });

  test('9. 計時狀態持久化與恢復：AsyncStorage 儲存與重載測試', async () => {
    const t0 = 1700000000000;
    const runningState = reducer(baseState, {
      type: 'startTimer',
      taskId: 'task_1',
      now: t0,
    });

    // 儲存至 AsyncStorage
    await saveAppDataToStorage(runningState);

    // 重新載入
    const reloaded = await loadAppDataFromStorage();
    expect(reloaded).not.toBeNull();
    expect(reloaded?.activeTimer).not.toBeNull();
    expect(reloaded?.activeTimer?.taskId).toBe('task_1');
    expect(reloaded?.activeTimer?.taskTitle).toBe('閱讀能力 - 篇章結構分析');
    expect(reloaded?.activeTimer?.isRunning).toBe(true);
  });
});
