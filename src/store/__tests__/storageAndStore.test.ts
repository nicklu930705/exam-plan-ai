import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  clearAppDataFromStorage,
  loadAppDataFromStorage,
  safeRestoreAppDataToStorage,
  saveAppDataToStorage,
  DEFAULT_BACKEND_URL,
  getBackendUrlFromStorage,
  saveBackendUrlToStorage,
  ROLLBACK_SNAPSHOT_KEY,
  STORAGE_KEY,
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

  afterEach(() => {
    jest.restoreAllMocks();
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

  describe('安全還原、寫入失敗回復與崩潰自我修復 (Safe Restore & Disaster Recovery)', () => {
    test('安全還原成功流程：寫入快照、寫入主儲存區、通過讀回校驗並清除快照', async () => {
      // 步驟 1：初始資料存入本機
      await saveAppDataToStorage(mockAppData);

      // 步驟 2：準備欲還原的新資料
      const restoredAppData: AppData = {
        exams: [
          {
            ...mockExam,
            id: 'exam-restored',
            name: '學測衝刺',
          },
        ],
        tasks: [
          {
            ...mockTask,
            id: 'task-restored',
            examId: 'exam-restored',
            title: '學測國文歷屆試題',
          },
        ],
        preferences: {
          dailyMinutes: 150,
          restDays: [0, 6],
          intensity: 'intense',
        },
        isDemo: false,
      };

      const result = await safeRestoreAppDataToStorage(restoredAppData);
      expect(result.success).toBe(true);

      // 驗證主儲存區內容為還原後之資料
      const loaded = await loadAppDataFromStorage();
      expect(loaded?.exams[0].id).toBe('exam-restored');
      expect(loaded?.tasks[0].id).toBe('task-restored');
      expect(loaded?.preferences.dailyMinutes).toBe(150);

      // 驗證救援快照已乾淨移除
      const snapshot = await AsyncStorage.getItem(ROLLBACK_SNAPSHOT_KEY);
      expect(snapshot).toBeNull();
    });

    test('寫入主儲存區失敗時：自動觸發 Rollback，將原始資料回復至主儲存區', async () => {
      // 步驟 1：寫入原本的有效資料
      await saveAppDataToStorage(mockAppData);

      const restoredAppData: AppData = {
        exams: [{ ...mockExam, id: 'exam-fail' }],
        tasks: [{ ...mockTask, id: 'task-fail', examId: 'exam-fail' }],
        preferences: DEFAULT_PREFERENCES,
        isDemo: false,
      };

      // 模擬在寫入主儲存區 (STORAGE_KEY) 時發生磁碟 I/O 錯誤
      const originalMultiSet = (AsyncStorage as any).multiSet;
      try {
        (AsyncStorage as any).multiSet = jest.fn(async (keyValuePairs, callback) => {
          const hasExamFail = keyValuePairs.some(
            ([k, v]: [string, string]) => k === STORAGE_KEY && v.includes('exam-fail'),
          );
          if (hasExamFail) {
            throw new Error('磁碟寫入失敗 (Disk Full)');
          }
          return originalMultiSet(keyValuePairs, callback);
        });

        const result = await safeRestoreAppDataToStorage(restoredAppData);
        expect(result.success).toBe(false);
        expect(result.error).toContain('磁碟寫入失敗');

        // 驗證已成功 Rollback：主儲存區依然保留原本的資料
        const loaded = await loadAppDataFromStorage();
        expect(loaded?.exams[0].id).toBe('exam-1');
        expect(loaded?.exams[0].name).toBe('多益英語測驗');
      } finally {
        (AsyncStorage as any).multiSet = originalMultiSet;
      }
    });

    test('讀回校驗失敗（寫入後筆數不符）時：拒絕還原並自動 Rollback 回復原資料', async () => {
      await saveAppDataToStorage(mockAppData);

      const restoredAppData: AppData = {
        exams: [{ ...mockExam, id: 'exam-corrupt' }],
        tasks: [{ ...mockTask, id: 'task-corrupt', examId: 'exam-corrupt' }],
        preferences: DEFAULT_PREFERENCES,
        isDemo: false,
      };

      const originalMultiGet = (AsyncStorage as any).multiGet;
      let getCallCount = 0;
      try {
        (AsyncStorage as any).multiGet = jest.fn(async (keys, callback) => {
          if (keys.includes(STORAGE_KEY)) {
            getCallCount++;
            // 第 2 次讀取為 safeRestoreAppDataToStorage 內部的讀回校驗步驟
            if (getCallCount === 2) {
              const values = [
                [
                  STORAGE_KEY,
                  JSON.stringify({ exams: [], tasks: [], preferences: DEFAULT_PREFERENCES }),
                ],
              ];
              callback && callback(null, values);
              return values;
            }
          }
          return originalMultiGet(keys, callback);
        });

        const result = await safeRestoreAppDataToStorage(restoredAppData);
        expect(result.success).toBe(false);
        expect(result.error).toContain('讀回校驗失敗');
      } finally {
        (AsyncStorage as any).multiGet = originalMultiGet;
      }
    });

    test('中斷自癒：若 App 在還原寫入途中被關閉導致主儲存區損毀，下次啟動自動自救援快照修復', async () => {
      // 模擬先前的有效舊資料被暫存於救援快照
      const validOldDataJson = JSON.stringify(mockAppData);
      await AsyncStorage.setItem(ROLLBACK_SNAPSHOT_KEY, validOldDataJson);

      // 模擬主儲存區在寫入中途遭強制終止，殘留不完整/損毀之 JSON 字串
      await AsyncStorage.setItem(STORAGE_KEY, '{"exams": [{"id": "exam-broken", "nam');

      // 重新開啟 App 呼叫 loadAppDataFromStorage
      const recovered = await loadAppDataFromStorage();
      expect(recovered).not.toBeNull();
      expect(recovered?.exams[0].name).toBe('多益英語測驗');
      expect(recovered?.tasks[0].id).toBe('task-1');

      // 驗證主儲存區已成功自救援快照修復為完整 JSON
      const repairedRaw = await AsyncStorage.getItem(STORAGE_KEY);
      expect(repairedRaw).not.toBeNull();
      const parsedRepaired = JSON.parse(repairedRaw!);
      expect(parsedRepaired.exams[0].name).toBe('多益英語測驗');

      // 驗證救援快照已被清理
      const snapshotAfter = await AsyncStorage.getItem(ROLLBACK_SNAPSHOT_KEY);
      expect(snapshotAfter).toBeNull();
    });

    test('FIFO 佇列寫入保證：連續快速寫入依序執行，不發生競態順序錯亂', async () => {
      const data1: AppData = { ...mockAppData, preferences: { ...mockPreferences, dailyMinutes: 60 } };
      const data2: AppData = { ...mockAppData, preferences: { ...mockPreferences, dailyMinutes: 120 } };

      // 連續呼叫兩次儲存
      const p1 = saveAppDataToStorage(data1);
      const p2 = saveAppDataToStorage(data2);
      const [res1, res2] = await Promise.all([p1, p2]);

      expect(res1).toBe(true);
      expect(res2).toBe(true);

      // 最終資料必定為最後排入佇列的 data2 (120 分鐘)
      const finalData = await loadAppDataFromStorage();
      expect(finalData?.preferences.dailyMinutes).toBe(120);
    });
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

  describe('後端伺服器端點固定與舊版自訂網址清理', () => {
    test('預設後端端點為正式生產 Vercel 網址', async () => {
      expect(DEFAULT_BACKEND_URL).toBe('https://exam-plan-ai-backend-coral.vercel.app');
      const url = await getBackendUrlFromStorage();
      expect(url).toBe('https://exam-plan-ai-backend-coral.vercel.app');
    });

    test('舊版儲存之自訂網址被自動忽略並清理，絕不連線至未知伺服器', async () => {
      // 模擬舊版儲存了惡意或過期的自訂端點
      await AsyncStorage.setItem('@exam_plan_ai:backend_url', 'https://attacker-fake-server.com');

      // 讀取後端端點
      const url = await getBackendUrlFromStorage();
      expect(url).toBe(DEFAULT_BACKEND_URL);

      // 檢查 AsyncStorage 中的舊鍵已被清理
      const remaining = await AsyncStorage.getItem('@exam_plan_ai:backend_url');
      expect(remaining).toBeNull();
    });

    test('saveBackendUrlToStorage 自動清理任何舊有自訂端點', async () => {
      await AsyncStorage.setItem('@exam_plan_ai:backend_url', 'https://custom-domain.com');
      await saveBackendUrlToStorage('https://ignored.com');

      const remaining = await AsyncStorage.getItem('@exam_plan_ai:backend_url');
      expect(remaining).toBeNull();
    });
  });
});
