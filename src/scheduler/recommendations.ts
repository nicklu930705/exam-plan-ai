import type { Exam, ISODate, StudyPreferences, StudyTask, Subject } from '../types/models';
import { diffDays, formatMinutes, weekdayOf } from '../utils/date';
import { calculateSingleTaskPriority } from './priority';

export type RecommendationType =
  | 'overdue_alert'
  | 'daily_overload'
  | 'urgent_exam'
  | 'weak_subject'
  | 'multi_exam_balance'
  | 'rest_day'
  | 'ahead_of_schedule'
  | 'general_advice';

export interface StudyRecommendation {
  id: string;
  type: RecommendationType;
  title: string;
  description: string;
  reason: string;
  actionTitle?: string;
  actionRoute?: string;
  actionParams?: Record<string, string>;
  severity: 'info' | 'warning' | 'success';
  priorityOrder: number; // 越小越排在前面
}

export interface RecommendationContext {
  exams: Exam[];
  tasks: StudyTask[];
  preferences: StudyPreferences;
  today: ISODate;
  selectedExamId?: string;
}

/**
 * 產生個人化讀書建議引擎
 * 純函式、依據使用者實際資料計算，絕不捏造或宣稱未經證實的學習能力。
 */
export function generateStudyRecommendations(
  context: RecommendationContext,
): StudyRecommendation[] {
  const { exams, tasks, preferences, today, selectedExamId } = context;
  const activeExams = exams.filter((e) => !e.archived);

  // 1. 若尚未建立任何考試，提供溫和的一般提示引導
  if (activeExams.length === 0) {
    return [
      {
        id: 'no-exams',
        type: 'general_advice',
        title: '建立第一場考試以啟用智慧規劃',
        description: '設定考試目標、科目與章節後，系統將自動為你分析最適合的每日進度與複習節奏。',
        reason: '系統需要基礎考試日期與科目範圍，才能計算每日可用負荷與任務排序。',
        actionTitle: '＋ 建立新考試',
        actionRoute: '/exam/new',
        severity: 'info',
        priorityOrder: 1,
      },
    ];
  }

  // 若使用者已選取特定考試，讓該考試相關建議優先排序
  const focusedExam = selectedExamId
    ? activeExams.find((e) => e.id === selectedExamId)
    : activeExams[0];

  const recommendations: StudyRecommendation[] = [];

  // 今日任務清單與未完成任務
  const todayTasks = tasks.filter((t) => t.date === today);
  const todayDoneTasks = todayTasks.filter((t) => t.status === 'done');
  const todayUnfinishedTasks = todayTasks.filter((t) => t.status !== 'done');
  const behindTasks = tasks.filter(
    (t) => t.status === 'needsReschedule' || (t.status === 'pending' && t.date < today),
  );

  const isRestDay = preferences.restDays.includes(weekdayOf(today));
  const todayEstimatedMinutes = todayTasks.reduce((sum, t) => sum + t.estimatedMinutes, 0);

  // ───── 建議 1：落後／逾期任務警示（最高優先度） ─────
  if (behindTasks.length > 0) {
    const behindMins = behindTasks.reduce((sum, t) => sum + t.estimatedMinutes, 0);
    // 找出受影響的考試名稱
    const affectedExamIds = Array.from(new Set(behindTasks.map((t) => t.examId)));
    const targetExam =
      (focusedExam && affectedExamIds.includes(focusedExam.id) ? focusedExam : undefined) ??
      activeExams.find((e) => e.id === affectedExamIds[0]);

    recommendations.push({
      id: `overdue-${behindTasks.length}`,
      type: 'overdue_alert',
      title: `有 ${behindTasks.length} 項任務進度落後（約 ${formatMinutes(behindMins)}）`,
      description: '生活偶爾有突發狀況很正常。建議啟動「智慧重新排程」，將未完成任務平攤至後續讀書日。',
      reason: '客觀重新分配能避免考前時間壓縮，讓每日讀書量維持在精力可負擔的健康範圍。',
      actionTitle: '智慧重新排程',
      actionRoute: '/reschedule',
      actionParams: targetExam ? { examId: targetExam.id } : undefined,
      severity: 'warning',
      priorityOrder: 1,
    });
  }

  // ───── 建議 2：今日讀書量超出每日上限 ─────
  if (todayEstimatedMinutes > preferences.dailyMinutes) {
    const overflowMins = todayEstimatedMinutes - preferences.dailyMinutes;
    recommendations.push({
      id: 'daily-overload',
      type: 'daily_overload',
      title: `今日排定時間超出設定上限（超出 ${formatMinutes(overflowMins)}）`,
      description: `今日預計讀書 ${formatMinutes(todayEstimatedMinutes)}，高於每日上限 ${formatMinutes(preferences.dailyMinutes)}。建議專注核心章節，或將部分任務後移。`,
      reason: '維持在精力充沛的時長內學習，觀念吸收率與持久力最佳。',
      actionTitle: '重新調整排程',
      actionRoute: '/reschedule',
      severity: 'warning',
      priorityOrder: 2,
    });
  }

  // ───── 建議 3：考試逼近衝刺提醒（<= 7 天） ─────
  const urgentExams = activeExams
    .map((e) => ({ exam: e, daysLeft: diffDays(today, e.examDate) }))
    .filter((e) => e.daysLeft >= 0 && e.daysLeft <= 7)
    .sort((a, b) => a.daysLeft - b.daysLeft);

  if (urgentExams.length > 0) {
    const topUrgent = urgentExams[0];
    const unfinishedInUrgent = tasks.filter(
      (t) => t.examId === topUrgent.exam.id && t.status !== 'done',
    );

    if (unfinishedInUrgent.length > 0) {
      recommendations.push({
        id: `urgent-${topUrgent.exam.id}`,
        type: 'urgent_exam',
        title: `「${topUrgent.exam.name}」倒數衝刺期（剩 ${topUrgent.daysLeft === 0 ? '今天' : `${topUrgent.daysLeft} 天`}）`,
        description: `該考試尚有 ${unfinishedInUrgent.length} 項待辦任務。考前階段建議聚焦錯題回顧與實戰模考，不再大範圍硬背全新章節。`,
        reason: '衝刺期收斂範圍、鞏固核心既有觀念，有助於考場正常發揮。',
        actionTitle: '查看衝刺計畫',
        actionRoute: '/(tabs)/plan',
        actionParams: { examId: topUrgent.exam.id },
        severity: topUrgent.daysLeft <= 3 ? 'warning' : 'info',
        priorityOrder: 3,
      });
    }
  }

  // ───── 建議 4：弱項科目深度關注 ─────
  // 找出使用者自評為 familiarity === 1 的科目
  const weakSubjects: { subject: Subject; exam: Exam; taskCount: number }[] = [];
  for (const e of activeExams) {
    for (const sub of e.subjects) {
      if (sub.familiarity === 1) {
        const subTasks = tasks.filter(
          (t) => t.examId === e.id && t.subjectId === sub.id && t.status !== 'done',
        );
        if (subTasks.length > 0) {
          weakSubjects.push({ subject: sub, exam: e, taskCount: subTasks.length });
        }
      }
    }
  }

  if (weakSubjects.length > 0) {
    const topWeak = weakSubjects[0];
    recommendations.push({
      id: `weak-${topWeak.subject.id}`,
      type: 'weak_subject',
      title: `弱項強化提醒：「${topWeak.subject.name}」`,
      description: `該科目評定熟悉度較弱，目前尚有 ${topWeak.taskCount} 項待辦任務。建議採用專注計時器，以 25 分鐘番茄鐘小段落推進。`,
      reason: '對於較生疏的觀念，分段專注能有效降低啟動阻力並加深長期記憶。',
      actionTitle: '查看科目任務',
      actionRoute: '/(tabs)/plan',
      actionParams: { examId: topWeak.exam.id },
      severity: 'info',
      priorityOrder: 4,
    });
  }

  // ───── 建議 5：多場考試並進之時間配置平衡 ─────
  if (activeExams.length >= 2) {
    const sortedActive = [...activeExams].sort((a, b) => a.examDate.localeCompare(b.examDate));
    const firstExam = sortedActive[0];
    const secondExam = sortedActive[1];
    const firstDays = diffDays(today, firstExam.examDate);

    recommendations.push({
      id: 'multi-exam-balance',
      type: 'multi_exam_balance',
      title: `多考科時間平衡：先「${firstExam.name}」後「${secondExam.name}」`,
      description: `「${firstExam.name}」距離較近（${firstDays > 0 ? `${firstDays} 天` : '今天'}），建議分配約 70% 時間推進，並保留 30% 時間維持「${secondExam.name}」的基礎讀書手感。`,
      reason: '多目標同時準備時，適度傾斜至近端目標可緩解考前焦慮，同時避免次要目標完全中斷。',
      severity: 'info',
      priorityOrder: 5,
    });
  }

  // ───── 建議 6：今日任務全數達標 ─────
  if (todayTasks.length > 0 && todayUnfinishedTasks.length === 0) {
    recommendations.push({
      id: 'today-completed',
      type: 'ahead_of_schedule',
      title: '今日讀書任務已順利達標！',
      description: `今日共完成 ${todayDoneTasks.length} 項任務。辛苦了，今天可以好好休息，或提前預覽下一個讀書日的章節。`,
      reason: '每日排程已如期實踐，適當放鬆與肯定有助於維持長期自律。',
      severity: 'success',
      priorityOrder: 6,
    });
  }

  // ───── 建議 7：今日為休息日 ─────
  if (isRestDay && todayTasks.length === 0) {
    recommendations.push({
      id: 'today-rest-day',
      type: 'rest_day',
      title: '今天是預定的每週休息日',
      description: '大腦在休息時會持續整理與固化學過的知識。今天好好充電放鬆，迎接下一個衝刺日！',
      reason: '適度的休息週期是防範倦怠、維持長期備考動力的必要環節。',
      severity: 'info',
      priorityOrder: 7,
    });
  }

  // ───── 建議 8：一般性穩定步調建議（若無任何特別警示） ─────
  if (recommendations.length === 0) {
    const nextTask = todayUnfinishedTasks[0];
    const prio = nextTask
      ? calculateSingleTaskPriority(
          nextTask,
          activeExams.find((e) => e.id === nextTask.examId),
          activeExams,
          preferences,
          today,
        )
      : null;

    recommendations.push({
      id: 'steady-pace',
      type: 'general_advice',
      title: '按部就班，維持穩健節奏',
      description: prio
        ? `推薦先開始：「${nextTask.title}」（${prio.summaryReason}）`
        : '今日進度掌握良好，持續執行每日排程即可穩步邁向考試目標！',
      reason: '持之以恆的小步快跑，是長跑備考最扎實且可靠的策略。',
      actionTitle: nextTask ? '開始讀書' : undefined,
      actionRoute: nextTask ? `/task/${nextTask.id}` : undefined,
      severity: 'info',
      priorityOrder: 8,
    });
  }

  // 依 priorityOrder 排序
  return recommendations.sort((a, b) => a.priorityOrder - b.priorityOrder);
}
