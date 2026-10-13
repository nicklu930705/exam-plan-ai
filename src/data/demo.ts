import type { AppData, Exam, StudyTask, Subject, TaskKind } from '../types/models';
import { addDays, todayISO, weekdayOf } from '../utils/date';

/**
 * 示範資料
 * 第一階段尚未完成排程引擎與本機儲存，因此用這份資料展示畫面。
 * 日期都以「今天」為基準推算，任何時候打開都看得到合理的內容。
 * 介面上會清楚標示「示範資料」，使用者可在設定中清除。
 */

const DEMO_EXAM_ID = 'demo-toeic';

const LISTENING_PARTS = ['Part 1 照片描述', 'Part 2 應答問題', 'Part 3 簡短對話', 'Part 4 簡短獨白'];
const READING_PARTS = ['Part 5 句子填空', 'Part 6 段落填空', 'Part 7 單篇閱讀', 'Part 7 多篇閱讀'];

function buildSubjects(): Subject[] {
  return [
    {
      id: 'demo-listening',
      name: '聽力',
      familiarity: 2,
      chapters: LISTENING_PARTS.map((title, i) => ({ id: `demo-l${i + 1}`, title })),
    },
    {
      id: 'demo-reading',
      name: '閱讀',
      familiarity: 1,
      chapters: READING_PARTS.map((title, i) => ({ id: `demo-r${i + 1}`, title })),
    },
    {
      id: 'demo-vocab',
      name: '單字',
      familiarity: 3,
      chapters: [{ id: 'demo-v1', title: '多益商務情境單字' }],
    },
  ];
}

interface Template {
  title: string;
  chapterId: string;
  kind: TaskKind;
}

/** 每個章節拆成「題型解析＋兩組練習」三個小任務 */
function partTemplates(parts: string[], prefix: string): Template[] {
  return parts.flatMap((part, i) => [
    { title: `${part}：題型解析`, chapterId: `${prefix}${i + 1}`, kind: 'study' as const },
    { title: `${part}：練習題 第 1 組`, chapterId: `${prefix}${i + 1}`, kind: 'practice' as const },
    { title: `${part}：練習題 第 2 組`, chapterId: `${prefix}${i + 1}`, kind: 'practice' as const },
  ]);
}

export function createDemoData(now: Date = new Date()): AppData {
  const today = todayISO(now);
  const restDays = [0] as const; // 星期日休息

  const exam: Exam = {
    id: DEMO_EXAM_ID,
    name: '多益 TOEIC',
    examDate: addDays(today, 45),
    subjects: buildSubjects(),
    createdAt: now.toISOString(),
  };

  const listening = partTemplates(LISTENING_PARTS, 'demo-l');
  const reading = partTemplates(READING_PARTS, 'demo-r');

  const tasks: StudyTask[] = [];
  let studyDayIndex = 0;

  // 從三天前排到十天後，休息日不排任務
  for (let offset = -3; offset <= 10; offset++) {
    const date = addDays(today, offset);
    if ((restDays as readonly number[]).includes(weekdayOf(date))) continue;

    const k = studyDayIndex++;
    const dayTasks: Omit<StudyTask, 'status'>[] = [
      {
        id: `demo-t${k}-l`,
        examId: DEMO_EXAM_ID,
        subjectId: 'demo-listening',
        subjectName: '聽力',
        chapterId: listening[k % listening.length].chapterId,
        title: listening[k % listening.length].title,
        kind: listening[k % listening.length].kind,
        date,
        estimatedMinutes: 30,
      },
      {
        id: `demo-t${k}-r`,
        examId: DEMO_EXAM_ID,
        subjectId: 'demo-reading',
        subjectName: '閱讀',
        chapterId: reading[k % reading.length].chapterId,
        title: reading[k % reading.length].title,
        kind: reading[k % reading.length].kind,
        date,
        estimatedMinutes: 45,
      },
      {
        id: `demo-t${k}-v`,
        examId: DEMO_EXAM_ID,
        subjectId: 'demo-vocab',
        subjectName: '單字',
        chapterId: 'demo-v1',
        title: `商務單字 第 ${k + 1} 回（50 字）`,
        kind: 'study',
        date,
        estimatedMinutes: 20,
      },
    ];

    dayTasks.forEach((t, i) => {
      let status: StudyTask['status'] = 'pending';
      if (offset < 0) {
        // 過去的任務大多已完成；昨天的閱讀任務刻意留著未完成，用來展示「落後」狀態
        status = offset === -1 && i === 1 ? 'pending' : 'done';
      } else if (offset === 0 && i === 2) {
        status = 'done'; // 今天已完成一項
      }
      tasks.push({
        ...t,
        status,
        completedAt: status === 'done' ? now.toISOString() : undefined,
      });
    });
  }

  return {
    exams: [exam],
    tasks,
    preferences: { dailyMinutes: 120, restDays: [0], intensity: 'normal' },
    selectedExamId: DEMO_EXAM_ID,
    isDemo: true,
  };
}
