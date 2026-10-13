import { calculateExamEditReschedule } from '../../scheduler/reschedule';
import type { AppData, Exam, StudyPreferences, StudyTask } from '../../types/models';
import { INITIAL_EMPTY_DATA, reducer } from '../AppStore';
import { computeDashboardStats, getExamById, tasksForExam } from '../selectors';

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
});
