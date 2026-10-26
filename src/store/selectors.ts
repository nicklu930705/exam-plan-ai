import type { AppData, Exam, ISODate, StudyTask, Subject, Weekday } from '../types/models';
import { addDays, diffDays, weekdayOf } from '../utils/date';

/**
 * 從資料中計算畫面需要的資訊（純函式，方便日後撰寫測試）
 */

/** 最近一場尚未結束且進行中（未封存）的考試（考試當天仍算） */
export function getUpcomingExam(data: AppData, today: ISODate): Exam | undefined {
  return [...data.exams]
    .filter((e) => !e.archived && diffDays(today, e.examDate) >= 0)
    .sort((a, b) => a.examDate.localeCompare(b.examDate))[0];
}

export function getExamById(data: AppData, id: string | undefined): Exam | undefined {
  return data.exams.find((e) => e.id === id);
}

/** 取得所有進行中（未封存）的考試 */
export function getActiveExams(data: AppData): Exam[] {
  return data.exams.filter((e) => !e.archived);
}

/** 取得所有已封存的考試 */
export function getArchivedExams(data: AppData): Exam[] {
  return data.exams.filter((e) => e.archived);
}

/** 取得指定 ID 且未封存之進行中考試 */
export function getActiveExamById(data: AppData, id: string | undefined): Exam | undefined {
  if (!id) return undefined;
  return data.exams.find((e) => e.id === id && !e.archived);
}

export function getSubject(data: AppData, subjectId: string): Subject | undefined {
  for (const exam of data.exams) {
    const s = exam.subjects.find((sub) => sub.id === subjectId);
    if (s) return s;
  }
  return undefined;
}

export function tasksForDate(tasks: StudyTask[], date: ISODate): StudyTask[] {
  return tasks.filter((t) => t.date === date);
}

export function tasksForExam(tasks: StudyTask[], examId: string): StudyTask[] {
  return tasks.filter((t) => t.examId === examId);
}

export function sumMinutes(tasks: StudyTask[]): number {
  return tasks.reduce((sum, t) => sum + t.estimatedMinutes, 0);
}

/** 累計任務實際研讀分鐘數 */
export function sumActualMinutes(tasks: StudyTask[]): number {
  return tasks.reduce((sum, t) => sum + (t.actualMinutes ?? 0), 0);
}

