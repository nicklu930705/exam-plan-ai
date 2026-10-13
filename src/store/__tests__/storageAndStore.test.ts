import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  clearAppDataFromStorage,
  loadAppDataFromStorage,
  saveAppDataToStorage,
} from '../../storage';
import {
  DEFAULT_PREFERENCES,
  INITIAL_EMPTY_DATA,
  createId,
  reducer,
} from '../AppStore';
import type { AppData, Exam, StudyPreferences, StudyTask } from '../../types/models';

// 使用官方 async-storage-mock
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

describe('本機資料儲存與資料保存 (AsyncStorage Persistence)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
  });

  const mockExam: Exam = {
    id: 'exam-1',
    name: '多益英語測驗',
    examDate: '2026-11-20',
    subjects: [
      {
        id: 'sub-1',
        name: '聽力測驗',
        familiarity: 2,
        chapters: [{ id: 'ch-1', title: '短對話聽力' }],
      },
    ],
    createdAt: '2026-10-12T00:00:00.000Z',
  };

  const mockTask: StudyTask = {
    id: 'task-1',
    examId: 'exam-1',
    subjectId: 'sub-1',
    subjectName: '聽力測驗',
    chapterId: 'ch-1',
    title: '短對話聽力：重點精讀',
    kind: 'study',
    estimatedMinutes: 45,
    date: '2026-10-15',
    status: 'pending',
  };

  const mockPreferences: StudyPreferences = {
    dailyMinutes: 90,
    restDays: [0],
    intensity: 'normal',
  };

  const mockAppData: AppData = {
    exams: [mockExam],
    tasks: [mockTask],
    preferences: mockPreferences,
    isDemo: false,
  };

  test('儲存與載入：成功將 AppData 序列化寫入本機並還原', async () => {
    await saveAppDataToStorage(mockAppData);

    const loaded = await loadAppDataFromStorage();
    expect(loaded).not.toBeNull();
    expect(loaded?.exams.length).toBe(1);
    expect(loaded?.exams[0].name).toBe('多益英語測驗');
    expect(loaded?.tasks.length).toBe(1);
    expect(loaded?.tasks[0].id).toBe('task-1');
    expect(loaded?.tasks[0].status).toBe('pending');
    expect(loaded?.preferences.dailyMinutes).toBe(90);
  });

  test('關閉 App 後重新開啟模擬：在記憶體重置的情況下，資料依然存在', async () => {
    // 步驟 1：使用者建立考試與任務並標記完成一項任務
    const completedTask: StudyTask = {
      ...mockTask,
      status: 'done',
      completedAt: '2026-10-15T10:00:00.000Z',
    };
    const appStateBeforeQuit: AppData = {
      ...mockAppData,
      tasks: [completedTask],
    };
    await saveAppDataToStorage(appStateBeforeQuit);

    // 步驟 2：模擬 App 退出進程（記憶體變數全部丟棄）
    let inMemoryState: AppData | null = null;
    expect(inMemoryState).toBeNull();

    // 步驟 3：重新啟動 App，從 AsyncStorage 讀取
    inMemoryState = await loadAppDataFromStorage();
    expect(inMemoryState).not.toBeNull();
    expect(inMemoryState?.tasks[0].status).toBe('done');
    expect(inMemoryState?.tasks[0].completedAt).toBe('2026-10-15T10:00:00.000Z');
    expect(inMemoryState?.exams[0].id).toBe('exam-1');
  });

  test('格式損毀或無資料時容錯處理', async () => {
    const empty = await loadAppDataFromStorage();
    expect(empty).toBeNull();

    await AsyncStorage.setItem('@exam_plan_ai:v1_data', 'invalid-json{{{');
    const corrupted = await loadAppDataFromStorage();
    expect(corrupted).toBeNull();
  });

  test('清除本機資料：成功移除儲存之鍵值', async () => {
    await saveAppDataToStorage(mockAppData);
    expect(await loadAppDataFromStorage()).not.toBeNull();

    await clearAppDataFromStorage();
    expect(await loadAppDataFromStorage()).toBeNull();
  });
});

