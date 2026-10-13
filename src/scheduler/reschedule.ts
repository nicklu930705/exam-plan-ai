import type { Exam, ISODate, StudyPreferences, StudyTask } from '../types/models';
import { addDays, formatMinutes } from '../utils/date';
import { getAvailableStudyDates } from './index';
import { calculateSingleTaskPriority } from './priority';

export interface TaskDateChange {
  taskId: string;
  taskTitle: string;
  subjectId: string;
  oldDate: ISODate;
  newDate: ISODate;
  estimatedMinutes: number;
}

export interface DayRescheduleStats {
  date: ISODate;
  taskCount: number;
  totalMinutes: number;
  limitMinutes: number;
}

export interface LoadComparison {
  date: ISODate;
  beforeMinutes: number;
  afterMinutes: number;
  limitMinutes: number;
  beforeCount: number;
  afterCount: number;
}

export interface RescheduleOptions {
  /** 是否從明日起重新安排（例如今日已晚或無法再讀書） */
  startFromTomorrow?: boolean;
  /** 所屬考試（提供時將啟用智慧個人化優先度排程，優先排入重要弱科與迫切考試） */
  exam?: Exam;
  /** 所有考試清單（用於多考科權衡） */
  allExams?: Exam[];
}

export interface ReschedulePlan {
  completedTasks: StudyTask[];
  updatedTasks: StudyTask[];
  changedTasks: TaskDateChange[];
  unchangedCount: number;
  unassignedTasks: StudyTask[];
  unassignedMinutes: number;
  dailyStats: DayRescheduleStats[];
  dailyLimitMinutes: number;
  isFeasible: boolean;
  remainingAvailableMinutes: number;
  unfinishedRequiredMinutes: number;
  deficitMinutes: number;
  remainingStudyDays: number;
  behindTasksCount: number;
  loadComparisons?: LoadComparison[];
  warning?: string;
  suggestions?: string[];
}

/**
 * 重新排程演算法
 * 保留所有已完成任務，只針對未完成任務依照剩餘可用日期與每天可用額度重新配置。
 * 嚴格遵守：
 * 1. 已完成任務原樣保留，不重新安排。
 * 2. 任務絕不得排在考試當天或考試之後。
 * 3. 任何一天都不得超過每日讀書時間上限。
 * 4. 時間不足時明確列出無法安排的任務與短少時間，絕不默默刪除任何任務。
 */
