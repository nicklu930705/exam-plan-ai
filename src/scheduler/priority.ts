import type { Exam, Familiarity, ISODate, StudyPreferences, StudyTask, Subject } from '../types/models';
import { diffDays } from '../utils/date';

export type UrgencyLevel = 'high' | 'medium' | 'low';

export interface TaskPriorityResult {
  task: StudyTask;
  score: number;
  urgencyLevel: UrgencyLevel;
  isOverdue: boolean;
  daysUntilExam: number;
  familiarity: Familiarity;
  examName: string;
  subjectName: string;
  reasons: string[];
  summaryReason: string;
}

/**
 * 計算單一任務的綜合優先度分數與客觀理由。
 *
 * 評分準則（完全基於客觀排程與設定資料，不宣稱真實學習能力）：
 * 1. 逾期狀態（Overdue）：已逾期或標記需重排的任務權重大幅提高（+120 分）。
 * 2. 考試接近度（Exam Proximity）：距離考試越近，衝刺緊迫度越高（0~3天 +80分；4~7天 +60分；8~14天 +40分）。
 * 3. 科目熟悉度（Familiarity）：使用者自評「不熟 (1)」+50分，「普通 (2)」+25分，「熟悉 (3)」+10分。
 * 4. 多考試競合（Multi-Exam Proximity）：若使用者同時準備多場考試，優先推薦最接近目標之考試任務（+30分）。
 * 5. 當日任務（Today Alignment）：原定為今日之任務 +40分。
 * 6. 任務時間與每日額度配比（Time Granularity）：輕巧好切入的任務（<=25分）+10分；主要核心任務 +5分。
 */