describe('狀態管理模組 (AppStore Reducer Actions)', () => {
  const baseExam: Exam = {
    id: 'exam-1',
    name: '期末考',
    examDate: '2026-11-01',
    subjects: [],
    createdAt: '2026-10-12T00:00:00.000Z',
  };

  const baseTask1: StudyTask = {
    id: 'task-1',
    examId: 'exam-1',
    subjectId: 'sub-1',
    subjectName: '演算法',
    chapterId: 'ch-algo',
    title: '演算法重點筆記',
    kind: 'study',
    estimatedMinutes: 50,
    date: '2026-10-15',
    status: 'pending',
  };

  const baseTask2: StudyTask = {
    id: 'task-2',
    examId: 'exam-2',
    subjectId: 'sub-2',
    subjectName: '微積分',
    chapterId: 'ch-limit',
    title: '極限定理練習',
    kind: 'practice',
    estimatedMinutes: 40,
    date: '2026-10-16',
    status: 'pending',
  };

  const initialState: AppData = {
    exams: [baseExam],
    tasks: [baseTask1, baseTask2],
    preferences: DEFAULT_PREFERENCES,
    isDemo: false,
  };

  test('任務完成與取消完成 (setTaskStatus)', () => {
    // 標記為完成
    const doneState = reducer(initialState, {
      type: 'setTaskStatus',
      taskId: 'task-1',
      status: 'done',
    });
    const doneTask = doneState.tasks.find((t) => t.id === 'task-1');
    expect(doneTask?.status).toBe('done');
    expect(doneTask?.completedAt).toBeDefined();

    // 取消完成，恢復為未完成
    const revertedState = reducer(doneState, {
      type: 'setTaskStatus',
      taskId: 'task-1',
      status: 'pending',
    });
    const revertedTask = revertedState.tasks.find((t) => t.id === 'task-1');
    expect(revertedTask?.status).toBe('pending');
    expect(revertedTask?.completedAt).toBeUndefined();

    // 標記為需重新排程
    const flaggedState = reducer(revertedState, {
      type: 'setTaskStatus',
      taskId: 'task-1',
      status: 'needsReschedule',
    });
    expect(flaggedState.tasks.find((t) => t.id === 'task-1')?.status).toBe('needsReschedule');
  });

  test('編輯任務預估時間 (setTaskMinutes)', () => {
    const updated = reducer(initialState, {
      type: 'setTaskMinutes',
      taskId: 'task-1',
      minutes: 75,
    });
    expect(updated.tasks.find((t) => t.id === 'task-1')?.estimatedMinutes).toBe(75);
    // 其他任務不變
    expect(updated.tasks.find((t) => t.id === 'task-2')?.estimatedMinutes).toBe(40);
  });

  test('編輯任務預定日期 (setTaskDate)', () => {
    const updated = reducer(initialState, {
      type: 'setTaskDate',
      taskId: 'task-1',
      date: '2026-10-20',
    });
    expect(updated.tasks.find((t) => t.id === 'task-1')?.date).toBe('2026-10-20');
  });

  test('刪除單一任務 (deleteTask)', () => {
    const updated = reducer(initialState, {
      type: 'deleteTask',
      taskId: 'task-1',
    });
    expect(updated.tasks.length).toBe(1);
    expect(updated.tasks.find((t) => t.id === 'task-1')).toBeUndefined();
    expect(updated.tasks.find((t) => t.id === 'task-2')).toBeDefined();
  });

  test('建立考試與任務 (createExamWithTasks)', () => {
    const newExam: Exam = {
      id: 'exam-3',
      name: '日語檢定 N2',
      examDate: '2026-12-05',
      subjects: [],
      createdAt: '2026-10-12T00:00:00.000Z',
    };
    const newTask: StudyTask = {
      id: 'task-3',
      examId: 'exam-3',
      subjectId: 'sub-3',
      subjectName: '日文閱讀',
      title: '短篇閱讀精讀',
      kind: 'study',
      estimatedMinutes: 40,
      date: '2026-10-22',
      status: 'pending',
    };

    const updated = reducer(initialState, {
      type: 'createExamWithTasks',
      exam: newExam,
      tasks: [newTask],
    });

    expect(updated.exams.length).toBe(2);
    expect(updated.exams.some((e) => e.id === 'exam-3')).toBe(true);
    expect(updated.tasks.length).toBe(3);
    expect(updated.tasks.some((t) => t.id === 'task-3')).toBe(true);
    expect(updated.isDemo).toBe(false);
  });

  test('示範模式下建立真實考試 (createExamWithTasks) 會乾淨替換示範資料', () => {
    const demoState: AppData = {
      ...initialState,
      isDemo: true,
    };
    const realExam: Exam = {
      id: 'real-exam',
      name: '大學學測',
      examDate: '2026-11-30',
      subjects: [],
      createdAt: '2026-10-12T00:00:00.000Z',
    };
    const realTask: StudyTask = {
      id: 'real-task-1',
      examId: 'real-exam',
      subjectId: 'sub-math',
      subjectName: '高中數學',
      title: '多項式複習',
      kind: 'study',
      estimatedMinutes: 45,
      date: '2026-10-20',
      status: 'pending',
    };

    const updated = reducer(demoState, {
      type: 'createExamWithTasks',
      exam: realExam,
      tasks: [realTask],
    });

    // 替換示範考試與任務
    expect(updated.exams.length).toBe(1);
    expect(updated.exams[0].id).toBe('real-exam');
    expect(updated.tasks.length).toBe(1);
    expect(updated.tasks[0].id).toBe('real-task-1');
    expect(updated.isDemo).toBe(false);
  });

  test('套用重新排程任務 (applyRescheduledTasks) 僅更新目標考試，保留其他考試任務', () => {
    const rescheduledTask1: StudyTask = {
      ...baseTask1,
      date: '2026-10-25',
    };

    const updated = reducer(initialState, {
      type: 'applyRescheduledTasks',
      examId: 'exam-1',
      updatedTasks: [rescheduledTask1],
    });

    // exam-1 的任務被更新
    expect(updated.tasks.find((t) => t.id === 'task-1')?.date).toBe('2026-10-25');
    // exam-2 的任務絲毫不受影響
    expect(updated.tasks.find((t) => t.id === 'task-2')?.date).toBe('2026-10-16');
  });

  test('刪除考試 (deleteExam) 連帶清除所屬任務，保留其他考試與任務', () => {
    const updated = reducer(initialState, {
      type: 'deleteExam',
      examId: 'exam-1',
    });

    expect(updated.exams.find((e) => e.id === 'exam-1')).toBeUndefined();
    expect(updated.tasks.find((t) => t.examId === 'exam-1')).toBeUndefined();
    // 依然保留 exam-2 的 task
    expect(updated.tasks.find((t) => t.id === 'task-2')).toBeDefined();
  });

  test('更新偏好設定 (updatePreferences)', () => {
    const updated = reducer(initialState, {
      type: 'updatePreferences',
      patch: { dailyMinutes: 180, restDays: [0, 6] },
    });
    expect(updated.preferences.dailyMinutes).toBe(180);
    expect(updated.preferences.restDays).toEqual([0, 6]);
  });

  test('清空全部資料 (clearAll)', () => {
    const cleared = reducer(initialState, { type: 'clearAll' });
    expect(cleared).toEqual(INITIAL_EMPTY_DATA);
  });

  test('唯一識別碼產生器 (createId)', () => {
    const id1 = createId('task');
    const id2 = createId('task');
    expect(id1.startsWith('task-')).toBe(true);
    expect(id2.startsWith('task-')).toBe(true);
    expect(id1).not.toBe(id2);
  });
});