export function calculateReschedulePlan(
  allExamTasks: StudyTask[],
  examDate: ISODate,
  preferences: StudyPreferences,
  today: ISODate,
  options?: RescheduleOptions,
): ReschedulePlan {
  const { dailyMinutes, restDays, intensity } = preferences;
  const effectiveDailyLimit = Math.max(
    15,
    Math.floor(dailyMinutes * (intensity === 'light' ? 0.8 : 1.0)),
  );

  // 1. 分離已完成與未完成任務（已完成任務絕對不可改動或刪除）
  const completedTasks = allExamTasks.filter((t) => t.status === 'done');
  const unfinishedTasks = allExamTasks.filter((t) => t.status !== 'done');
  const behindTasks = allExamTasks.filter(
    (t) => t.status === 'needsReschedule' || (t.status === 'pending' && t.date < today),
  );

  // 2. 取得起始讀書日（今日或明日）起至考前一天的所有可用讀書日（自動排除休息日，絕不含考試當天及之後）
  const startDate = options?.startFromTomorrow ? addDays(today, 1) : today;
  const availableDates = getAvailableStudyDates(startDate, examDate, restDays);

  const unfinishedRequiredMinutes = unfinishedTasks.reduce(
    (sum, t) => sum + t.estimatedMinutes,
    0,
  );
  const remainingAvailableMinutes = availableDates.length * effectiveDailyLimit;
  const deficitMinutes = Math.max(0, unfinishedRequiredMinutes - remainingAvailableMinutes);

  if (availableDates.length === 0) {
    return {
      completedTasks,
      updatedTasks: allExamTasks,
      changedTasks: [],
      unchangedCount: allExamTasks.length,
      unassignedTasks: unfinishedTasks,
      unassignedMinutes: unfinishedRequiredMinutes,
      dailyStats: [],
      dailyLimitMinutes: effectiveDailyLimit,
      isFeasible: false,
      remainingAvailableMinutes: 0,
      unfinishedRequiredMinutes,
      deficitMinutes: unfinishedRequiredMinutes,
      remainingStudyDays: 0,
      behindTasksCount: behindTasks.length,
      loadComparisons: [],
      warning: '考前已無可用的讀書日（請確認考試日期是否在今天之後，或在設定中調整休息日）。',
      suggestions: ['延後考試日期', '取消或減少每週休息日'],
    };
  }

  // 3. 排序未完成任務：
  // 若傳入考試設定，啟用智慧優先級引擎（高優先度章節優先排入最早可用日期）
  // 否則維持原先：落後或標記重新排程者優先，接著依原預定日期及標題排序
  const sortedUnfinished = [...unfinishedTasks].sort((a, b) => {
    if (options?.exam) {
      const prioA = calculateSingleTaskPriority(
        a,
        options.exam,
        options.allExams ?? [options.exam],
        preferences,
        today,
      );
      const prioB = calculateSingleTaskPriority(
        b,
        options.exam,
        options.allExams ?? [options.exam],
        preferences,
        today,
      );
      if (prioB.score !== prioA.score) {
        return prioB.score - prioA.score;
      }
    }
    const aOverdue = a.status === 'needsReschedule' || a.date < today;
    const bOverdue = b.status === 'needsReschedule' || b.date < today;
    if (aOverdue && !bOverdue) return -1;
    if (!aOverdue && bOverdue) return 1;
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.title.localeCompare(b.title);
  });

  // 4. 配置到可用日期（每日負載均勻分配，嚴格不得超過 effectiveDailyLimit）
  const dailyLoads = new Map<ISODate, number>();
  for (const d of availableDates) {
    dailyLoads.set(d, 0);
  }

  const rescheduledUnfinished: StudyTask[] = [];
  const unassignedTasks: StudyTask[] = [];
  const changes: TaskDateChange[] = [];
  let unchangedCount = 0;

  for (const task of sortedUnfinished) {
    // 尋找目前累積負載最低且塞得下（加上後不超過每日讀書時間上限）的可用日期
    let targetDate: ISODate | null = null;
    let minLoad = Infinity;

    for (const d of availableDates) {
      const currentLoad = dailyLoads.get(d) ?? 0;
      if (currentLoad + task.estimatedMinutes <= effectiveDailyLimit) {
        if (currentLoad < minLoad) {
          minLoad = currentLoad;
          targetDate = d;
        }
      }
    }

    if (targetDate) {
      dailyLoads.set(targetDate, (dailyLoads.get(targetDate) ?? 0) + task.estimatedMinutes);

      const updatedTask: StudyTask = {
        ...task,
        date: targetDate,
        status: 'pending',
      };
      rescheduledUnfinished.push(updatedTask);

      if (task.date !== targetDate || task.status === 'needsReschedule') {
        changes.push({
          taskId: task.id,
          taskTitle: task.title,
          subjectId: task.subjectId,
          oldDate: task.date,
          newDate: targetDate,
          estimatedMinutes: task.estimatedMinutes,
        });
      } else {
        unchangedCount++;
      }
    } else {
      // 考前剩餘天數在每日上限限制下已無法容納此任務
      unassignedTasks.push(task);
      // 任務絕不刪除，完整保留在任務清單中，並標記需要調整
      rescheduledUnfinished.push({
        ...task,
        status: 'needsReschedule',
      });
    }
  }

  // 5. 彙整每日任務數與時間統計（供預覽確認符合上限規範）
  const dailyStats: DayRescheduleStats[] = availableDates.map((date) => {
    const dayTasks = rescheduledUnfinished.filter(
      (t) => t.date === date && !unassignedTasks.some((u) => u.id === t.id),
    );
    return {
      date,
      taskCount: dayTasks.length,
      totalMinutes: dailyLoads.get(date) ?? 0,
      limitMinutes: effectiveDailyLimit,
    };
  });

  // 合併已完成與重新排程任務，依日期排序（總數保證等於原始任務數）
  const updatedTasks = [...completedTasks, ...rescheduledUnfinished].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.title.localeCompare(b.title);
  });

  const unassignedMinutes = unassignedTasks.reduce((sum, t) => sum + t.estimatedMinutes, 0);
  const isFeasible = unassignedTasks.length === 0 && availableDates.length > 0;

  // 6. 計算重新排程前後的每日負荷對比
  const beforeLoads = new Map<ISODate, { count: number; minutes: number }>();
  for (const t of allExamTasks) {
    if (t.status !== 'done') {
      const curr = beforeLoads.get(t.date) ?? { count: 0, minutes: 0 };
      beforeLoads.set(t.date, {
        count: curr.count + 1,
        minutes: curr.minutes + t.estimatedMinutes,
      });
    }
  }

  const allComparedDates = Array.from(
    new Set([...availableDates, ...Array.from(beforeLoads.keys())]),
  )
    .filter((d) => d >= today && d < examDate)
    .sort();

  const loadComparisons: LoadComparison[] = allComparedDates.map((date) => {
    const before = beforeLoads.get(date) ?? { count: 0, minutes: 0 };
    const afterMinutes = dailyLoads.get(date) ?? 0;
    const afterCount = rescheduledUnfinished.filter(
      (t) => t.date === date && !unassignedTasks.some((u) => u.id === t.id),
    ).length;

    return {
      date,
      beforeMinutes: before.minutes,
      afterMinutes,
      limitMinutes: effectiveDailyLimit,
      beforeCount: before.count,
      afterCount,
    };
  });

  const plan: ReschedulePlan = {
    completedTasks,
    updatedTasks,
    changedTasks: changes,
    unchangedCount,
    unassignedTasks,
    unassignedMinutes,
    dailyStats,
    dailyLimitMinutes: effectiveDailyLimit,
    isFeasible,
    remainingAvailableMinutes,
    unfinishedRequiredMinutes,
    deficitMinutes,
    remainingStudyDays: availableDates.length,
    behindTasksCount: behindTasks.length,
    loadComparisons,
  };

  if (!isFeasible) {
    if (unassignedTasks.length > 0) {
      plan.warning = `考前剩餘時間不足！未完成任務需 ${formatMinutes(unfinishedRequiredMinutes)}，考前可用上限僅 ${formatMinutes(remainingAvailableMinutes)}。共有 ${unassignedTasks.length} 項任務（共 ${formatMinutes(unassignedMinutes)}）超出每日 ${formatMinutes(effectiveDailyLimit)} 上限無法排入。`;
    } else {
      plan.warning = '考前剩餘時間較為吃緊，已竭力為您安排任務。';
    }
    plan.suggestions = [
      '在「設定」中增加每日可讀書時間（例如調高 30～60 分鐘）',
      '減少每週休息日天數，釋出更多考前可用天數',
      '在「讀書計畫」手動刪除或縮減部分次要任務時間',
    ];
  }

  return plan;
}

