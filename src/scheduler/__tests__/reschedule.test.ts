import { calculateReschedulePlan } from '../reschedule';
import type { StudyPreferences, StudyTask } from '../../types/models';

describe('重新排程模組 (Rescheduling Engine)', () => {
  const today = '2026-10-15';
  const examDate = '2026-10-25';

  const mockPreferences: StudyPreferences = {
    dailyMinutes: 90,
    restDays: [0], // 週日休息
    intensity: 'normal',
  };

  const existingTasks: StudyTask[] = [
    // 過去已完成任務 (10-12, 10-13)
    {
      id: 'done-1',
      examId: 'exam-1',
      subjectId: 'sub-1',
      subjectName: '專業科目一',
      title: '觀念研讀 Ch1',
      kind: 'study',
      date: '2026-10-12',
      estimatedMinutes: 30,
      status: 'done',
      completedAt: '2026-10-12T10:00:00.000Z',
    },
    {
      id: 'done-2',
      examId: 'exam-1',
      subjectId: 'sub-1',
      subjectName: '專業科目一',
      title: '實戰練習 Ch1',
      kind: 'practice',
      date: '2026-10-13',
      estimatedMinutes: 30,
      status: 'done',
      completedAt: '2026-10-13T10:00:00.000Z',
    },
    // 過去未完成任務（落後，原訂 10-14）
    {
      id: 'overdue-1',
      examId: 'exam-1',
      subjectId: 'sub-1',
      subjectName: '專業科目一',
      title: '觀念研讀 Ch2',
      kind: 'study',
      date: '2026-10-14',
      estimatedMinutes: 35,
      status: 'pending',
    },
    // 使用者標記需要重新安排的任務
    {
      id: 'flagged-1',
      examId: 'exam-1',
      subjectId: 'sub-2',
      subjectName: '專業科目二',
      title: '實戰練習 Ch2',
      kind: 'practice',
      date: '2026-10-16',
      estimatedMinutes: 30,
      status: 'needsReschedule',
    },
    // 未來正常的待辦任務
    {
      id: 'future-1',
      examId: 'exam-1',
      subjectId: 'sub-2',
      subjectName: '專業科目二',
      title: '核心觀念 Ch3',
      kind: 'study',
      date: '2026-10-18',
      estimatedMinutes: 40,
      status: 'pending',
    },
  ];

  test('已完成任務保護：重新排程後，已完成任務必須完整保留且不重複安排', () => {
    const plan = calculateReschedulePlan(existingTasks, examDate, mockPreferences, today);

    // 已完成任務保持原狀
    expect(plan.completedTasks.length).toBe(2);
    expect(plan.completedTasks.map((t) => t.id)).toEqual(['done-1', 'done-2']);

    const doneInUpdated = plan.updatedTasks.filter((t) => t.status === 'done');
    expect(doneInUpdated.length).toBe(2);
    expect(doneInUpdated.find((t) => t.id === 'done-1')?.completedAt).toBe('2026-10-12T10:00:00.000Z');

    // 總任務數不變（無任何任務被靜默刪除）
    expect(plan.updatedTasks.length).toBe(existingTasks.length);
  });

  test('未完成與落後任務重新分配至今天（含）之後的合法日期', () => {
    const plan = calculateReschedulePlan(existingTasks, examDate, mockPreferences, today);

    const unfinished = plan.updatedTasks.filter((t) => t.status !== 'done');
    for (const task of unfinished) {
      expect(task.date >= today).toBe(true);
      expect(task.date < examDate).toBe(true);
    }

    // 過去落後的 overdue-1 必須被移到今天或之後
    const rescheduledOverdue = plan.updatedTasks.find((t) => t.id === 'overdue-1');
    expect(rescheduledOverdue && rescheduledOverdue.date >= today).toBe(true);

    // 被標記 needsReschedule 的任務重新排定後恢復為正常 pending
    const flagged = plan.updatedTasks.find((t) => t.id === 'flagged-1');
    expect(flagged?.status).toBe('pending');
  });

  test('產出清楚的異動差異 (changedTasks)', () => {
    const plan = calculateReschedulePlan(existingTasks, examDate, mockPreferences, today);

    expect(plan.changedTasks.length).toBeGreaterThan(0);
    const overdueChange = plan.changedTasks.find((c) => c.taskId === 'overdue-1');
    expect(overdueChange).toBeDefined();
    expect(overdueChange?.oldDate).toBe('2026-10-14');
    expect(overdueChange && overdueChange.newDate >= today).toBe(true);
  });

  test('時間不足情境：當剩餘可用時間不足時，明確標示 isFeasible === false 與短少時間', () => {
    // 考試在明天，但有 3 項未完成任務需要共 105 分鐘，每日限額只有 30 分鐘
    const tightPrefs: StudyPreferences = {
      dailyMinutes: 30,
      restDays: [],
      intensity: 'normal',
    };

    const plan = calculateReschedulePlan(existingTasks, '2026-10-16', tightPrefs, today);

    expect(plan.isFeasible).toBe(false);
    expect(plan.deficitMinutes).toBeGreaterThan(0);
    expect(plan.warning).toBeDefined();
    expect(plan.suggestions?.length).toBeGreaterThan(0);
  });

  test('嚴格遵守每日讀書時間上限：任何一天的任務總時間皆不得超過上限', () => {
    const plan = calculateReschedulePlan(existingTasks, examDate, mockPreferences, today);

    for (const stat of plan.dailyStats) {
      expect(stat.totalMinutes).toBeLessThanOrEqual(stat.limitMinutes);
    }

    // 檢查已安排任務的實際日負載
    const assignedTasks = plan.updatedTasks.filter(
      (t) => t.status !== 'done' && !plan.unassignedTasks.some((u) => u.id === t.id),
    );
    const dayLoads = new Map<string, number>();
    for (const t of assignedTasks) {
      dayLoads.set(t.date, (dayLoads.get(t.date) ?? 0) + t.estimatedMinutes);
    }
    for (const [, load] of dayLoads) {
      expect(load).toBeLessThanOrEqual(mockPreferences.dailyMinutes);
    }
  });

  test('超額任務明確列出且不被默默刪除', () => {
    // 考前只有 1 天可用，每日上限 30 分鐘，但任務需要 105 分鐘
    const tightPrefs: StudyPreferences = {
      dailyMinutes: 30,
      restDays: [],
      intensity: 'normal',
    };

    const plan = calculateReschedulePlan(existingTasks, '2026-10-16', tightPrefs, today);

    expect(plan.isFeasible).toBe(false);
    expect(plan.unassignedTasks.length).toBeGreaterThan(0);
    // 總任務數仍然與原任務數相同（不可默默刪除任務）
    expect(plan.updatedTasks.length).toBe(existingTasks.length);
    // 每日統計中當天時間不超過 30 分鐘
    for (const stat of plan.dailyStats) {
      expect(stat.totalMinutes).toBeLessThanOrEqual(30);
    }
  });

  test('提供每日排程預覽資料（包含日期、任務數與預估時間）', () => {
    const plan = calculateReschedulePlan(existingTasks, examDate, mockPreferences, today);

    expect(plan.dailyStats.length).toBe(plan.remainingStudyDays);
    expect(plan.dailyStats[0]).toHaveProperty('date');
    expect(plan.dailyStats[0]).toHaveProperty('taskCount');
    expect(plan.dailyStats[0]).toHaveProperty('totalMinutes');
    expect(plan.dailyStats[0]).toHaveProperty('limitMinutes');
  });
});
