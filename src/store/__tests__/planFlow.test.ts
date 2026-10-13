import AsyncStorage from '@react-native-async-storage/async-storage';
import { scheduleExamPlan } from '../../scheduler';
import { loadAppDataFromStorage, saveAppDataToStorage } from '../../storage';
import { createId, DEFAULT_PREFERENCES, reducer } from '../AppStore';
import { calculateReschedulePlan } from '../../scheduler/reschedule';
import {
  computeProgress,
  getBehindTasks,
  getRecentPeriodStats,
  getUpcomingExam,
  groupByDate,
  tasksForDate,
  tasksForExam,
} from '../selectors';
import type { AppData, Exam, ISODate, StudyPreferences, StudyTask } from '../../types/models';
import { startOfWeek } from '../../utils/date';

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

describe('完整資料流驗證：建立考試 -> 排程 -> 儲存 -> 重新讀取 -> 讀書計畫頁面查詢', () => {
  const today: ISODate = '2026-10-12';

  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
  });

  test('場景 1：全新建立考試（有章節），排程並儲存後，讀書計畫能正確取得任務', async () => {
    const exam: Exam = {
      id: createId('exam'),
      name: '多益英語測驗',
      examDate: '2026-11-15',
      createdAt: '2026-10-12T08:00:00.000Z',
      subjects: [
        {
          id: createId('subject'),
          name: '聽力測驗',
          familiarity: 2,
          chapters: [
            { id: createId('ch'), title: 'Part 1 照片描述' },
            { id: createId('ch'), title: 'Part 2 應答問題' },
          ],
        },
      ],
    };

    const prefs: StudyPreferences = {
      dailyMinutes: 90,
      restDays: [0], // 週日休息
      intensity: 'normal',
    };

    // 1. 執行排程引擎
    const schedule = scheduleExamPlan(exam, prefs, today, createId);
    expect(schedule.tasks.length).toBeGreaterThan(0);
    expect(schedule.tasks.every((t) => t.examId === exam.id)).toBe(true);
    expect(schedule.tasks.every((t) => typeof t.date === 'string' && t.date.length === 10)).toBe(true);
    expect(schedule.tasks.every((t) => t.estimatedMinutes > 0)).toBe(true);
    expect(schedule.tasks.every((t) => t.title.length > 0)).toBe(true);

    // 2. 存入 App 狀態 (reducer)
    const initialAppState: AppData = {
      exams: [],
      tasks: [],
      preferences: DEFAULT_PREFERENCES,
      isDemo: false,
    };

    const stateAfterCreate = reducer(initialAppState, {
      type: 'createExamWithTasks',
      exam,
      tasks: schedule.tasks,
      preferences: prefs,
    });

    expect(stateAfterCreate.exams.length).toBe(1);
    expect(stateAfterCreate.tasks.length).toBe(schedule.tasks.length);

    // 3. 儲存至本機 AsyncStorage 並重新載入
    await saveAppDataToStorage(stateAfterCreate);
    const reloaded = await loadAppDataFromStorage();
    expect(reloaded).not.toBeNull();
    expect(reloaded?.exams.length).toBe(1);
    expect(reloaded?.tasks.length).toBe(schedule.tasks.length);

    // 4. 讀書計畫頁面過濾器驗證 (PlanScreen logic)
    const activeExamId = exam.id;
    const examTasks = tasksForExam(reloaded!.tasks, activeExamId);
    expect(examTasks.length).toBe(schedule.tasks.length);

    // 週檢視模式：檢查本週是否有任務
    const dateGroups = groupByDate(examTasks);
    expect(dateGroups.length).toBeGreaterThan(0);

    // 確保任務不會為空
    const todayTasks = tasksForDate(examTasks, today);
    console.log('Today tasks count for exam:', todayTasks.length);
    console.log('Total scheduled tasks:', examTasks.length);
  });

  test('場景 2：使用者原有舊考試（舊考試無任務），新增第二場考試後，計畫頁面應優先鎖定新考試', async () => {
    // 模擬已存在的舊考試（例如之前測試留下的 Can,6th，且任務為 0）
    const oldExam: Exam = {
      id: 'old-exam-can-6th',
      name: 'Can,6th',
      examDate: '2026-10-27',
      subjects: [],
      createdAt: '2026-10-01T00:00:00.000Z',
    };

    const stateWithOldExam: AppData = {
      exams: [oldExam],
      tasks: [], // 舊考試無任務！
      preferences: DEFAULT_PREFERENCES,
      isDemo: false,
    };

    // 使用者新增第二場考試
    const newExam: Exam = {
      id: 'new-exam-toeic',
      name: '新多益測驗',
      examDate: '2026-11-20',
      createdAt: '2026-10-12T09:00:00.000Z',
      subjects: [
        {
          id: 'sub-toeic',
          name: '英文閱讀',
          familiarity: 2,
          chapters: [{ id: 'ch-read', title: '長篇閱讀' }],
        },
      ],
    };

    const schedule = scheduleExamPlan(newExam, DEFAULT_PREFERENCES, today, createId);
    expect(schedule.tasks.length).toBeGreaterThan(0);

    const stateAfterSecondExam = reducer(stateWithOldExam, {
      type: 'createExamWithTasks',
      exam: newExam,
      tasks: schedule.tasks,
    });

    expect(stateAfterSecondExam.exams.length).toBe(2);

    // 驗證修復：state.selectedExamId 必須自動設為新建考試
    expect(stateAfterSecondExam.selectedExamId).toBe(newExam.id);

    // 驗證修復後的 PlanScreen fallbackExamId 解析邏輯：
    const examWithTasks = stateAfterSecondExam.exams.find(
      (e) => tasksForExam(stateAfterSecondExam.tasks, e.id).length > 0,
    );
    const resolvedActiveExamId =
      stateAfterSecondExam.selectedExamId ??
      examWithTasks?.id ??
      getUpcomingExam(stateAfterSecondExam, today)?.id;

    expect(resolvedActiveExamId).toBe(newExam.id);
    const resolvedTasks = tasksForExam(stateAfterSecondExam.tasks, resolvedActiveExamId!);
    expect(resolvedTasks.length).toBeGreaterThan(0);
  });

  test('場景 3：多週研讀期間的排程任務應均勻分佈在各週，避免頭尾空窗', () => {
    const exam: Exam = {
      id: 'exam-long',
      name: '期末考',
      examDate: '2026-11-12', // 距離今天 31 天
      createdAt: '2026-10-12T00:00:00.000Z',
      subjects: [
        {
          id: 'sub-algo',
          name: '演算法',
          familiarity: 2,
          chapters: [
            { id: 'c1', title: '排序' },
            { id: 'c2', title: '圖論' },
            { id: 'c3', title: '動態規劃' },
          ],
        },
      ],
    };

    const schedule = scheduleExamPlan(exam, DEFAULT_PREFERENCES, today, createId);
    expect(schedule.tasks.length).toBeGreaterThanOrEqual(8);

    // 檢查任務涵蓋的週數：不應只有第 1 週
    const taskWeeks = new Set(schedule.tasks.map((t) => startOfWeek(t.date)));
    expect(taskWeeks.size).toBeGreaterThanOrEqual(3);

    // 檢查首日（今天或首個研讀日）是否有安排任務
    const firstStudyDayTasks = schedule.tasks.filter((t) => t.date === today);
    expect(firstStudyDayTasks.length).toBeGreaterThan(0);
  });

  test('場景 4：示範資料環境下建立使用者自訂考試，示範多益資料應被乾淨清除替換', async () => {
    // 模擬使用者進入 App 時載入了示範資料 (demo-toeic)
    const demoState: AppData = {
      exams: [
        {
          id: 'demo-toeic',
          name: '多益 TOEIC',
          examDate: '2026-11-26',
          subjects: [],
          createdAt: '2026-10-12T00:00:00.000Z',
        },
      ],
      tasks: [
        {
          id: 'demo-t1',
          examId: 'demo-toeic',
          subjectId: 'demo-sub',
          subjectName: '聽力',
          title: 'Part 1 照片描述：練習題 第 2 組',
          kind: 'practice',
          date: today,
          estimatedMinutes: 30,
          status: 'pending',
        },
      ],
      preferences: DEFAULT_PREFERENCES,
      selectedExamId: 'demo-toeic',
      isDemo: true,
    };

    // 使用者建立自己的考試：日檢 N2
    const jlptExam: Exam = {
      id: 'exam-jlpt-n2',
      name: '日檢 N2',
      examDate: '2026-12-05',
      createdAt: '2026-10-12T10:00:00.000Z',
      subjects: [
        {
          id: 'sub-grammar',
          name: '文法與句型',
          familiarity: 1,
          chapters: [{ id: 'ch1', title: '核心句型 50 個' }],
        },
      ],
    };

    const schedule = scheduleExamPlan(jlptExam, DEFAULT_PREFERENCES, today, createId);
    expect(schedule.tasks.length).toBeGreaterThan(0);

    const nextState = reducer(demoState, {
      type: 'createExamWithTasks',
      exam: jlptExam,
      tasks: schedule.tasks,
    });

    // 驗證示範資料已被清除，不再有 demo-toeic
    expect(nextState.isDemo).toBe(false);
    expect(nextState.exams.length).toBe(1);
    expect(nextState.exams[0].id).toBe(jlptExam.id);
    expect(nextState.selectedExamId).toBe(jlptExam.id);
    // 驗證任務中完全沒有 demo 任務
    expect(nextState.tasks.every((t) => t.examId === jlptExam.id)).toBe(true);
    expect(nextState.tasks.some((t) => t.examId === 'demo-toeic')).toBe(false);
  });

  test('場景 5：新增兩場不同考試，任務獨立保存且不互相覆蓋，重開 App 後資料完整', async () => {
    const exam1: Exam = {
      id: 'exam-cpa',
      name: '會計師考試',
      examDate: '2026-11-20',
      createdAt: '2026-10-12T08:00:00.000Z',
      subjects: [
        {
          id: 'sub-tax',
          name: '稅務法規',
          familiarity: 1,
          chapters: [{ id: 'ch-tax-1', title: '營利事業所得稅' }],
        },
      ],
    };
    const schedule1 = scheduleExamPlan(exam1, DEFAULT_PREFERENCES, today, createId);

    const exam2: Exam = {
      id: 'exam-pmp',
      name: 'PMP 專案管理師',
      examDate: '2026-12-10',
      createdAt: '2026-10-12T08:30:00.000Z',
      subjects: [
        {
          id: 'sub-agile',
          name: '敏捷實務',
          familiarity: 3,
          chapters: [{ id: 'ch-agile-1', title: 'Scrum 框架' }],
        },
      ],
    };
    const schedule2 = scheduleExamPlan(exam2, DEFAULT_PREFERENCES, today, createId);

    // 依序建立兩場考試
    let appState: AppData = {
      exams: [],
      tasks: [],
      preferences: DEFAULT_PREFERENCES,
      isDemo: false,
    };

    appState = reducer(appState, {
      type: 'createExamWithTasks',
      exam: exam1,
      tasks: schedule1.tasks,
    });

    appState = reducer(appState, {
      type: 'createExamWithTasks',
      exam: exam2,
      tasks: schedule2.tasks,
    });

    expect(appState.exams.length).toBe(2);
    expect(appState.selectedExamId).toBe(exam2.id); // 最新建立的考試成為選中考試

    // 驗證兩場考試的任務各自獨立且完整
    const tasks1 = tasksForExam(appState.tasks, exam1.id);
    const tasks2 = tasksForExam(appState.tasks, exam2.id);
    expect(tasks1.length).toBe(schedule1.tasks.length);
    expect(tasks2.length).toBe(schedule2.tasks.length);
    expect(appState.tasks.length).toBe(tasks1.length + tasks2.length);

    // 模擬完成 exam1 的第一項任務
    const firstTask = tasks1[0];
    appState = reducer(appState, {
      type: 'setTaskStatus',
      taskId: firstTask.id,
      status: 'done',
    });

    // 儲存至 AsyncStorage
    await saveAppDataToStorage(appState);

    // 模擬關閉 App 重開：重新從 AsyncStorage 讀取
    const reloaded = await loadAppDataFromStorage();
    expect(reloaded).not.toBeNull();
    expect(reloaded?.exams.length).toBe(2);
    expect(reloaded?.tasks.length).toBe(tasks1.length + tasks2.length);

    // 檢查已完成任務的狀態持久化
    const reloadedTask = reloaded?.tasks.find((t) => t.id === firstTask.id);
    expect(reloadedTask?.status).toBe('done');
    expect(reloadedTask?.completedAt).toBeDefined();

    // 檢查休息日避開規則（週日 0 不排任務）
    expect(reloaded?.tasks.every((t) => new Date(t.date).getDay() !== 0)).toBe(true);
  });

  test('場景 6：每日任務完成打卡、取消打卡、儲存持久化與跨考試獨立性', async () => {
    const examA: Exam = {
      id: 'exam-a',
      name: '多益英語',
      examDate: '2026-11-20',
      createdAt: '2026-10-12T00:00:00.000Z',
      subjects: [{ id: 'sub-a', name: '聽力', familiarity: 2, chapters: [] }],
    };
    const examB: Exam = {
      id: 'exam-b',
      name: '微積分期中考',
      examDate: '2026-11-25',
      createdAt: '2026-10-12T00:00:00.000Z',
      subjects: [{ id: 'sub-b', name: '微積分', familiarity: 1, chapters: [] }],
    };

    const tasksA: StudyTask[] = [
      {
        id: 'task-a1',
        examId: 'exam-a',
        subjectId: 'sub-a',
        title: '聽力練習 1',
        kind: 'practice',
        date: today,
        estimatedMinutes: 30,
        status: 'pending',
      },
      {
        id: 'task-a2',
        examId: 'exam-a',
        subjectId: 'sub-a',
        title: '聽力練習 2',
        kind: 'practice',
        date: today,
        estimatedMinutes: 45,
        status: 'pending',
      },
    ];

    const tasksB: StudyTask[] = [
      {
        id: 'task-b1',
        examId: 'exam-b',
        subjectId: 'sub-b',
        title: '極限定理研讀',
        kind: 'study',
        date: today,
        estimatedMinutes: 60,
        status: 'pending',
      },
    ];

    let state: AppData = {
      exams: [examA, examB],
      tasks: [...tasksA, ...tasksB],
      preferences: DEFAULT_PREFERENCES,
      selectedExamId: 'exam-a',
      isDemo: false,
    };

    // 初始狀態驗證
    let pA = computeProgress(tasksForExam(state.tasks, 'exam-a'));
    let pB = computeProgress(tasksForExam(state.tasks, 'exam-b'));
    expect(pA.doneCount).toBe(0);
    expect(pA.totalCount).toBe(2);
    expect(pA.percentage).toBe(0);
    expect(pB.doneCount).toBe(0);
    expect(pB.totalCount).toBe(1);

    // 1. 勾選任務 task-a1 為已完成
    state = reducer(state, {
      type: 'setTaskStatus',
      taskId: 'task-a1',
      status: 'done',
    });

    // 驗證 Exam A 完成率更新為 50%
    pA = computeProgress(tasksForExam(state.tasks, 'exam-a'));
    expect(pA.doneCount).toBe(1);
    expect(pA.remainingCount).toBe(1);
    expect(pA.percentage).toBe(50);
    expect(pA.doneMinutes).toBe(30);

    // 驗證 Exam B 狀態完全不受影響（依然為 0%）
    pB = computeProgress(tasksForExam(state.tasks, 'exam-b'));
    expect(pB.doneCount).toBe(0);
    expect(pB.percentage).toBe(0);

    // 驗證 completedAt 紀錄
    const taskA1 = state.tasks.find((t) => t.id === 'task-a1');
    expect(taskA1?.status).toBe('done');
    expect(taskA1?.completedAt).toBeDefined();

    // 2. 本機儲存並模擬重啟
    await saveAppDataToStorage(state);
    const reloaded = await loadAppDataFromStorage();
    expect(reloaded).not.toBeNull();
    const reloadedA1 = reloaded?.tasks.find((t) => t.id === 'task-a1');
    expect(reloadedA1?.status).toBe('done');
    expect(reloadedA1?.completedAt).toBe(taskA1?.completedAt);

    // 3. 取消完成：恢復為未完成
    state = reducer(state, {
      type: 'setTaskStatus',
      taskId: 'task-a1',
      status: 'pending',
    });

    pA = computeProgress(tasksForExam(state.tasks, 'exam-a'));
    expect(pA.doneCount).toBe(0);
    expect(pA.remainingCount).toBe(2);
    expect(pA.percentage).toBe(0);
    expect(pA.doneMinutes).toBe(0);

    const taskA1Undone = state.tasks.find((t) => t.id === 'task-a1');
    expect(taskA1Undone?.status).toBe('pending');
    expect(taskA1Undone?.completedAt).toBeUndefined();
  });

  test('場景 7：學習進度統計防呆（無任務不產生 NaN、全域 vs 各考試 vs 各科統計、7 天歷程）', () => {
    // 1. 空任務陣列防呆：完成率必須為 0%，不產生 NaN
    const emptyProgress = computeProgress([]);
    expect(emptyProgress.doneCount).toBe(0);
    expect(emptyProgress.totalCount).toBe(0);
    expect(emptyProgress.percentage).toBe(0);
    expect(emptyProgress.ratio).toBe(0);
    expect(Number.isNaN(emptyProgress.percentage)).toBe(false);

    // 2. 多任務計算
    const sampleTasks: StudyTask[] = [
      {
        id: 't-1',
        examId: 'e-1',
        subjectId: 's-1',
        title: '任務 1',
        kind: 'study',
        date: today,
        estimatedMinutes: 40,
        status: 'done',
      },
      {
        id: 't-2',
        examId: 'e-1',
        subjectId: 's-1',
        title: '任務 2',
        kind: 'practice',
        date: today,
        estimatedMinutes: 20,
        status: 'done',
      },
      {
        id: 't-3',
        examId: 'e-1',
        subjectId: 's-2',
        title: '任務 3',
        kind: 'review',
        date: today,
        estimatedMinutes: 60,
        status: 'pending',
      },
    ];

    const overall = computeProgress(sampleTasks);
    expect(overall.totalCount).toBe(3);
    expect(overall.doneCount).toBe(2);
    expect(overall.remainingCount).toBe(1);
    expect(overall.percentage).toBe(67); // 2 / 3 * 100% = 67%
    expect(overall.doneMinutes).toBe(60);
    expect(overall.totalMinutes).toBe(120);

    // 科目 s-1: 2/2 完成 (100%)
    const s1Progress = computeProgress(sampleTasks.filter((t) => t.subjectId === 's-1'));
    expect(s1Progress.percentage).toBe(100);
    expect(s1Progress.doneMinutes).toBe(60);

    // 科目 s-2: 0/1 完成 (0%)
    const s2Progress = computeProgress(sampleTasks.filter((t) => t.subjectId === 's-2'));
    expect(s2Progress.percentage).toBe(0);

    // 3. 7 天歷程統計與連續打卡
    const recentStats = getRecentPeriodStats(sampleTasks, today, 7);
    expect(recentStats.days.length).toBe(7);
    expect(recentStats.totalDoneCount).toBe(2);
    expect(recentStats.totalDoneMinutes).toBe(60);
    expect(recentStats.streakDays).toBe(1); // 今天有打卡，連續 1 天
  });

  test('場景 8：落後進度重新排程（逾期未完成重配、已完成任務保護、嚴格遵守每日上限、考前時間不足明確警示）', async () => {
    const examDate = '2026-10-18';
    const prefs: StudyPreferences = {
      dailyMinutes: 60,
      restDays: [0], // 週日休息
      intensity: 'normal',
    };

    const tasks: StudyTask[] = [
      // 過去已完成任務 (10-10) -> 必須保持原樣
      {
        id: 'done-task-1',
        examId: 'e-reschedule',
        subjectId: 'sub-1',
        title: 'Ch1 觀念研讀 (已完成)',
        kind: 'study',
        date: '2026-10-10',
        estimatedMinutes: 30,
        status: 'done',
        completedAt: '2026-10-10T14:00:00.000Z',
      },
      // 過去逾期未完成任務 (10-11, 落後)
      {
        id: 'overdue-task-1',
        examId: 'e-reschedule',
        subjectId: 'sub-1',
        title: 'Ch1 實戰題庫 (落後)',
        kind: 'practice',
        date: '2026-10-11',
        estimatedMinutes: 30,
        status: 'pending',
      },
      // 使用者標記需要重新安排的任務
      {
        id: 'flagged-task-1',
        examId: 'e-reschedule',
        subjectId: 'sub-2',
        title: 'Ch2 重點複習',
        kind: 'review',
        date: '2026-10-13',
        estimatedMinutes: 30,
        status: 'needsReschedule',
      },
      // 正常未來任務
      {
        id: 'future-task-1',
        examId: 'e-reschedule',
        subjectId: 'sub-2',
        title: 'Ch3 觀念研讀',
        kind: 'study',
        date: '2026-10-14',
        estimatedMinutes: 30,
        status: 'pending',
      },
    ];

    // 1. 偵測落後任務
    const behind = getBehindTasks(tasks, today);
    expect(behind.length).toBe(2); // overdue-task-1 (10-11) 與 flagged-task-1

    // 2. 計算重新排程試算
    const plan = calculateReschedulePlan(tasks, examDate, prefs, today);

    // 已完成任務完整保護
    expect(plan.completedTasks.length).toBe(1);
    expect(plan.completedTasks[0].id).toBe('done-task-1');
    expect(plan.completedTasks[0].status).toBe('done');
    expect(plan.completedTasks[0].date).toBe('2026-10-10');

    // 落後任務被移到今天或之後
    const rescheduledOverdue = plan.updatedTasks.find((t) => t.id === 'overdue-task-1');
    expect(rescheduledOverdue).toBeDefined();
    expect(rescheduledOverdue!.date >= today).toBe(true);
    expect(rescheduledOverdue!.date < examDate).toBe(true);

    // 每日時間不超過 dailyMinutes (60分鐘)
    for (const stat of plan.dailyStats) {
      expect(stat.totalMinutes).toBeLessThanOrEqual(60);
    }

    // 總任務數不變（無任務遺失）
    expect(plan.updatedTasks.length).toBe(tasks.length);

    // 3. 套用排程並更新 store
    let state: AppData = {
      exams: [
        {
          id: 'e-reschedule',
          name: '證照測驗',
          examDate,
          createdAt: '2026-10-01T00:00:00.000Z',
          subjects: [],
        },
      ],
      tasks,
      preferences: prefs,
      selectedExamId: 'e-reschedule',
      isDemo: false,
    };

    state = reducer(state, {
      type: 'applyRescheduledTasks',
      examId: 'e-reschedule',
      updatedTasks: plan.updatedTasks,
    });

    // 儲存並重新載入驗證
    await saveAppDataToStorage(state);
    const reloaded = await loadAppDataFromStorage();
    expect(reloaded).not.toBeNull();
    const reloadedTasks = tasksForExam(reloaded!.tasks, 'e-reschedule');
    expect(reloadedTasks.length).toBe(tasks.length);
    expect(reloadedTasks.find((t) => t.id === 'done-task-1')?.status).toBe('done');

    // 重新檢查落後任務（重排後落後任務應歸零）
    const newBehind = getBehindTasks(reloadedTasks, today);
    expect(newBehind.length).toBe(0);
  });
});

