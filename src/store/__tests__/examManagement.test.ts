import { calculateExamEditReschedule } from '../../scheduler/reschedule';
import { canCreateExam, canUnarchiveExam } from '../../subscription/entitlements';
import type { AppData, Exam, StudyPreferences, StudyTask } from '../../types/models';
import { INITIAL_EMPTY_DATA, reducer } from '../AppStore';
import {
  computeDashboardStats,
  getActiveExamById,
  getActiveExams,
  getArchivedExams,
  getExamById,
  getUpcomingExam,
  tasksForExam,
} from '../selectors';

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

describe('Exam Management (編輯、重新排程、保護歷史紀錄與刪除考試)', () => {
  const today = '2026-10-12';

  const samplePrefs: StudyPreferences = {
    dailyMinutes: 90,
    restDays: [0],
    intensity: 'normal',
  };

  const sampleExam1: Exam = {
    id: 'exam-1',
    name: '微積分期末考',
    examDate: '2026-11-01',
    createdAt: '2026-10-12T00:00:00.000Z',
    subjects: [
      {
        id: 'sub-1',
        name: '微積分',
        familiarity: 2,
        chapters: [
          { id: 'ch-1', title: '極限與連續' },
          { id: 'ch-2', title: '導函數應用' },
        ],
      },
    ],
  };

  const sampleTasks1: StudyTask[] = [
    {
      id: 'task-1',
      examId: 'exam-1',
      subjectId: 'sub-1',
      subjectName: '微積分',
      chapterId: 'ch-1',
      title: '極限與連續：觀念學習',
      kind: 'study',
      date: '2026-10-13',
      estimatedMinutes: 30,
      actualMinutes: 45,
      timerMinutes: 35,
      status: 'done',
      completedAt: '2026-10-13T10:00:00.000Z',
    },
    {
      id: 'task-2',
      examId: 'exam-1',
      subjectId: 'sub-1',
      subjectName: '微積分',
      chapterId: 'ch-2',
      title: '導函數應用：習題實戰',
      kind: 'practice',
      date: '2026-10-14',
      estimatedMinutes: 45,
      actualMinutes: 0,
      status: 'pending',
    },
  ];

  const sampleExam2: Exam = {
    id: 'exam-2',
    name: '多益英語測驗',
    examDate: '2026-11-20',
    createdAt: '2026-10-12T00:00:00.000Z',
    subjects: [
      {
        id: 'sub-2',
        name: '聽力',
        familiarity: 3,
        chapters: [{ id: 'ch-3', title: 'Part 1 照片題' }],
      },
    ],
  };

  const sampleTasks2: StudyTask[] = [
    {
      id: 'task-3',
      examId: 'exam-2',
      subjectId: 'sub-2',
      subjectName: '聽力',
      chapterId: 'ch-3',
      title: 'Part 1 照片題：實戰練習',
      kind: 'study',
      date: '2026-10-15',
      estimatedMinutes: 25,
      status: 'pending',
    },
  ];

  const buildInitialState = (): AppData => ({
    ...INITIAL_EMPTY_DATA,
    exams: [sampleExam1, sampleExam2],
    tasks: [...sampleTasks1, ...sampleTasks2],
    selectedExamId: 'exam-1',
    preferences: samplePrefs,
    subscription: {
      plan: 'pro',
      billingCycle: 'annual',
      status: 'active',
      expiresAt: new Date(Date.now() + 365 * 86400 * 1000).toISOString(),
    },
  });

  // ───── 測試一：修改考試名稱並儲存（非排程變更） ─────
  test('1. 修改考試名稱並儲存：不觸發重新排程，且所有任務與資料完整同步', () => {
    const state = buildInitialState();
    const updatedExam: Exam = {
      ...sampleExam1,
      name: '高等微積分期末考',
    };

    const rescheduleCheck = calculateExamEditReschedule(
      sampleExam1,
      updatedExam,
      sampleTasks1,
      samplePrefs,
      samplePrefs,
      today,
    );

    // 確認演算法判斷此變更不影響排程
    expect(rescheduleCheck.isScheduleAffecting).toBe(false);
    expect(rescheduleCheck.movedTasks.length).toBe(0);
    expect(rescheduleCheck.completedCount).toBe(1);

    // 儲存至 store
    const nextState = reducer(state, {
      type: 'updateExam',
      exam: updatedExam,
    });

    const savedExam = getExamById(nextState, 'exam-1');
    expect(savedExam?.name).toBe('高等微積分期末考');

    // 任務數量與已完成狀態維持原樣
    const tasks = tasksForExam(nextState.tasks, 'exam-1');
    expect(tasks.length).toBe(2);
    expect(tasks.find((t) => t.id === 'task-1')?.status).toBe('done');
    expect(tasks.find((t) => t.id === 'task-2')?.status).toBe('pending');
  });

  // ───── 測試二：修改考試日期並預覽重新排程 ─────
  test('2. 修改考試日期並預覽重新排程：準確識別變更，未完成任務重新分配', () => {
    const updatedExam: Exam = {
      ...sampleExam1,
      examDate: '2026-11-15', // 考試日期延後
    };

    const reschedulePlan = calculateExamEditReschedule(
      sampleExam1,
      updatedExam,
      sampleTasks1,
      samplePrefs,
      samplePrefs,
      today,
    );

    expect(reschedulePlan.isScheduleAffecting).toBe(true);
    // 已完成任務完整保留
    expect(reschedulePlan.completedCount).toBe(1);
    expect(reschedulePlan.completedTasks[0].id).toBe('task-1');
    expect(reschedulePlan.isFeasible).toBe(true);
    expect(reschedulePlan.unassignedTasks.length).toBe(0);

    // 任務總數依然為 2
    expect(reschedulePlan.updatedTasks.length).toBe(2);
  });

  // ───── 測試三：取消重新排程，確認原始資料完全不變 ─────
  test('3. 使用者取消重新排程：store 資料不受任何副作用改動', () => {
    const state = buildInitialState();
    const untouchedState = { ...state };

    const updatedExam: Exam = {
      ...sampleExam1,
      examDate: '2026-11-25',
    };

    // 僅試算預覽，未 dispatch
    const preview = calculateExamEditReschedule(
      sampleExam1,
      updatedExam,
      sampleTasks1,
      samplePrefs,
      samplePrefs,
      today,
    );
    expect(preview.isScheduleAffecting).toBe(true);

    // 原 state 完全不變
    expect(state.exams[0].examDate).toBe(untouchedState.exams[0].examDate);
    expect(state.tasks).toEqual(untouchedState.tasks);
  });

  // ───── 測試四：確認重新排程後已完成任務與實際研讀時間仍然存在 ─────
  test('4. 重新排程後已完成任務之狀態、實際研讀時間、計時累計 100% 保留', () => {
    const state = buildInitialState();
    const updatedExam: Exam = {
      ...sampleExam1,
      examDate: '2026-11-10',
    };

    const newPrefs: StudyPreferences = {
      ...samplePrefs,
      dailyMinutes: 120, // 增加每日讀書時間
    };

    const plan = calculateExamEditReschedule(
      sampleExam1,
      updatedExam,
      sampleTasks1,
      samplePrefs,
      newPrefs,
      today,
    );

    const nextState = reducer(state, {
      type: 'updateExam',
      exam: updatedExam,
      updatedTasks: plan.updatedTasks,
      preferencesPatch: newPrefs,
    });

    const completedTask = nextState.tasks.find((t) => t.id === 'task-1');
    expect(completedTask).toBeDefined();
    expect(completedTask?.status).toBe('done');
    expect(completedTask?.actualMinutes).toBe(45);
    expect(completedTask?.timerMinutes).toBe(35);
    expect(completedTask?.completedAt).toBe('2026-10-13T10:00:00.000Z');
    expect(completedTask?.date).toBe('2026-10-13'); // 已完成日期維持原日
  });

  // ───── 測試五：新增科目章節，新任務自動納入排程 ─────
  test('5. 編輯考試新增章節：自動為新章節建立待讀任務並分派日期', () => {
    const updatedExam: Exam = {
      ...sampleExam1,
      subjects: [
        {
          ...sampleExam1.subjects[0],
          chapters: [
            ...sampleExam1.subjects[0].chapters,
            { id: 'ch-new', title: '不定積分技法' },
          ],
        },
      ],
    };

    const plan = calculateExamEditReschedule(
      sampleExam1,
      updatedExam,
      sampleTasks1,
      samplePrefs,
      samplePrefs,
      today,
    );

    expect(plan.newTasksCount).toBe(1);
    expect(plan.updatedTasks.length).toBe(3);
    const newTask = plan.updatedTasks.find((t) => t.chapterId === 'ch-new');
    expect(newTask).toBeDefined();
    expect(newTask?.status).toBe('pending');
    expect(newTask?.estimatedMinutes).toBeGreaterThan(0);
  });

  // ───── 測試六：刪除章節，未完成任務移除但已完成紀錄保留 ─────
  test('6. 刪除章節時：僅移除未完成任務，已完成章節任務永久保留歷史', () => {
    const updatedExam: Exam = {
      ...sampleExam1,
      subjects: [
        {
          ...sampleExam1.subjects[0],
          // 刪除了 ch-1（已完成）與 ch-2（未完成）中的 ch-2
          chapters: [{ id: 'ch-1', title: '極限與連續' }],
        },
      ],
    };

    const plan = calculateExamEditReschedule(
      sampleExam1,
      updatedExam,
      sampleTasks1,
      samplePrefs,
      samplePrefs,
      today,
    );

    expect(plan.removedTasksCount).toBe(1); // ch-2 未完成任務被移除
    expect(plan.completedCount).toBe(1); // ch-1 已完成任務被保留
    expect(plan.updatedTasks.length).toBe(1);
    expect(plan.updatedTasks[0].id).toBe('task-1');
  });

  // ───── 測試七：刪除考試並確認相關頁面同步更新 ─────
  test('7. 刪除考試：清空該考試所有任務、重設 selectedExamId 並清理進行中的計時器', () => {
    const state = buildInitialState();
    // 模擬正在對 exam-1 的任務計時中
    const timingState: AppData = {
      ...state,
      activeTimer: {
        taskId: 'task-2',
        taskTitle: '導函數應用：習題實戰',
        examId: 'exam-1',
        startedAt: Date.now(),
        accumulatedSeconds: 120,
        isRunning: true,
      },
    };

    const nextState = reducer(timingState, {
      type: 'deleteExam',
      examId: 'exam-1',
    });

    // exam-1 已被刪除
    expect(nextState.exams.length).toBe(1);
    expect(nextState.exams[0].id).toBe('exam-2');

    // exam-1 的所有任務被清除
    expect(nextState.tasks.every((t) => t.examId !== 'exam-1')).toBe(true);
    expect(nextState.tasks.length).toBe(1);
    expect(nextState.tasks[0].examId).toBe('exam-2');

    // selectedExamId 自動切換至剩餘的 exam-2
    expect(nextState.selectedExamId).toBe('exam-2');

    // 進行中的計時器因所屬考試被刪除而安全重設為 null
    expect(nextState.activeTimer).toBeNull();
  });

  // ───── 測試八：多個考試隔離性（互不混淆） ─────
  test('8. 多場考試的新增、編輯與刪除彼此獨立隔離', () => {
    const state = buildInitialState();

    // 編輯 exam-2 的名稱
    const updatedExam2: Exam = { ...sampleExam2, name: '多益高分衝刺班' };
    const stateAfterEdit = reducer(state, {
      type: 'updateExam',
      exam: updatedExam2,
    });

    // 驗證 exam-1 完全未受影響
    expect(getExamById(stateAfterEdit, 'exam-1')?.name).toBe('微積分期末考');
    expect(tasksForExam(stateAfterEdit.tasks, 'exam-1').length).toBe(2);

    // 刪除 exam-2
    const stateAfterDelete = reducer(stateAfterEdit, {
      type: 'deleteExam',
      examId: 'exam-2',
    });

    expect(stateAfterDelete.exams.length).toBe(1);
    expect(getExamById(stateAfterDelete, 'exam-1')).toBeDefined();
    expect(tasksForExam(stateAfterDelete.tasks, 'exam-1').length).toBe(2);
  });

  // ───── 測試九：封存與解除封存功能 ─────
  test('9. 封存與解除封存考試：標記狀態切換，歷史資料完整保留', () => {
    const state = buildInitialState();

    // 封存 exam-1
    const archivedState = reducer(state, {
      type: 'toggleArchiveExam',
      examId: 'exam-1',
    });
    expect(archivedState.exams.find((e) => e.id === 'exam-1')?.archived).toBe(true);
    expect(tasksForExam(archivedState.tasks, 'exam-1').length).toBe(2);

    // 解除封存 exam-1
    const unarchivedState = reducer(archivedState, {
      type: 'toggleArchiveExam',
      examId: 'exam-1',
    });
    expect(unarchivedState.exams.find((e) => e.id === 'exam-1')?.archived).toBe(false);
  });

  // ───── 測試十：原有進度儀表板統計依然精確 ─────
  test('10. 編輯考試後儀表板統計數值正確連動', () => {
    const state = buildInitialState();
    const statsBefore = computeDashboardStats(tasksForExam(state.tasks, 'exam-1'), today);
    expect(statsBefore.doneCount).toBe(1);
    expect(statsBefore.totalCount).toBe(2);
    expect(statsBefore.completionPercentage).toBe(50);
  });

  // ───── 測試十一：封存考試自動重新評估 selectedExamId ─────
  test('11. 封存當前選取的考試時，selectedExamId 自動切換至其他進行中考試；全封存時為 undefined', () => {
    const state = buildInitialState(); // 包含 exam-1 (selected), exam-2
    expect(state.selectedExamId).toBe('exam-1');

    // 封存 exam-1
    const state1 = reducer(state, {
      type: 'toggleArchiveExam',
      examId: 'exam-1',
    });
    // selectedExamId 應自動切換至剩餘的進行中考試 exam-2
    expect(state1.selectedExamId).toBe('exam-2');

    // 再封存 exam-2（此時所有考試皆已封存）
    const state2 = reducer(state1, {
      type: 'toggleArchiveExam',
      examId: 'exam-2',
    });
    // 所有考試封存後，selectedExamId 應安全變為 undefined，不保留已封存考試
    expect(state2.selectedExamId).toBeUndefined();

    // 解除封存 exam-1（原本無選取考試）
    const state3 = reducer(state2, {
      type: 'toggleArchiveExam',
      examId: 'exam-1',
    });
    // 解除封存後，自動重新選取該考試
    expect(state3.selectedExamId).toBe('exam-1');
  });

  // ───── 測試十二：封存考試安全清理計時器但完整保留計時分鐘與歷史 ─────
  test('12. 封存考試時正在計時的任務安全停止計時，任務累計之 actualMinutes 與 timerMinutes 完整保留', () => {
    const state = buildInitialState();
    const timingState: AppData = {
      ...state,
      activeTimer: {
        taskId: 'task-1',
        taskTitle: '極限與連續：觀念學習',
        examId: 'exam-1',
        startedAt: Date.now() - 30000,
        accumulatedSeconds: 60,
        isRunning: true,
      },
    };

    const archivedState = reducer(timingState, {
      type: 'toggleArchiveExam',
      examId: 'exam-1',
    });

    // 計時器安全清除，不持續於背景運行
    expect(archivedState.activeTimer).toBeNull();

    // 歷史研讀時間與任務資料毫髮無傷
    const task1 = archivedState.tasks.find((t) => t.id === 'task-1');
    expect(task1?.actualMinutes).toBe(45);
    expect(task1?.timerMinutes).toBe(35);
    expect(task1?.status).toBe('done');
  });

  // ───── 測試十三：Free 會員配額限制（canCreateExam 與 canUnarchiveExam） ─────
  test('13. Free 免費版嚴格限制 1 場進行中考試，封存不佔額度，解除封存受限額約束', () => {
    // 建立 1 場進行中考試的 Free 狀態
    const freeState: AppData = {
      ...INITIAL_EMPTY_DATA,
      exams: [sampleExam1],
      tasks: sampleTasks1,
      selectedExamId: 'exam-1',
      subscription: { plan: 'free', billingCycle: 'none', status: 'active' },
    };

    // 1 場進行中：不允許建立新考試
    const createCheck1 = canCreateExam(freeState);
    expect(createCheck1.allowed).toBe(false);
    expect(createCheck1.currentActiveCount).toBe(1);

    // 封存該考試
    const archivedFreeState = reducer(freeState, {
      type: 'toggleArchiveExam',
      examId: 'exam-1',
    });
    expect(archivedFreeState.exams[0].archived).toBe(true);

    // 0 場進行中：允許建立新考試
    const createCheck2 = canCreateExam(archivedFreeState);
    expect(createCheck2.allowed).toBe(true);
    expect(createCheck2.currentActiveCount).toBe(0);

    // 0 場進行中：允許解除封存舊考試
    const unarchiveCheck1 = canUnarchiveExam(archivedFreeState);
    expect(unarchiveCheck1.allowed).toBe(true);

    // 模擬已新建一場進行中考試（此時有 1 場進行中 + 1 場已封存）
    const twoExamsFreeState: AppData = {
      ...archivedFreeState,
      exams: [sampleExam1, sampleExam2], // sampleExam1 已封存，sampleExam2 進行中
    };
    const unarchiveCheck2 = canUnarchiveExam(twoExamsFreeState);
    // 已有 1 場進行中：解除封存被阻擋！
    expect(unarchiveCheck2.allowed).toBe(false);
    expect(unarchiveCheck2.reason).toContain('免費版');
  });

  // ───── 測試十四：selectors 嚴格排除已封存考試 ─────
  test('14. getUpcomingExam、getActiveExams、getArchivedExams 與 getActiveExamById 排除已封存考試', () => {
    const state = buildInitialState();
    // 封存 exam-1（2026-11-01，原本是最早到來的考試）
    const archivedState = reducer(state, {
      type: 'toggleArchiveExam',
      examId: 'exam-1',
    });

    // getUpcomingExam 絕不可回傳已封存的 exam-1，應回傳進行中的 exam-2 (2026-11-20)
    const upcoming = getUpcomingExam(archivedState, today);
    expect(upcoming?.id).toBe('exam-2');

    // getActiveExams 僅回傳進行中考試
    const active = getActiveExams(archivedState);
    expect(active.length).toBe(1);
    expect(active[0].id).toBe('exam-2');

    // getArchivedExams 回傳封存考試
    const archived = getArchivedExams(archivedState);
    expect(archived.length).toBe(1);
    expect(archived[0].id).toBe('exam-1');

    // getActiveExamById 對已封存考試回傳 undefined
    expect(getActiveExamById(archivedState, 'exam-1')).toBeUndefined();
    expect(getActiveExamById(archivedState, 'exam-2')?.id).toBe('exam-2');
  });

  // ───── 測試十五：實機測試使用者完整復現情境 ─────
  test('15. 實機情境驗證：封存「鬧鬧鬧」後新增「期末考」，進行中考試完全切換，絕不殘留舊目標', () => {
    const naonaonaoExam: Exam = {
      id: 'exam-naonaonao',
      name: '鬧鬧鬧',
      examDate: '2026-10-30',
      createdAt: '2026-10-12T00:00:00.000Z',
      subjects: [
        {
          id: 'sub-nao',
          name: '國文',
          familiarity: 2,
          chapters: [{ id: 'ch-nao', title: '第一課' }],
        },
      ],
    };

    const naoTasks: StudyTask[] = [
      {
        id: 'task-nao',
        examId: 'exam-naonaonao',
        subjectId: 'sub-nao',
        subjectName: '國文',
        title: '第一課：複習',
        kind: 'study',
        date: today,
        estimatedMinutes: 30,
        actualMinutes: 20,
        status: 'done',
      },
    ];

    // 步驟 1: Free 使用者只有「鬧鬧鬧」
    let userState: AppData = {
      ...INITIAL_EMPTY_DATA,
      exams: [naonaonaoExam],
      tasks: naoTasks,
      selectedExamId: 'exam-naonaonao',
      subscription: { plan: 'free', billingCycle: 'none', status: 'active' },
    };

    // 步驟 2: 點選新增考試，達到上限
    expect(canCreateExam(userState).allowed).toBe(false);

    // 步驟 3 & 4: 封存「鬧鬧鬧」
    userState = reducer(userState, {
      type: 'toggleArchiveExam',
      examId: 'exam-naonaonao',
    });
    expect(userState.exams[0].archived).toBe(true);
    expect(userState.selectedExamId).toBeUndefined();

    // 步驟 5: 封存後可順利建立新考試「期末考」
    expect(canCreateExam(userState).allowed).toBe(true);

    const finalExam: Exam = {
      id: 'exam-final',
      name: '期末考',
      examDate: '2026-11-25',
      createdAt: '2026-10-16T00:00:00.000Z',
      subjects: [
        {
          id: 'sub-final',
          name: '數學',
          familiarity: 3,
          chapters: [{ id: 'ch-final', title: '空間幾何' }],
        },
      ],
    };

    const finalTasks: StudyTask[] = [
      {
        id: 'task-final',
        examId: 'exam-final',
        subjectId: 'sub-final',
        subjectName: '數學',
        title: '空間幾何：概念研讀',
        kind: 'study',
        date: today,
        estimatedMinutes: 45,
        status: 'pending',
      },
    ];

    userState = reducer(userState, {
      type: 'createExamWithTasks',
      exam: finalExam,
      tasks: finalTasks,
    });

    // 步驟 6 驗證：
    // - 總考試數為 2（鬧鬧鬧 1 + 期末考 1）
    expect(userState.exams.length).toBe(2);
    // - selectedExamId 自動成為剛建立的「期末考」
    expect(userState.selectedExamId).toBe('exam-final');
    // - 進行中的考試僅有「期末考」
    const activeExams = getActiveExams(userState);
    expect(activeExams.length).toBe(1);
    expect(activeExams[0].name).toBe('期末考');
    // - upcomingExam 為「期末考」
    expect(getUpcomingExam(userState, today)?.name).toBe('期末考');
    // - 今日進行中任務僅有「期末考」的任務
    const activeIds = new Set(activeExams.map((e) => e.id));
    const activeTodayTasks = userState.tasks.filter((t) => activeIds.has(t.examId));
    expect(activeTodayTasks.length).toBe(1);
    expect(activeTodayTasks[0].title).toBe('空間幾何：概念研讀');
    // -「鬧鬧鬧」的歷史紀錄、完成任務完全健在
    const archivedTasks = tasksForExam(userState.tasks, 'exam-naonaonao');
    expect(archivedTasks.length).toBe(1);
    expect(archivedTasks[0].actualMinutes).toBe(20);
    expect(archivedTasks[0].status).toBe('done');
  });

  test('10. 資料層防護：Free 會員已有一場進行中考試時，reducer 直接拒絕解除封存第二場考試', () => {
    const activeExam: Exam = {
      id: 'exam-active',
      name: '進行中考試',
      examDate: '2026-11-01',
      createdAt: '2026-10-01T00:00:00.000Z',
      subjects: [],
      archived: false,
    };
    const archivedExam: Exam = {
      id: 'exam-archived',
      name: '已封存考試',
      examDate: '2026-12-01',
      createdAt: '2026-10-01T00:00:00.000Z',
      subjects: [],
      archived: true,
    };

    const state: AppData = {
      ...INITIAL_EMPTY_DATA,
      exams: [activeExam, archivedExam],
      subscription: { plan: 'free', billingCycle: 'none', status: 'none' },
    };

    // 嘗試在資料層解除封存已封存考試
    const nextState = reducer(state, {
      type: 'toggleArchiveExam',
      examId: 'exam-archived',
    });

    // 驗證 reducer 拒絕變更，依然維持原狀
    expect(nextState.exams.find((e) => e.id === 'exam-archived')?.archived).toBe(true);
    expect(getActiveExams(nextState).length).toBe(1);
    expect(getActiveExams(nextState)[0].id).toBe('exam-active');
  });
});