export function calculateSingleTaskPriority(
  task: StudyTask,
  exam: Exam | undefined,
  allExams: Exam[],
  preferences: StudyPreferences,
  today: ISODate,
): TaskPriorityResult {
  const reasons: string[] = [];
  let score = 0;

  // 1. 找出所屬考試與科目
  const examName = exam?.name ?? '考試';
  const subject: Subject | undefined = exam?.subjects.find((s) => s.id === task.subjectId);
  const subjectName = task.subjectName ?? subject?.name ?? '科目';
  const familiarity: Familiarity = subject?.familiarity ?? 2;

  // 2. 檢查逾期狀態
  const isOverdue = task.status === 'needsReschedule' || task.date < today;
  if (isOverdue) {
    score += 120;
    reasons.push('任務已逾期未完成，優先補齊以防考前進度積累');
  }

  // 3. 考試倒數天數
  let daysUntilExam = 999;
  if (exam?.examDate) {
    daysUntilExam = diffDays(today, exam.examDate);
    if (daysUntilExam < 0) {
      // 考試已結束
      score += 0;
      reasons.push('考試已結束');
    } else if (daysUntilExam === 0) {
      score += 100;
      reasons.push('今天為考試當天，進行最後重點速覽');
    } else if (daysUntilExam <= 3) {
      score += 80;
      reasons.push(`距離「${examName}」僅剩 ${daysUntilExam} 天，進入最後衝刺階段`);
    } else if (daysUntilExam <= 7) {
      score += 60;
      reasons.push(`距離「${examName}」剩餘 ${daysUntilExam} 天，建議加緊推進核心進度`);
    } else if (daysUntilExam <= 14) {
      score += 40;
      reasons.push(`距離「${examName}」剩餘 ${daysUntilExam} 天，為重要備考期`);
    } else if (daysUntilExam <= 30) {
      score += 20;
      reasons.push(`距離「${examName}」尚有 ${daysUntilExam} 天，維持穩健步調`);
    } else {
      score += 10;
      reasons.push(`距離「${examName}」時間相對充裕（${daysUntilExam} 天）`);
    }
  }

  // 4. 科目熟悉程度
  if (familiarity === 1) {
    score += 50;
    reasons.push(`「${subjectName}」熟悉度評定為較弱，及早研讀效果更佳`);
  } else if (familiarity === 2) {
    score += 25;
    reasons.push(`「${subjectName}」熟悉度為普通，按正常節奏安排`);
  } else {
    score += 10;
    reasons.push(`「${subjectName}」熟悉度較高，以精華複習為主`);
  }

  // 5. 多考試競合情境
  const activeExams = allExams.filter((e) => !e.archived && e.examDate >= today);
  if (activeExams.length > 1 && exam) {
    // 找出最快到來的考試
    const sortedExams = [...activeExams].sort((a, b) => a.examDate.localeCompare(b.examDate));
    const closestExam = sortedExams[0];
    if (closestExam && closestExam.id === exam.id) {
      score += 30;
      reasons.push(`同時準備 ${activeExams.length} 場考試，此任務屬於最靠近的目標「${examName}」`);
    }
  }

  // 6. 今日任務契合度
  if (task.date === today) {
    score += 40;
    reasons.push('為今日排定之重點任務');
  } else if (task.date > today) {
    const daysUntilTask = diffDays(today, task.date);
    if (daysUntilTask <= 2) {
      score += 15;
    }
  }

  // 7. 任務預估時間與每日可用時間
  if (task.estimatedMinutes <= 25) {
    score += 10;
    reasons.push(`單元時間輕巧（${task.estimatedMinutes} 分鐘），適合快速推進維持成就感`);
  } else if (task.estimatedMinutes > preferences.dailyMinutes * 0.7) {
    score += 5;
    reasons.push(`此單元需較長專注時間（${task.estimatedMinutes} 分鐘），建議在精力充沛時研讀`);
  }

  // 8. 判定緊迫程度等級
  let urgencyLevel: UrgencyLevel = 'low';
  if (score >= 170) {
    urgencyLevel = 'high';
  } else if (score >= 110) {
    urgencyLevel = 'medium';
  }

  // 9. 產生客觀綜合摘要理由
  let summaryReason = '';
  if (isOverdue) {
    summaryReason = `此任務已逾期未完成，且距離「${examName}」僅剩 ${daysUntilExam > 0 ? `${daysUntilExam} 天` : '不久'}，建議優先補上以防進度積累。`;
  } else if (familiarity === 1 && daysUntilExam <= 14) {
    summaryReason = `「${subjectName}」熟悉度較弱，且「${examName}」即將到來（剩餘 ${daysUntilExam} 天），建議優先攻克難點。`;
  } else if (activeExams.length > 1 && exam?.id === activeExams[0]?.id && daysUntilExam <= 10) {
    summaryReason = `同時準備多場考試，此任務屬於即將來臨的「${examName}」（剩餘 ${daysUntilExam} 天），建議優先投入。`;
  } else if (task.date === today) {
    summaryReason = `今日排定任務，預估需 ${task.estimatedMinutes} 分鐘，按部就班即可維持穩定步調。`;
  } else if (familiarity === 1) {
    summaryReason = `「${subjectName}」為弱項科目，提前研讀有助於深化理解。`;
  } else {
    summaryReason = `屬於「${examName}」之預定進度，建議依序研讀。`;
  }

  return {
    task,
    score,
    urgencyLevel,
    isOverdue,
    daysUntilExam,
    familiarity,
    examName,
    subjectName,
    reasons,
    summaryReason,
  };
}

/**
 * 批次計算並排序未完成任務
 * 排序規則：
 * 1. 優先分數（高 -> 低）
 * 2. 原定日期（早 -> 晚）
 * 3. 標題字母順序
 * 4. 任務 ID（保證確定性）
 */
export function prioritizeTasks(
  tasks: StudyTask[],
  exams: Exam[],
  preferences: StudyPreferences,
  today: ISODate,
): TaskPriorityResult[] {
  // 只針對未完成的任務計算優先級
  const unfinishedTasks = tasks.filter((t) => t.status !== 'done');
  const examMap = new Map<string, Exam>();
  for (const e of exams) {
    examMap.set(e.id, e);
  }

  const results = unfinishedTasks.map((task) => {
    const exam = examMap.get(task.examId);
    return calculateSingleTaskPriority(task, exam, exams, preferences, today);
  });

  return results.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (a.task.date !== b.task.date) {
      return a.task.date.localeCompare(b.task.date);
    }
    if (a.task.title !== b.task.title) {
      return a.task.title.localeCompare(b.task.title);
    }
    return a.task.id.localeCompare(b.task.id);
  });
}
