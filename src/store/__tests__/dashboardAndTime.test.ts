import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadAppDataFromStorage, saveAppDataToStorage } from '../../storage';
import { DEFAULT_PREFERENCES, reducer } from '../AppStore';
import {
  computeDashboardStats,
  getBehindTasks,
  getOverdueTasks,
  tasksForExam,
} from '../selectors';
import type { AppData, Exam, ISODate, StudyTask } from '../../types/models';
import { diffDays } from '../../utils/date';

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

describe('自由化時間調整與進度儀表板測試 (Dashboard and Time Adjustment Suite)', () => {
  const today: ISODate = '2026-10-13';

  const mockExamA: Exam = {
    id: 'exam-toeic',
    name: '多益英語測驗',
    examDate: '2026-11-20',
    createdAt: '2026-10-10T00:00:00.000Z',
    subjects: [
      {
        id: 'sub-toeic-1',
        name: '聽力測驗',
        familiarity: 2,
        chapters: [{ id: 'ch-1', title: 'Part 1 照片描述' }],
      },
    ],
  };

  const mockExamB: Exam = {
    id: 'exam-calculus',
    name: '期末微積分',
    examDate: '2026-10-27',
    createdAt: '2026-10-10T00:00:00.000Z',
    subjects: [
      {
        id: 'sub-calc-1',
        name: '微分學',
        familiarity: 3,
        chapters: [{ id: 'ch-c1', title: '連鎖律' }],
      },
    ],
  };

  // 任務資料：包含完成、未來、逾期未完成等各類狀態
  const mockTasks: StudyTask[] = [
    // 考試 A: 已完成 (昨天)
    {
      id: 'task-a1',
      examId: 'exam-toeic',
      subjectId: 'sub-toeic-1',
      subjectName: '聽力測驗',
      title: '聽力 Part 1 核心技巧',
      date: '2026-10-12',
      estimatedMinutes: 45,
      actualMinutes: 50,
      timerMinutes: 30,
      status: 'done',
      completedAt: '2026-10-12T15:00:00.000Z',
      kind: 'study',
    },
    // 考試 A: 逾期未完成 (前天)
    {
      id: 'task-a2',
      examId: 'exam-toeic',
      subjectId: 'sub-toeic-1',
      subjectName: '聽力測驗',
      title: '聽力 Part 1 基礎題庫',
      date: '2026-10-11',
      estimatedMinutes: 30,
      actualMinutes: 0,
      status: 'pending',
      kind: 'practice',
    },
    // 考試 A: 今天待完成
    {
      id: 'task-a3',
      examId: 'exam-toeic',
      subjectId: 'sub-toeic-1',
      subjectName: '聽力測驗',
      title: '聽力 Part 1 易混淆單字',
      date: '2026-10-13',
      estimatedMinutes: 25,
      actualMinutes: 10,
      status: 'pending',
      kind: 'study',
    },
    // 考試 B: 未來未完成
    {
      id: 'task-b1',
      examId: 'exam-calculus',
      subjectId: 'sub-calc-1',
      subjectName: '微分學',
      title: '微分連鎖律範例演練',
      date: '2026-10-15',
      estimatedMinutes: 60,
      actualMinutes: 0,
      status: 'pending',
      kind: 'practice',
    },
    // 考試 B: 標記待重新安排
    {
      id: 'task-b2',
      examId: 'exam-calculus',
      subjectId: 'sub-calc-1',
      subjectName: '微分學',
      title: '隱函數微分重點筆記',
      date: '2026-10-10',
      estimatedMinutes: 40,
      actualMinutes: 15,
      status: 'needsReschedule',
      kind: 'review',
    },
  ];

  const baseState: AppData = {
    exams: [mockExamA, mockExamB],
    tasks: mockTasks,
    preferences: DEFAULT_PREFERENCES,
    isDemo: false,
    activeTimer: null,
  };

  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
  });

  describe('第一部分：自由化時間調整 (Custom Time Adjustments)', () => {
    test('1. 預估讀書時間可自由修改為任意分鐘數 (如 13、90、120 分鐘)', () => {
      let state = reducer(baseState, {
        type: 'setTaskMinutes',
        taskId: 'task-a3',
        minutes: 13,
      });

      const updated = state.tasks.find((t) => t.id === 'task-a3');
      expect(updated?.estimatedMinutes).toBe(13);

      state = reducer(state, {
        type: 'setTaskMinutes',
        taskId: 'task-a3',
        minutes: 90,
      });
      expect(state.tasks.find((t) => t.id === 'task-a3')?.estimatedMinutes).toBe(90);
    });

    test('2. 修改預估時間不會錯誤地將任務標記為完成 (保持 pending)', () => {
      const state = reducer(baseState, {
        type: 'setTaskMinutes',
        taskId: 'task-a3',
        minutes: 45,
      });

      const updated = state.tasks.find((t) => t.id === 'task-a3');
      expect(updated?.estimatedMinutes).toBe(45);
      expect(updated?.status).toBe('pending');
      expect(updated?.completedAt).toBeUndefined();
    });

    test('3. 預估時間具備極限邊界保護 (下限 1 分鐘，上限 720 分鐘)', () => {
      // 測試負數輸入
      let state = reducer(baseState, {
        type: 'setTaskMinutes',
        taskId: 'task-a3',
        minutes: -10,
      });
      expect(state.tasks.find((t) => t.id === 'task-a3')?.estimatedMinutes).toBe(1);

      // 測試超大數值
      state = reducer(state, {
        type: 'setTaskMinutes',
        taskId: 'task-a3',
        minutes: 9999,
      });
      expect(state.tasks.find((t) => t.id === 'task-a3')?.estimatedMinutes).toBe(720);
    });

    test('4. 實際研讀時間可自由手動修改，且不強制為 5 的倍數', () => {
      const state = reducer(baseState, {
        type: 'setTaskActualMinutes',
        taskId: 'task-a1',
        minutes: 42,
      });

      const updated = state.tasks.find((t) => t.id === 'task-a1');
      expect(updated?.actualMinutes).toBe(42);
      // 保留計時紀錄與預估時間獨立性
      expect(updated?.estimatedMinutes).toBe(45);
      expect(updated?.timerMinutes).toBe(30);
    });

    test('5. 修改實際研讀時間不會錯誤地將未完成任務改為已完成', () => {
      const state = reducer(baseState, {
        type: 'setTaskActualMinutes',
        taskId: 'task-a3',
        minutes: 60,
      });

      const updated = state.tasks.find((t) => t.id === 'task-a3');
      expect(updated?.actualMinutes).toBe(60);
      expect(updated?.status).toBe('pending');
    });

    test('6. 實際研讀時間不允許負數，負數自動校正為 0', () => {
      const state = reducer(baseState, {
        type: 'setTaskActualMinutes',
        taskId: 'task-a3',
        minutes: -20,
      });

      expect(state.tasks.find((t) => t.id === 'task-a3')?.actualMinutes).toBe(0);
    });

    test('7. 時間修改成功寫入 AsyncStorage 並可重新載入', async () => {
      const state = reducer(baseState, {
        type: 'setTaskMinutes',
        taskId: 'task-b1',
        minutes: 75,
      });

      await saveAppDataToStorage(state);
      const reloaded = await loadAppDataFromStorage();

      expect(reloaded).not.toBeNull();
      const reloadedTask = reloaded?.tasks.find((t) => t.id === 'task-b1');
      expect(reloadedTask?.estimatedMinutes).toBe(75);
    });
  });

  describe('第二部分：進度儀表板 (Progress Dashboard Metrics)', () => {
    test('1. 全體任務完成率與數量統計計算精確', () => {
      const stats = computeDashboardStats(baseState.tasks, today);

      expect(stats.totalCount).toBe(5);
      expect(stats.doneCount).toBe(1);
      // 完成率 1 / 5 = 20%
      expect(stats.completionPercentage).toBe(20);
      expect(stats.completionRatio).toBeCloseTo(0.2);

      // 待完成 (未來含今天: task-a3, task-b1) = 2 項
      expect(stats.pendingCount).toBe(2);

      // 逾期未完成 (過去未完成: task-a2, task-b2) = 2 項
      expect(stats.overdueCount).toBe(2);

      // 標記待重新安排: task-b2 = 1 項
      expect(stats.needsRescheduleCount).toBe(1);
    });

    test('2. 預估研讀時間與實際研讀時間分開統計且能正確對比', () => {
      const stats = computeDashboardStats(baseState.tasks, today);

      // 預估總時間：45 + 30 + 25 + 60 + 40 = 200 分鐘
      expect(stats.totalEstimatedMinutes).toBe(200);

      // 實際研讀時間：50 + 0 + 10 + 0 + 15 = 75 分鐘
      expect(stats.totalActualMinutes).toBe(75);

      // 投入時間與預估時間比率：75 / 200 = 0.375
      expect(stats.timeComparisonRatio).toBeCloseTo(0.375);

      // 時間落差：75 - 200 = -125 分鐘
      expect(stats.timeVarianceMinutes).toBe(-125);

      // 已完成任務對比：task-a1 預估 45 分鐘，實際研讀 50 分鐘
      expect(stats.doneEstimatedMinutes).toBe(45);
      expect(stats.doneActualMinutes).toBe(50);
    });

    test('3. 單一考試過濾與多考試切換統計獨立無干擾', () => {
      const examATasks = tasksForExam(baseState.tasks, 'exam-toeic');
      const statsA = computeDashboardStats(examATasks, today);

      expect(statsA.totalCount).toBe(3);
      expect(statsA.doneCount).toBe(1);
      expect(statsA.completionPercentage).toBe(33); // 1 / 3 = 33%
      expect(statsA.totalEstimatedMinutes).toBe(100); // 45 + 30 + 25
      expect(statsA.totalActualMinutes).toBe(60); // 50 + 0 + 10

      const examBTasks = tasksForExam(baseState.tasks, 'exam-calculus');
      const statsB = computeDashboardStats(examBTasks, today);

      expect(statsB.totalCount).toBe(2);
      expect(statsB.doneCount).toBe(0);
      expect(statsB.completionPercentage).toBe(0);
      expect(statsB.totalEstimatedMinutes).toBe(100); // 60 + 40
      expect(statsB.totalActualMinutes).toBe(15); // 0 + 15
    });

    test('4. 距離各考試剩餘天數計算正確', () => {
      // today: 2026-10-13
      // examA: 2026-11-20 -> diff 38 天
      const daysA = diffDays(today, mockExamA.examDate);
      expect(daysA).toBe(38);

      // examB: 2026-10-27 -> diff 14 天
      const daysB = diffDays(today, mockExamB.examDate);
      expect(daysB).toBe(14);
    });

    test('5. 逾期任務與落後任務篩選精準', () => {
      const overdue = getOverdueTasks(baseState.tasks, today);
      expect(overdue.length).toBe(2);
      expect(overdue.map((t) => t.id)).toEqual(['task-b2', 'task-a2']); // 排序由舊到新

      const behind = getBehindTasks(baseState.tasks, today);
      expect(behind.length).toBe(2);
    });
  });
});
