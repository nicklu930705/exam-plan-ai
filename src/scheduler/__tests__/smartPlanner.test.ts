import type { Exam, StudyPreferences, StudyTask } from '../../types/models';
import { calculateSingleTaskPriority, prioritizeTasks } from '../priority';
import { generateStudyRecommendations } from '../recommendations';
import { calculateReschedulePlan } from '../reschedule';

describe('智慧個人化讀書規劃引擎 (Smart Planner & Priority Engine)', () => {
  const today = '2026-10-12';

  const defaultPrefs: StudyPreferences = {
    dailyMinutes: 90,
    restDays: [0], // 週日休息
    intensity: 'normal',
  };

  const createMockExam = (id: string, name: string, examDate: string, familiarity: 1 | 2 | 3 = 2): Exam => ({
    id,
    name,
    examDate,
    createdAt: '2026-10-01T00:00:00Z',
    subjects: [
      {
        id: `sub-${id}`,
        name: `${name}科目`,
        familiarity,
        chapters: [
          { id: `c1-${id}`, title: '第一章 核心概念' },
          { id: `c2-${id}`, title: '第二章 進階演練' },
        ],
      },
    ],
  });

  const createMockTask = (
    id: string,
    examId: string,
    date: string,
    opts: Partial<StudyTask> = {},
  ): StudyTask => ({
    id,
    examId,
    subjectId: `sub-${examId}`,
    subjectName: '測試科目',
    title: `任務 ${id}`,
    kind: 'study',
    date,
    estimatedMinutes: 30,
    status: 'pending',
    ...opts,
  });

  // ───── 1. 多個考試同時存在時的排序 ─────
  describe('1. 多個考試同時存在時的排序', () => {
    test('當使用者同時準備多場考試時，優先推薦最接近目標之考試任務', () => {
      const nearExam = createMockExam('exam-near', '近期多益', '2026-10-15'); // 倒數 3 天
      const farExam = createMockExam('exam-far', '遠期托福', '2026-11-20'); // 倒數 39 天
      const exams = [nearExam, farExam];

      const taskNear = createMockTask('t-near', 'exam-near', today);
      const taskFar = createMockTask('t-far', 'exam-far', today);

      const sorted = prioritizeTasks([taskFar, taskNear], exams, defaultPrefs, today);

      expect(sorted[0].task.id).toBe('t-near');
      expect(sorted[0].score).toBeGreaterThan(sorted[1].score);
      expect(sorted[0].reasons.some((r) => r.includes('最靠近的目標'))).toBe(true);
    });
  });

  // ───── 2. 不同熟悉程度對優先順序的影響 ─────
  describe('2. 不同熟悉程度對優先順序的影響', () => {
    test('在同一考試中，弱項科目（familiarity: 1）任務優先於熟悉科目（familiarity: 3）', () => {
      const exam: Exam = {
        id: 'exam-single',
        name: '大學期中考',
        examDate: '2026-10-25',
        createdAt: '2026-10-01T00:00:00Z',
        subjects: [
          {
            id: 'sub-weak',
            name: '高等微積分',
            familiarity: 1, // 不熟
            chapters: [{ id: 'c-weak', title: '極限定理' }],
          },
          {
            id: 'sub-strong',
            name: '基礎英文',
            familiarity: 3, // 熟悉
            chapters: [{ id: 'c-strong', title: '日常對話' }],
          },
        ],
      };

      const taskWeak = createMockTask('t-weak', exam.id, today, {
        subjectId: 'sub-weak',
        subjectName: '高等微積分',
        title: '極限定理研讀',
      });
      const taskStrong = createMockTask('t-strong', exam.id, today, {
        subjectId: 'sub-strong',
        subjectName: '基礎英文',
        title: '日常對話閱讀',
      });

      const sorted = prioritizeTasks([taskStrong, taskWeak], [exam], defaultPrefs, today);

      expect(sorted[0].task.id).toBe('t-weak');
      expect(sorted[0].score).toBeGreaterThan(sorted[1].score);
      expect(sorted[0].reasons.some((r) => r.includes('較弱'))).toBe(true);
      expect(sorted[0].summaryReason).toContain('熟悉度較弱');
    });
  });

  // ───── 3. 考試日期接近時的排序 ─────
  describe('3. 考試日期接近時的排序', () => {
    test('距離考試越近（<= 3 天），緊急度與分數顯著提高', () => {
      const imminentExam = createMockExam('exam-imminent', '即將考試', '2026-10-14'); // 倒數 2 天
      const relaxedExam = createMockExam('exam-relaxed', '放鬆考試', '2026-11-15'); // 倒數 34 天

      const taskImminent = createMockTask('t-imm', imminentExam.id, today);
      const taskRelaxed = createMockTask('t-rel', relaxedExam.id, today);

      const resultImm = calculateSingleTaskPriority(taskImminent, imminentExam, [imminentExam, relaxedExam], defaultPrefs, today);
      const resultRel = calculateSingleTaskPriority(taskRelaxed, relaxedExam, [imminentExam, relaxedExam], defaultPrefs, today);

      expect(resultImm.score).toBeGreaterThan(resultRel.score);
      expect(resultImm.urgencyLevel).toBe('high');
      expect(resultImm.reasons.some((r) => r.includes('最後衝刺階段'))).toBe(true);
    });
  });

  // ───── 4. 逾期任務與重新排程 ─────
  describe('4. 逾期任務優先順序與智慧重新排程', () => {
    test('已逾期之任務獲得最高優先度加權，提醒使用者優先補上', () => {
      const exam = createMockExam('exam-overdue', '證照考試', '2026-10-20');
      const overdueTask = createMockTask('t-overdue', exam.id, '2026-10-10'); // 逾期 2 天
      const todayTask = createMockTask('t-today', exam.id, today);

      const sorted = prioritizeTasks([todayTask, overdueTask], [exam], defaultPrefs, today);

      expect(sorted[0].task.id).toBe('t-overdue');
      expect(sorted[0].isOverdue).toBe(true);
      expect(sorted[0].summaryReason).toContain('此任務已逾期未完成');
    });

    test('重新排程能將逾期與今日未完成任務重排入後續可用讀書日', () => {
      const exam = createMockExam('exam-resched', '日文檢定', '2026-10-18');
      const tasks: StudyTask[] = [
        createMockTask('t1', exam.id, '2026-10-10'), // 逾期
        createMockTask('t2', exam.id, today),
        createMockTask('t3', exam.id, '2026-10-13'),
      ];

      const plan = calculateReschedulePlan(tasks, exam.examDate, defaultPrefs, today, {
        exam,
      });

      expect(plan.isFeasible).toBe(true);
      expect(plan.changedTasks.length).toBeGreaterThan(0);
      // 所有任務的新日期皆不得小於今日，且不得大於等於考試日 2026-10-18
      for (const t of plan.updatedTasks) {
        expect(t.date >= today).toBe(true);
        expect(t.date < exam.examDate).toBe(true);
      }
    });
  });

  // ───── 5. 休息日與每日時間上限 ─────
  describe('5. 休息日與每日時間上限', () => {
    test('嚴格排除每週休息日，任何一天的總時間絕不超過每日讀書時間上限', () => {
      // 2026-10-18 為星期日（Sunday = 0）
      const exam = createMockExam('exam-rest', '會計師考試', '2026-10-22');
      const tasks: StudyTask[] = [
        createMockTask('t1', exam.id, today, { estimatedMinutes: 45 }),
        createMockTask('t2', exam.id, today, { estimatedMinutes: 45 }),
        createMockTask('t3', exam.id, today, { estimatedMinutes: 45 }),
        createMockTask('t4', exam.id, today, { estimatedMinutes: 45 }),
      ];

      const plan = calculateReschedulePlan(tasks, exam.examDate, defaultPrefs, today);

      // 檢查每一天的排定分鐘數
      for (const stat of plan.dailyStats) {
        expect(stat.totalMinutes).toBeLessThanOrEqual(defaultPrefs.dailyMinutes);
      }

      // 檢查週日（2026-10-18）絕對沒有被排入任務
      const sundayTasks = plan.updatedTasks.filter((t) => t.date === '2026-10-18');
      expect(sundayTasks.length).toBe(0);
    });
  });

  // ───── 6. 已完成任務與計時紀錄的保護 ─────
  describe('6. 已完成任務與計時紀錄的保護', () => {
    test('重新排程絕對不更動已完成任務的狀態、日期、actualMinutes 與 timerMinutes', () => {
      const exam = createMockExam('exam-protect', '程式設計檢定', '2026-10-20');
      const doneTask: StudyTask = {
        id: 'done-1',
        examId: exam.id,
        subjectId: `sub-${exam.id}`,
        title: '已完成的演算法觀念',
        kind: 'study',
        date: '2026-10-09',
        estimatedMinutes: 40,
        actualMinutes: 55,
        timerMinutes: 50,
        status: 'done',
        completedAt: '2026-10-09T15:30:00Z',
      };
      const pendingTask = createMockTask('pending-1', exam.id, '2026-10-10'); // 逾期

      const plan = calculateReschedulePlan([doneTask, pendingTask], exam.examDate, defaultPrefs, today);

      const preservedDone = plan.updatedTasks.find((t) => t.id === 'done-1');
      expect(preservedDone).toBeDefined();
      expect(preservedDone?.status).toBe('done');
      expect(preservedDone?.date).toBe('2026-10-09'); // 日期完整維持
      expect(preservedDone?.actualMinutes).toBe(55);
      expect(preservedDone?.timerMinutes).toBe(50);
      expect(preservedDone?.completedAt).toBe('2026-10-09T15:30:00Z');
      expect(plan.completedTasks.length).toBe(1);
    });
  });

  // ───── 7. 沒有任務、缺乏熟悉度與排程容量不足極端情況 ─────
  describe('7. 沒有任務、缺乏熟悉度與排程容量不足邊界條件', () => {
    test('沒有任務時，優先度引擎安全回傳空陣列', () => {
      const sorted = prioritizeTasks([], [], defaultPrefs, today);
      expect(sorted).toEqual([]);
    });

    test('科目缺乏熟悉度資料時，優雅 fallback 至普通熟悉度 (2)', () => {
      const exam: Exam = {
        id: 'exam-sparse',
        name: '精簡考試',
        examDate: '2026-10-25',
        createdAt: '2026-10-01T00:00:00Z',
        subjects: [], // 沒有科目設定
      };
      const task = createMockTask('t-sparse', exam.id, today);

      const result = calculateSingleTaskPriority(task, exam, [exam], defaultPrefs, today);
      expect(result.familiarity).toBe(2);
      expect(result.score).toBeGreaterThan(0);
    });

    test('當考前可用容量不足時，誠實列出 unassignedTasks 與短缺時間，絕不捏造成功', () => {
      // 考前只有 1 天可用，每日上限 90 分鐘，但未完成任務需 200 分鐘
      const tightExam = createMockExam('exam-tight', '緊急考試', '2026-10-14'); // 考前只有 10-12, 10-13 可用 (2天 = 180分)
      const heavyTasks: StudyTask[] = [
        createMockTask('h1', tightExam.id, today, { estimatedMinutes: 80 }),
        createMockTask('h2', tightExam.id, today, { estimatedMinutes: 80 }),
        createMockTask('h3', tightExam.id, today, { estimatedMinutes: 80 }), // 總共 240 分鐘，超出 180 分鐘
      ];

      const plan = calculateReschedulePlan(heavyTasks, tightExam.examDate, defaultPrefs, today);

      expect(plan.isFeasible).toBe(false);
      expect(plan.unassignedTasks.length).toBeGreaterThan(0);
      expect(plan.deficitMinutes).toBeGreaterThan(0);
      expect(plan.warning).toContain('考前剩餘時間不足');
      expect(plan.suggestions?.length).toBeGreaterThan(0);
    });
  });

  // ───── 8. 個人化讀書建議引擎 ─────
  describe('8. 個人化讀書建議引擎 (Study Recommendations)', () => {
    test('偵測到逾期任務時，產生 overdue_alert 建議並包含客觀理由與重新排程入口', () => {
      const exam = createMockExam('exam-rec', '專案管理認證', '2026-10-25');
      const overdueTask = createMockTask('rec-overdue', exam.id, '2026-10-10');

      const recs = generateStudyRecommendations({
        exams: [exam],
        tasks: [overdueTask],
        preferences: defaultPrefs,
        today,
      });

      const overdueRec = recs.find((r) => r.type === 'overdue_alert');
      expect(overdueRec).toBeDefined();
      expect(overdueRec?.actionRoute).toBe('/reschedule');
      expect(overdueRec?.severity).toBe('warning');
      expect(overdueRec?.reason).toContain('客觀重新分配');
    });

    test('今日任務預估時間超過每日上限時，產生 daily_overload 警示', () => {
      const exam = createMockExam('exam-rec2', '公務員考試', '2026-10-30');
      const tasks = [
        createMockTask('t1', exam.id, today, { estimatedMinutes: 60 }),
        createMockTask('t2', exam.id, today, { estimatedMinutes: 60 }), // 總共 120 分鐘，超過 90 分鐘
      ];

      const recs = generateStudyRecommendations({
        exams: [exam],
        tasks,
        preferences: defaultPrefs,
        today,
      });

      const overloadRec = recs.find((r) => r.type === 'daily_overload');
      expect(overloadRec).toBeDefined();
      expect(overloadRec?.severity).toBe('warning');
      expect(overloadRec?.reason).toContain('精力充沛');
    });

    test('當考試進入倒數衝刺期（<= 7 天）時，產生 urgent_exam 衝刺建議', () => {
      const urgentExam = createMockExam('exam-urgent', '多益口說', '2026-10-15'); // 倒數 3 天
      const tasks = [createMockTask('u1', urgentExam.id, today)];

      const recs = generateStudyRecommendations({
        exams: [urgentExam],
        tasks,
        preferences: defaultPrefs,
        today,
      });

      const urgentRec = recs.find((r) => r.type === 'urgent_exam');
      expect(urgentRec).toBeDefined();
      expect(urgentRec?.description).toContain('聚焦錯題回顧');
    });

    test('當使用者自評包含弱項科目（familiarity: 1）時，產生弱項深度關注建議', () => {
      const exam = createMockExam('exam-weak', '物理期中考', '2026-10-28', 1);
      const tasks = [createMockTask('w1', exam.id, today)];

      const recs = generateStudyRecommendations({
        exams: [exam],
        tasks,
        preferences: defaultPrefs,
        today,
      });

      const weakRec = recs.find((r) => r.type === 'weak_subject');
      expect(weakRec).toBeDefined();
      expect(weakRec?.reason).toContain('分段專注');
    });

    test('當今日任務皆已全數完成時，產生 ahead_of_schedule 鼓勵與休息建議', () => {
      const exam = createMockExam('exam-done', '日檢 N1', '2026-10-28');
      const doneTask = createMockTask('d1', exam.id, today, { status: 'done' });

      const recs = generateStudyRecommendations({
        exams: [exam],
        tasks: [doneTask],
        preferences: defaultPrefs,
        today,
      });

      const successRec = recs.find((r) => r.type === 'ahead_of_schedule');
      expect(successRec).toBeDefined();
      expect(successRec?.severity).toBe('success');
    });

    test('使用者取消重新排程或未確認套用時，原本的任務清單與狀態 100% 保持不變', () => {
      const exam = createMockExam('exam-cancel', '全民英檢', '2026-10-25');
      const originalTasks: StudyTask[] = [
        createMockTask('t-orig-1', exam.id, '2026-10-10'), // 逾期
        createMockTask('t-orig-2', exam.id, today),
      ];

      // 產生試算預覽
      const plan = calculateReschedulePlan(originalTasks, exam.examDate, defaultPrefs, today);
      expect(plan.changedTasks.length).toBeGreaterThan(0);

      // 模擬使用者取消：不呼叫套用函式
      // 原任務清單與屬性完全維持原樣
      expect(originalTasks[0].date).toBe('2026-10-10');
      expect(originalTasks[0].status).toBe('pending');
      expect(originalTasks[1].date).toBe(today);
      expect(originalTasks.length).toBe(2);
    });
  });
});