/** 逾期的任務：日期在今天之前且尚未完成 */
export function getOverdueTasks(tasks: StudyTask[], today: ISODate): StudyTask[] {
  return tasks
    .filter((t) => t.status !== 'done' && t.date < today)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 落後的任務：日期在今天之前但尚未完成，或被標記為需要重新安排 */
export function getBehindTasks(tasks: StudyTask[], today: ISODate): StudyTask[] {
  return tasks
    .filter(
      (t) => t.status === 'needsReschedule' || (t.status === 'pending' && t.date < today),
    )
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 進度儀表板綜合統計指標 */
export interface DashboardStats {
  totalCount: number;
  doneCount: number;
  pendingCount: number;
  overdueCount: number;
  needsRescheduleCount: number;
  totalEstimatedMinutes: number;
  doneEstimatedMinutes: number;
  totalActualMinutes: number;
  doneActualMinutes: number;
  completionRatio: number;
  completionPercentage: number;
  timeComparisonRatio: number;
  timeVarianceMinutes: number;
}

export function computeDashboardStats(tasks: StudyTask[], today: ISODate): DashboardStats {
  const totalCount = tasks.length;
  const done = tasks.filter((t) => t.status === 'done');
  const doneCount = done.length;
  const overdue = tasks.filter((t) => t.status !== 'done' && t.date < today);
  const overdueCount = overdue.length;
  const pending = tasks.filter((t) => t.status !== 'done' && t.date >= today);
  const pendingCount = pending.length;
  const needsReschedule = tasks.filter((t) => t.status === 'needsReschedule');
  const needsRescheduleCount = needsReschedule.length;

  const totalEstimatedMinutes = tasks.reduce((sum, t) => sum + t.estimatedMinutes, 0);
  const doneEstimatedMinutes = done.reduce((sum, t) => sum + t.estimatedMinutes, 0);

  const totalActualMinutes = tasks.reduce((sum, t) => sum + (t.actualMinutes ?? 0), 0);
  const doneActualMinutes = done.reduce((sum, t) => sum + (t.actualMinutes ?? 0), 0);

  const completionRatio = totalCount === 0 ? 0 : doneCount / totalCount;
  const completionPercentage = totalCount === 0 ? 0 : Math.round(completionRatio * 100);

  const timeComparisonRatio =
    totalEstimatedMinutes === 0 ? 0 : totalActualMinutes / totalEstimatedMinutes;
  const timeVarianceMinutes = totalActualMinutes - totalEstimatedMinutes;

  return {
    totalCount,
    doneCount,
    pendingCount,
    overdueCount,
    needsRescheduleCount,
    totalEstimatedMinutes,
    doneEstimatedMinutes,
    totalActualMinutes,
    doneActualMinutes,
    completionRatio,
    completionPercentage,
    timeComparisonRatio,
    timeVarianceMinutes,
  };
}

export interface Progress {
  doneCount: number;
  totalCount: number;
  remainingCount: number;
  doneMinutes: number;
  totalMinutes: number;
  /** 0 ~ 1，依已完成任務數計算（doneCount / totalCount） */
  ratio: number;
  /** 0 ~ 100 百分比整數 */
  percentage: number;
  /** 0 ~ 1，以預估時間計算 */
  timeRatio: number;
}

export function computeProgress(tasks: StudyTask[]): Progress {
  const done = tasks.filter((t) => t.status === 'done');
  const totalCount = tasks.length;
  const doneCount = done.length;
  const remainingCount = totalCount - doneCount;
  const totalMinutes = sumMinutes(tasks);
  const doneMinutes = sumMinutes(done);
  const ratio = totalCount === 0 ? 0 : doneCount / totalCount;
  const percentage = totalCount === 0 ? 0 : Math.round(ratio * 100);
  const timeRatio = totalMinutes === 0 ? 0 : doneMinutes / totalMinutes;
  return {
    doneCount,
    totalCount,
    remainingCount,
    doneMinutes,
    totalMinutes,
    ratio,
    percentage,
    timeRatio,
  };
}

/** 依日期分組並排序 */
export function groupByDate(tasks: StudyTask[]): { date: ISODate; tasks: StudyTask[] }[] {
  const map = new Map<ISODate, StudyTask[]>();
  for (const t of tasks) {
    const list = map.get(t.date) ?? [];
    list.push(t);
    map.set(t.date, list);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => ({ date, tasks: list }));
}

/**
 * 從今天到考試前一天，扣除休息日後的可讀書天數
 * （考試當天不安排讀書任務）
 */
export function countStudyDays(
  today: ISODate,
  examDate: ISODate,
  restDays: readonly Weekday[],
): number {
  const total = diffDays(today, examDate);
  let count = 0;
  for (let i = 0; i < total; i++) {
    if (!restDays.includes(weekdayOf(addDays(today, i)))) count++;
  }
  return count;
}

/** 尚未完成的任務（包含待重新安排） */
export function unfinishedTasks(tasks: StudyTask[]): StudyTask[] {
  return tasks.filter((t) => t.status !== 'done');
}

export interface RecentDayStat {
  date: ISODate;
  dayLabel: string;
  isToday: boolean;
  scheduledCount: number;
  doneCount: number;
  doneMinutes: number;
}

export interface RecentPeriodStats {
  days: RecentDayStat[];
  totalDoneCount: number;
  totalDoneMinutes: number;
  streakDays: number;
}

/** 計算近 N 天（預設 7 天）的每日完成統計與連續完成天數 */
export function getRecentPeriodStats(
  tasks: StudyTask[],
  today: ISODate,
  daysCount: number = 7,
): RecentPeriodStats {
  const weekdayNames = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
  const days: RecentDayStat[] = [];
  let totalDoneCount = 0;
  let totalDoneMinutes = 0;

  for (let i = daysCount - 1; i >= 0; i--) {
    const d = addDays(today, -i);
    const dayTasks = tasks.filter((t) => t.date === d);
    const dayDone = dayTasks.filter((t) => t.status === 'done');
    const dayDoneMinutes = sumMinutes(dayDone);

    totalDoneCount += dayDone.length;
    totalDoneMinutes += dayDoneMinutes;

    const w = weekdayOf(d);
    days.push({
      date: d,
      dayLabel: i === 0 ? '今天' : (weekdayNames[w] ?? ''),
      isToday: i === 0,
      scheduledCount: dayTasks.length,
      doneCount: dayDone.length,
      doneMinutes: dayDoneMinutes,
    });
  }

  // 計算連續打卡天數（從今天或昨天往前推連續有完成任務的天數）
  let streakDays = 0;
  // 若今天有完成，從今天開始算；否則從昨天開始算連續天數
  const todayDone = days[days.length - 1]?.doneCount ?? 0;
  const startIndex = todayDone > 0 ? days.length - 1 : days.length - 2;

  for (let j = startIndex; j >= 0; j--) {
    const day = days[j];
    if (day && day.doneCount > 0) {
      streakDays++;
    } else {
      break;
    }
  }

  return {
    days,
    totalDoneCount,
    totalDoneMinutes,
    streakDays,
  };
}
