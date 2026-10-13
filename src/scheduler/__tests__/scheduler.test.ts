import { scheduleExamPlan } from '../index';
import type { Exam, StudyPreferences } from '../../types/models';
import { weekdayOf } from '../../utils/date';

describe('讀書計畫排程引擎 (Study Plan Scheduler)', () => {
  const startDate = '2026-10-12'; // 週一
  const examDate = '2026-11-12';  // 31 天後

  const mockExam: Exam = {
    id: 'exam-1',
    name: '多益英語測驗',
    examDate,
    createdAt: '2026-10-12T00:00:00.000Z',
    subjects: [
      {
        id: 'sub-listening',
        name: '聽力',
        familiarity: 1, // 不熟
        chapters: [
          { id: 'c1', title: 'Part 1 照片描述' },
          { id: 'c2', title: 'Part 2 應答問題' },
        ],
      },
      {
        id: 'sub-reading',
        name: '閱讀',
        familiarity: 2, // 普通
        chapters: [
          { id: 'c3', title: 'Part 5 句子填空' },
          { id: 'c4', title: 'Part 6 段落填空' },
        ],
      },
    ],
  };

  const mockPreferences: StudyPreferences = {
    dailyMinutes: 90,
    restDays: [0], // 週日休息
    intensity: 'normal',
  };

  test('正常建立考試並生成計畫：任務必須完整對應各科目與章節', () => {
    const result = scheduleExamPlan(mockExam, mockPreferences, startDate);

    expect(result.tasks.length).toBeGreaterThan(0);
    expect(result.isFeasible).toBe(true);
    expect(result.studyDaysCount).toBeGreaterThan(0);

    // 任務必須對應真實科目與章節
    const listeningTasks = result.tasks.filter((t) => t.subjectId === 'sub-listening');
    expect(listeningTasks.length).toBeGreaterThan(0);
    expect(listeningTasks.some((t) => t.title.includes('Part 1 照片描述'))).toBe(true);

    const readingTasks = result.tasks.filter((t) => t.subjectId === 'sub-reading');
    expect(readingTasks.length).toBeGreaterThan(0);
    expect(readingTasks.some((t) => t.title.includes('Part 5 句子填空'))).toBe(true);

    // 包含考前總複習
    expect(result.tasks.some((t) => t.kind === 'review')).toBe(true);
  });

  test('排程約束：每日任務總時間不得超過每日可用時間', () => {
    const dailyMinutes = 60;
    const prefs: StudyPreferences = { ...mockPreferences, dailyMinutes };
    const result = scheduleExamPlan(mockExam, prefs, startDate);

    // 按日期彙總每日總分鐘數
    const dailyTotals = new Map<string, number>();
    for (const task of result.tasks) {
      dailyTotals.set(task.date, (dailyTotals.get(task.date) ?? 0) + task.estimatedMinutes);
    }

    for (const total of dailyTotals.values()) {
      expect(total).toBeLessThanOrEqual(dailyMinutes);
    }
  });

  test('排程約束：任務絕對不會排到考試日期之後，亦不在考試當天排讀書任務', () => {
    const result = scheduleExamPlan(mockExam, mockPreferences, startDate);

    for (const task of result.tasks) {
      expect(task.date < examDate).toBe(true);
      expect(task.date >= startDate).toBe(true);
    }
  });

  test('排程約束：使用者設定之休息日預設不安排任何任務', () => {
    // 設定週六(6)與週日(0)為休息日
    const prefs: StudyPreferences = {
      dailyMinutes: 120,
      restDays: [0, 6],
      intensity: 'normal',
    };
    const result = scheduleExamPlan(mockExam, prefs, startDate);

    for (const task of result.tasks) {
      const weekday = weekdayOf(task.date);
      expect(weekday).not.toBe(0);
      expect(weekday).not.toBe(6);
    }
  });

  test('時間不足情境：每日可用時間很少時，發出明確警告並提供可行調整選項', () => {
    // 考試只剩 3 天，每天只有 15 分鐘
    const tightExam: Exam = {
      ...mockExam,
      examDate: '2026-10-15',
    };
    const tightPrefs: StudyPreferences = {
      dailyMinutes: 15,
      restDays: [],
      intensity: 'normal',
    };

    const result = scheduleExamPlan(tightExam, tightPrefs, startDate);

    expect(result.isFeasible).toBe(false);
    expect(result.warning).toBeDefined();
    expect(result.suggestions).toBeDefined();
    expect(result.suggestions!.length).toBeGreaterThan(0);
    // 依然不拋出例外，且盡量安排高優先任務，單日不超出 15 分鐘
    for (const task of result.tasks) {
      expect(task.estimatedMinutes).toBeLessThanOrEqual(15);
      expect(task.date < tightExam.examDate).toBe(true);
    }
  });

  test('邊界條件：當考前無可用讀書日（天數為0或全為休息日），安全回傳空任務與警告', () => {
    // 考試日期與開始日期相同（0天）
    const sameDayExam: Exam = {
      ...mockExam,
      examDate: startDate,
    };
    const result = scheduleExamPlan(sameDayExam, mockPreferences, startDate);
    expect(result.tasks.length).toBe(0);
    expect(result.isFeasible).toBe(false);
    expect(result.studyDaysCount).toBe(0);
    expect(result.warning).toBeDefined();
    expect(result.suggestions?.length).toBeGreaterThan(0);
  });

  test('演算法穩定性：相同輸入必須產生完全一致的確定性排程', () => {
    let idA = 0;
    const resultA = scheduleExamPlan(mockExam, mockPreferences, startDate, () => `id-${++idA}`);

    let idB = 0;
    const resultB = scheduleExamPlan(mockExam, mockPreferences, startDate, () => `id-${++idB}`);

    expect(resultA.tasks.length).toBe(resultB.tasks.length);
    for (let i = 0; i < resultA.tasks.length; i++) {
      expect(resultA.tasks[i].date).toBe(resultB.tasks[i].date);
      expect(resultA.tasks[i].title).toBe(resultB.tasks[i].title);
      expect(resultA.tasks[i].estimatedMinutes).toBe(resultB.tasks[i].estimatedMinutes);
      expect(resultA.tasks[i].subjectName).toBe(resultB.tasks[i].subjectName);
    }
  });

  test('當使用者未輸入章節時：使用科目名稱建立合理任務，不憑空捏造章節', () => {
    const examWithoutChapters: Exam = {
      id: 'exam-no-chapters',
      name: '微積分期中考',
      examDate: '2026-11-01',
      createdAt: '2026-10-12T00:00:00.000Z',
      subjects: [
        {
          id: 'sub-calculus',
          name: '高等微積分',
          familiarity: 1, // 不熟
          chapters: [], // 無具體章節
        },
      ],
    };

    const result = scheduleExamPlan(examWithoutChapters, mockPreferences, startDate);

    expect(result.tasks.length).toBeGreaterThan(0);
    expect(result.isFeasible).toBe(true);

    for (const task of result.tasks) {
      expect(task.subjectName).toBe('高等微積分');
      expect(task.chapterId).toBeUndefined(); // 沒有捏造章節 ID
      if (task.kind === 'study' || task.kind === 'practice') {
        expect(task.title.startsWith('高等微積分')).toBe(true);
      }
      expect(task.date < '2026-11-01').toBe(true);
      expect(task.date >= startDate).toBe(true);
    }
  });
});