export interface ExamEditRescheduleResult {
  isScheduleAffecting: boolean;
  completedTasks: StudyTask[];
  updatedTasks: StudyTask[];
  completedCount: number;
  movedTasks: TaskDateChange[];
  newTasksCount: number;
  removedTasksCount: number;
  unchangedCount: number;
  unassignedTasks: StudyTask[];
  unassignedMinutes: number;
  deficitMinutes: number;
  isFeasible: boolean;
  remainingStudyDays: number;
  warning?: string;
  suggestions?: string[];
}

/**
 * 編輯考試排程影響評估與重新排程運算
 * 嚴格遵循：
 * 1. 若只改動考試名稱等非排程欄位，不觸發重新排程。
 * 2. 100% 保留已完成任務的狀態、計時累計與實際研讀時間。
 * 3. 刪除的章節只移除尚未完成的任務，保留已完成歷史紀錄。
 * 4. 新增的章節自動生成待讀任務並納入分配。
 * 5. 嚴格遵守每日可用讀書時間上限、每週休息日與考試日期邊界。
 */
export function calculateExamEditReschedule(
  originalExam: Exam,
  updatedExam: Exam,
  existingTasks: StudyTask[],
  originalPrefs: StudyPreferences,
  updatedPrefs: StudyPreferences,
  today: ISODate,
  idGenerator: (prefix: string) => string = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 9)}`,
): ExamEditRescheduleResult {
  const dateChanged = originalExam.examDate !== updatedExam.examDate;
  const prefsChanged =
    originalPrefs.dailyMinutes !== updatedPrefs.dailyMinutes ||
    originalPrefs.intensity !== updatedPrefs.intensity ||
    JSON.stringify([...originalPrefs.restDays].sort()) !==
      JSON.stringify([...updatedPrefs.restDays].sort());

  // 檢查科目與章節變更
  const origChapterMap = new Map<string, string>(); // chapterId -> title
  for (const sub of originalExam.subjects) {
    for (const c of sub.chapters) {
      origChapterMap.set(c.id, c.title);
    }
  }

  const updatedChapterMap = new Map<string, string>();
  for (const sub of updatedExam.subjects) {
    for (const c of sub.chapters) {
      updatedChapterMap.set(c.id, c.title);
    }
  }

  const origFamMap = new Map<string, number>();
  originalExam.subjects.forEach((s) => origFamMap.set(s.id, s.familiarity));
  const famChanged = updatedExam.subjects.some(
    (s) => origFamMap.has(s.id) && origFamMap.get(s.id) !== s.familiarity,
  );

  let chaptersChanged = false;
  // 檢查是否有章節被刪除或新增
  for (const id of origChapterMap.keys()) {
    if (!updatedChapterMap.has(id)) {
      chaptersChanged = true;
      break;
    }
  }
  if (!chaptersChanged) {
    for (const id of updatedChapterMap.keys()) {
      if (!origChapterMap.has(id)) {
        chaptersChanged = true;
        break;
      }
    }
  }

  const isScheduleAffecting = dateChanged || prefsChanged || famChanged || chaptersChanged;

  // 1. 保留所有已完成任務（絕對不可變更其狀態、計時或日期）
  const completedTasks = existingTasks.filter((t) => t.status === 'done');
  const unfinishedTasks = existingTasks.filter((t) => t.status !== 'done');

  // 若完全未影響排程（例如僅修改考試名稱或科目名稱）
  if (!isScheduleAffecting) {
    const updatedTasks = existingTasks.map((t) => {
      const sub = updatedExam.subjects.find((s) => s.id === t.subjectId);
      return {
        ...t,
        subjectName: sub?.name ?? t.subjectName,
      };
    });

    return {
      isScheduleAffecting: false,
      completedTasks,
      updatedTasks,
      completedCount: completedTasks.length,
      movedTasks: [],
      newTasksCount: 0,
      removedTasksCount: 0,
      unchangedCount: existingTasks.length - completedTasks.length,
      unassignedTasks: [],
      unassignedMinutes: 0,
      deficitMinutes: 0,
      isFeasible: true,
      remainingStudyDays: getAvailableStudyDates(
        today,
        updatedExam.examDate,
        updatedPrefs.restDays,
      ).length,
    };
  }

  // 2. 處理刪除的章節：未完成任務若所屬章節已被刪除，則移除
  let removedTasksCount = 0;
  const retainedUnfinished: StudyTask[] = [];
  for (const task of unfinishedTasks) {
    if (task.chapterId && !updatedChapterMap.has(task.chapterId)) {
      removedTasksCount++;
    } else {
      const sub = updatedExam.subjects.find((s) => s.id === task.subjectId);
      retainedUnfinished.push({
        ...task,
        subjectName: sub?.name ?? task.subjectName,
      });
    }
  }

  // 3. 處理新增的章節：為新加入的章節建立待讀任務
  const effectiveDailyLimit = Math.max(
    15,
    Math.floor(updatedPrefs.dailyMinutes * (updatedPrefs.intensity === 'light' ? 0.8 : 1.0)),
  );

  const newlyAddedTasks: StudyTask[] = [];
  for (const sub of updatedExam.subjects) {
    const newChapters = sub.chapters.filter((c) => !origChapterMap.has(c.id));
    for (const chapter of newChapters) {
      const estMin = Math.min(
        effectiveDailyLimit,
        sub.familiarity === 1 ? 40 : sub.familiarity === 2 ? 30 : 25,
      );
      newlyAddedTasks.push({
        id: idGenerator('task'),
        examId: updatedExam.id,
        subjectId: sub.id,
        subjectName: sub.name,
        chapterId: chapter.id,
        title: `${sub.name} · ${chapter.title}：概念學習`,
        kind: 'study',
        date: today,
        estimatedMinutes: estMin,
        status: 'pending',
      });
    }
  }

  // 4. 將所有待安排任務（保留之未完成 + 新增）配置至新可用日期
  const availableDates = getAvailableStudyDates(
    today,
    updatedExam.examDate,
    updatedPrefs.restDays,
  );

  const tasksToSchedule = [...retainedUnfinished, ...newlyAddedTasks];
  const unfinishedRequiredMinutes = tasksToSchedule.reduce(
    (sum, t) => sum + t.estimatedMinutes,
    0,
  );
  const remainingAvailableMinutes = availableDates.length * effectiveDailyLimit;
  const deficitMinutes = Math.max(0, unfinishedRequiredMinutes - remainingAvailableMinutes);

  if (availableDates.length === 0) {
    const unassigned = tasksToSchedule.map((t) => ({
      ...t,
      status: 'needsReschedule' as const,
    }));
    return {
      isScheduleAffecting: true,
      completedTasks,
      updatedTasks: [...completedTasks, ...unassigned],
      completedCount: completedTasks.length,
      movedTasks: [],
      newTasksCount: newlyAddedTasks.length,
      removedTasksCount,
      unchangedCount: 0,
      unassignedTasks: unassigned,
      unassignedMinutes: unfinishedRequiredMinutes,
      deficitMinutes: unfinishedRequiredMinutes,
      isFeasible: false,
      remainingStudyDays: 0,
      warning: '考前已無可用的讀書日（請確認考試日期大於今天，或調整休息日）。',
      suggestions: ['延後考試日期', '減少每週休息日'],
    };
  }

  // 排序待分配任務
  const sortedTasks = [...tasksToSchedule].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.title.localeCompare(b.title);
  });

  const dailyLoads = new Map<ISODate, number>();
  for (const d of availableDates) {
    dailyLoads.set(d, 0);
  }

  const rescheduledUnfinished: StudyTask[] = [];
  const unassignedTasks: StudyTask[] = [];
  const movedTasks: TaskDateChange[] = [];
  let unchangedCount = 0;

  for (const task of sortedTasks) {
    let targetDate: ISODate | null = null;
    let minLoad = Infinity;

    for (const d of availableDates) {
      const currentLoad = dailyLoads.get(d) ?? 0;
      if (currentLoad + task.estimatedMinutes <= effectiveDailyLimit) {
        if (currentLoad < minLoad) {
          minLoad = currentLoad;
          targetDate = d;
        }
      }
    }

    if (targetDate) {
      dailyLoads.set(targetDate, (dailyLoads.get(targetDate) ?? 0) + task.estimatedMinutes);

      const isNewlyAdded = newlyAddedTasks.some((n) => n.id === task.id);
      if (!isNewlyAdded && task.date !== targetDate) {
        movedTasks.push({
          taskId: task.id,
          taskTitle: task.title,
          subjectId: task.subjectId,
          oldDate: task.date,
          newDate: targetDate,
          estimatedMinutes: task.estimatedMinutes,
        });
      } else if (!isNewlyAdded) {
        unchangedCount++;
      }

      rescheduledUnfinished.push({
        ...task,
        date: targetDate,
        status: 'pending',
      });
    } else {
      unassignedTasks.push(task);
      rescheduledUnfinished.push({
        ...task,
        status: 'needsReschedule',
      });
    }
  }

  const updatedTasks = [...completedTasks, ...rescheduledUnfinished].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.title.localeCompare(b.title);
  });

  const unassignedMinutes = unassignedTasks.reduce((sum, t) => sum + t.estimatedMinutes, 0);
  const isFeasible = unassignedTasks.length === 0;

  const result: ExamEditRescheduleResult = {
    isScheduleAffecting: true,
    completedTasks,
    updatedTasks,
    completedCount: completedTasks.length,
    movedTasks,
    newTasksCount: newlyAddedTasks.length,
    removedTasksCount,
    unchangedCount,
    unassignedTasks,
    unassignedMinutes,
    deficitMinutes,
    isFeasible,
    remainingStudyDays: availableDates.length,
  };

  if (!isFeasible) {
    result.warning = `考前可用時間不足！共有 ${unassignedTasks.length} 項任務（共 ${formatMinutes(unassignedMinutes)}）超出每日 ${formatMinutes(effectiveDailyLimit)} 上限無法排入。這些任務已標記為待重新排程，未被刪除。`;
    result.suggestions = [
      '延長考試日期至更晚時間',
      '在設定中增加每日可讀書時間',
      '減少每週休息日',
    ];
  }

  return result;
}

