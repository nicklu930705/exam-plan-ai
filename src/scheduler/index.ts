import type { Exam, ISODate, StudyPreferences, StudyTask, Subject, TaskKind } from '../types/models';
import { addDays, diffDays, weekdayOf } from '../utils/date';

/**
 * 讀書計畫排程引擎（確定性排程）
 * 遵循純函式設計，可獨立進行自動化測試，不依賴任何 UI 元件或第三方狀態庫。
 */

export interface ScheduleResult {
  tasks: StudyTask[];
  isFeasible: boolean;
  totalRequiredMinutes: number;
  totalAvailableMinutes: number;
  studyDaysCount: number;
  warning?: string;
  suggestions?: string[];
}

export interface TaskBlueprint {
  subjectId: string;
  subjectName: string;
  chapterId?: string;
  title: string;
  kind: TaskKind;
  estimatedMinutes: number;
  priorityScore: number; // 數字越大越優先安排
}

/**
 * 根據科目熟悉度與每天可用時間計算章節任務的合理分鐘數。
 * 確保單一任務不會大於使用者設定的每日可用時間。
 */
function getChunkMinutes(base: number, dailyMax: number): number {
  const scaled = Math.min(base, dailyMax);
  // 取 5 的倍數，最低 15 分鐘（除非 dailyMax 更小）
  const rounded = Math.max(10, Math.round(scaled / 5) * 5);
  return Math.min(rounded, dailyMax);
}

/**
 * 依各科熟悉度計算優先級與任務細項：
 * - 熟悉度 1（不熟）：權重最高，安排較深入的觀念研讀與習題練習
 * - 熟悉度 2（普通）：標準配比
 * - 熟悉度 3（熟悉）：重點速讀與實戰練習
 * 若使用者未輸入具體章節，則以科目名稱建立合理之待讀任務，不捏造課本章節。
 */
export function generateTaskBlueprints(
  subjects: Subject[],
  dailyMax: number,
  intensityRatio: number = 1.0,
  targetDaysCount?: number,
): TaskBlueprint[] {
  const blueprints: TaskBlueprint[] = [];

  // 先依熟悉程度排序：不熟 (1) > 普通 (2) > 熟悉 (3)
  const sortedSubjects = [...subjects].sort((a, b) => a.familiarity - b.familiarity);

  for (const subject of sortedSubjects) {
    const fam = subject.familiarity;

    // 依熟悉度決定單一任務基底時間
    const studyBase = fam === 1 ? 40 : fam === 2 ? 30 : 20;
    const practiceBase = fam === 1 ? 35 : fam === 2 ? 25 : 20;

    const studyMinutes = getChunkMinutes(Math.round(studyBase * intensityRatio), dailyMax);
    const practiceMinutes = getChunkMinutes(Math.round(practiceBase * intensityRatio), dailyMax);

    // 優先度權重：familiarity 1 得 30 分，familiarity 2 得 20 分，familiarity 3 得 10 分
    const famPriority = (4 - fam) * 10;

    if (subject.chapters.length === 0) {
      // 使用者未輸入具體章節：直接以科目名稱建立合理的任務，不憑空捏造章節
      blueprints.push({
        subjectId: subject.id,
        subjectName: subject.name,
        title: `${subject.name}：核心觀念研讀`,
        kind: 'study',
        estimatedMinutes: studyMinutes,
        priorityScore: famPriority + 3,
      });

      blueprints.push({
        subjectId: subject.id,
        subjectName: subject.name,
        title: `${subject.name}：觀念題目練習`,
        kind: 'practice',
        estimatedMinutes: practiceMinutes,
        priorityScore: famPriority + 2,
      });

      blueprints.push({
        subjectId: subject.id,
        subjectName: subject.name,
        title: `${subject.name}：綜合實戰演練`,
        kind: 'practice',
        estimatedMinutes: practiceMinutes,
        priorityScore: famPriority + 1,
      });

      const reviewMinutes = getChunkMinutes(Math.round(25 * intensityRatio), dailyMax);
      if (fam === 1 || (targetDaysCount && targetDaysCount >= 5)) {
        // 不熟悉科目或天數充裕時追加重點強化
        blueprints.push({
          subjectId: subject.id,
          subjectName: subject.name,
          title: `${subject.name}：重點補強與錯題檢討`,
          kind: 'review',
          estimatedMinutes: reviewMinutes,
          priorityScore: famPriority,
        });
      }

      // 若讀書天數較長（>= 7 天），追加進階題型演練與全真模考演練，確保每天有實質任務
      if (targetDaysCount && targetDaysCount >= 7) {
        blueprints.push({
          subjectId: subject.id,
          subjectName: subject.name,
          title: `${subject.name}：歷屆重點試題實戰`,
          kind: 'practice',
          estimatedMinutes: practiceMinutes,
          priorityScore: famPriority + 1,
        });
      }
      if (targetDaysCount && targetDaysCount >= 10) {
        blueprints.push({
          subjectId: subject.id,
          subjectName: subject.name,
          title: `${subject.name}：專題解題技巧剖析`,
          kind: 'study',
          estimatedMinutes: studyMinutes,
          priorityScore: famPriority + 2,
        });
      }
    } else {
      // 使用者有輸入章節：為各章節產生研讀與練習任務
      for (let cIdx = 0; cIdx < subject.chapters.length; cIdx++) {
        const chapter = subject.chapters[cIdx];
        const chapterPriority = famPriority + (subject.chapters.length - cIdx);

        // 第一步：觀念研讀
        blueprints.push({
          subjectId: subject.id,
          subjectName: subject.name,
          chapterId: chapter.id,
          title: `${subject.name} · ${chapter.title}：核心觀念研讀`,
          kind: 'study',
          estimatedMinutes: studyMinutes,
          priorityScore: chapterPriority + 2,
        });

        // 第二步：題目練習
        blueprints.push({
          subjectId: subject.id,
          subjectName: subject.name,
          chapterId: chapter.id,
          title: `${subject.name} · ${chapter.title}：章節實戰練習`,
          kind: 'practice',
          estimatedMinutes: practiceMinutes,
          priorityScore: chapterPriority + 1,
        });

        // 若為不熟悉科目或可用天數充裕（>=5 天），追加錯題訂正與重點強化
        if (fam === 1 || (targetDaysCount && targetDaysCount >= 5)) {
          const reviewMinutes = getChunkMinutes(25, dailyMax);
          blueprints.push({
            subjectId: subject.id,
            subjectName: subject.name,
            chapterId: chapter.id,
            title: `${subject.name} · ${chapter.title}：錯題訂正與重點回顧`,
            kind: 'review',
            estimatedMinutes: reviewMinutes,
            priorityScore: chapterPriority,
          });
        }

        // 若天數充裕（>=8 天），追加進階題型突破
        if (targetDaysCount && targetDaysCount >= 8) {
          blueprints.push({
            subjectId: subject.id,
            subjectName: subject.name,
            chapterId: chapter.id,
            title: `${subject.name} · ${chapter.title}：進階題型演練與解題技巧`,
            kind: 'practice',
            estimatedMinutes: practiceMinutes,
            priorityScore: chapterPriority + 1,
          });
        }
      }

      // 若包含多章節且可用天數充裕，安排跨單元綜合演練
      if (subject.chapters.length >= 2 && targetDaysCount && targetDaysCount >= 6) {
        blueprints.push({
          subjectId: subject.id,
          subjectName: subject.name,
          title: `${subject.name}：跨單元綜合題型演練`,
          kind: 'practice',
          estimatedMinutes: practiceMinutes,
          priorityScore: famPriority + 1,
        });
      }
    }
  }

  return blueprints;
}

/**
 * 產生考前整合複習任務藍圖
 */
export function generateReviewBlueprints(
  subjects: Subject[],
  dailyMax: number,
  examName: string,
): TaskBlueprint[] {
  const reviews: TaskBlueprint[] = [];
  const sorted = [...subjects].sort((a, b) => a.familiarity - b.familiarity);

  for (const subject of sorted) {
    const minutes = getChunkMinutes(35, dailyMax);
    reviews.push({
      subjectId: subject.id,
      subjectName: subject.name,
      title: `${subject.name}：考前重點總整理`,
      kind: 'review',
      estimatedMinutes: minutes,
      priorityScore: 50,
    });
  }

  // 跨科目綜合模考
  const mockMinutes = getChunkMinutes(Math.min(60, dailyMax), dailyMax);
  reviews.push({
    subjectId: sorted[0]?.id ?? 'exam-review',
    subjectName: sorted[0]?.name ?? examName,
    title: `${examName}：全真模擬測驗與解析`,
    kind: 'review',
    estimatedMinutes: mockMinutes,
    priorityScore: 60,
  });

  return reviews;
}

/**
 * 取得從 startDate 到 examDate 前一天的所有合法讀書日（排除休息日）
 */
export function getAvailableStudyDates(
  startDate: ISODate,
  examDate: ISODate,
  restDays: readonly number[],
): ISODate[] {
  const daysUntil = diffDays(startDate, examDate);
  const result: ISODate[] = [];

  // 考試當天不排讀書，因此只排到 examDate 前一天
  for (let i = 0; i < daysUntil; i++) {
    const d = addDays(startDate, i);
    const weekday = weekdayOf(d);
    if (!restDays.includes(weekday)) {
      result.push(d);
    }
  }
  return result;
}

/**
 * 主排程演算法
 * 給定考試、使用者讀書偏好與起始日期，產生每日具體任務清單。
 */
export function scheduleExamPlan(
  exam: Exam,
  preferences: StudyPreferences,
  startDate: ISODate,
  idGenerator: (prefix: string) => string = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 9)}`,
): ScheduleResult {
  const { dailyMinutes, restDays, intensity } = preferences;

  // 讀書強度係數
  const intensityRatio = intensity === 'light' ? 0.75 : intensity === 'intense' ? 1.15 : 1.0;
  // 每日最大可用額度
  const effectiveDailyLimit = Math.max(15, Math.floor(dailyMinutes * (intensity === 'light' ? 0.8 : 1.0)));

  // 1. 取得所有有效讀書日期
  const studyDates = getAvailableStudyDates(startDate, exam.examDate, restDays);

  console.log('[排程引擎] 開始產生排程，輸入資料：', {
    examName: exam.name,
    examDate: exam.examDate,
    startDate,
    subjectsCount: exam.subjects.length,
    availableStudyDays: studyDates.length,
    dailyMinutes,
    restDays,
    intensity,
  });

  if (studyDates.length === 0) {
    console.warn('[排程引擎] 考前無可用讀書日');
    return {
      tasks: [],
      isFeasible: false,
      totalRequiredMinutes: 0,
      totalAvailableMinutes: 0,
      studyDaysCount: 0,
      warning: '考試日期前沒有任何可安排的讀書日（請確認考試日期是否大於今天，或調整每週休息日）。',
      suggestions: ['調整考試日期至較晚的時間', '在設定中減少每週休息天數'],
    };
  }

  // 2. 劃分「章節研讀期」與「考前複習期」
  // 若讀書天數大於等於 7 天，保留最後 15%~20% 天數作為複習；少於 7 天但大於等於 3 天，保留最後 1 天；少於 3 天則穿插。
  let reviewDaysCount = 0;
  if (studyDates.length >= 7) {
    reviewDaysCount = Math.min(5, Math.max(2, Math.floor(studyDates.length * 0.18)));
  } else if (studyDates.length >= 3) {
    reviewDaysCount = 1;
  }

  const primaryStudyDates = studyDates.slice(0, studyDates.length - reviewDaysCount);
  const reviewStudyDates = studyDates.slice(studyDates.length - reviewDaysCount);
  const primaryDates = primaryStudyDates.length > 0 ? primaryStudyDates : studyDates;

  // 3. 產生任務藍圖（依可用讀書日數產生充足且循序漸進的任務）
  const chapterBlueprints = generateTaskBlueprints(
    exam.subjects,
    effectiveDailyLimit,
    intensityRatio,
    primaryDates.length,
  );
  const reviewBlueprints = generateReviewBlueprints(exam.subjects, effectiveDailyLimit, exam.name);

  const totalRequiredMinutes =
    chapterBlueprints.reduce((sum, b) => sum + b.estimatedMinutes, 0) +
    reviewBlueprints.reduce((sum, b) => sum + b.estimatedMinutes, 0);

  const totalAvailableMinutes = studyDates.length * effectiveDailyLimit;
  const isFeasible = totalAvailableMinutes >= totalRequiredMinutes;

  // 4. 進行確定性排程配置：
  // 建立每日容量追蹤器：Map<ISODate, number>
  const dailyLoads = new Map<ISODate, number>();
  for (const d of studyDates) {
    dailyLoads.set(d, 0);
  }

  const scheduledTasks: StudyTask[] = [];

  // 將藍圖適度平滑且均勻地分配至一般研讀日，優先讓今日或起始日有具體任務，且後續各週節奏穩定
  const totalBps = chapterBlueprints.length;
  for (let i = 0; i < totalBps; i++) {
    const bp = chapterBlueprints[i];
    // 依據任務進度計算均勻目標日，確保第一項在首日 (i=0 -> 0)，其餘均勻展開
    const idealDayIdx =
      primaryDates.length > totalBps
        ? Math.min(primaryDates.length - 1, Math.floor((i / totalBps) * primaryDates.length))
        : Math.min(primaryDates.length - 1, i);

    let placed = false;
    for (let offset = 0; offset < primaryDates.length; offset++) {
      const targetIdx = (idealDayIdx + offset) % primaryDates.length;
      const d = primaryDates[targetIdx];
      const currentLoad = dailyLoads.get(d) ?? 0;
      if (currentLoad + bp.estimatedMinutes <= effectiveDailyLimit) {
        dailyLoads.set(d, currentLoad + bp.estimatedMinutes);
        scheduledTasks.push({
          id: idGenerator('task'),
          examId: exam.id,
          subjectId: bp.subjectId,
          subjectName: bp.subjectName,
          chapterId: bp.chapterId,
          title: bp.title,
          kind: bp.kind,
          date: d,
          estimatedMinutes: bp.estimatedMinutes,
          status: 'pending',
        });
        placed = true;
        break;
      }
    }

    if (!placed) {
      // 若因時間緊迫無法在單日限額內排入，配置至目前負載最低的讀書日
      let minLoadDate = primaryDates[0];
      let minLoad = Infinity;
      for (const d of primaryDates) {
        const load = dailyLoads.get(d) ?? 0;
        if (load < minLoad) {
          minLoad = load;
          minLoadDate = d;
        }
      }
      dailyLoads.set(minLoadDate, minLoad + bp.estimatedMinutes);
      scheduledTasks.push({
        id: idGenerator('task'),
        examId: exam.id,
        subjectId: bp.subjectId,
        subjectName: bp.subjectName,
        chapterId: bp.chapterId,
        title: bp.title,
        kind: bp.kind,
        date: minLoadDate,
        estimatedMinutes: bp.estimatedMinutes,
        status: 'pending',
      });
    }
  }

  // 分配考前整合複習任務（集中於考前 reviewPool）
  const reviewPool = reviewStudyDates.length > 0 ? reviewStudyDates : studyDates;
  const totalRev = reviewBlueprints.length;
  for (let i = 0; i < totalRev; i++) {
    const bp = reviewBlueprints[i];
    const idealRevIdx = Math.min(
      reviewPool.length - 1,
      Math.floor((i / totalRev) * reviewPool.length),
    );

    let placed = false;
    for (let offset = 0; offset < reviewPool.length; offset++) {
      const targetIdx = (idealRevIdx + offset) % reviewPool.length;
      const d = reviewPool[targetIdx];
      const currentLoad = dailyLoads.get(d) ?? 0;
      if (currentLoad + bp.estimatedMinutes <= effectiveDailyLimit) {
        dailyLoads.set(d, currentLoad + bp.estimatedMinutes);
        scheduledTasks.push({
          id: idGenerator('task'),
          examId: exam.id,
          subjectId: bp.subjectId,
          subjectName: bp.subjectName,
          chapterId: bp.chapterId,
          title: bp.title,
          kind: bp.kind,
          date: d,
          estimatedMinutes: bp.estimatedMinutes,
          status: 'pending',
        });
        placed = true;
        break;
      }
    }

    if (!placed) {
      let minDate = reviewPool[0];
      let minLoad = Infinity;
      for (const d of reviewPool) {
        const load = dailyLoads.get(d) ?? 0;
        if (load < minLoad) {
          minLoad = load;
          minDate = d;
        }
      }
      dailyLoads.set(minDate, minLoad + bp.estimatedMinutes);
      scheduledTasks.push({
        id: idGenerator('task'),
        examId: exam.id,
        subjectId: bp.subjectId,
        subjectName: bp.subjectName,
        chapterId: bp.chapterId,
        title: bp.title,
        kind: bp.kind,
        date: minDate,
        estimatedMinutes: bp.estimatedMinutes,
        status: 'pending',
      });
    }
  }

  // 依日期與科目重新排序，保持閱讀順暢
  scheduledTasks.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.title.localeCompare(b.title);
  });

  console.log('[排程引擎] 成功產生每日任務：', {
    examName: exam.name,
    tasksCount: scheduledTasks.length,
    isFeasible,
    totalRequiredMinutes,
    totalAvailableMinutes,
    coveredStudyDays: new Set(scheduledTasks.map((t) => t.date)).size,
  });

  const result: ScheduleResult = {
    tasks: scheduledTasks,
    isFeasible,
    totalRequiredMinutes,
    totalAvailableMinutes,
    studyDaysCount: studyDates.length,
  };

  if (!isFeasible) {
    const deficit = totalRequiredMinutes - totalAvailableMinutes;
    result.warning = `考前總可用時間（${Math.round(totalAvailableMinutes / 60)}小時）小於完整涵蓋所需時間（${Math.round(totalRequiredMinutes / 60)}小時），短少約 ${Math.round(deficit / 60)} 小時。已優先為您安排高優先度科目與核心章節。`;
    result.suggestions = [
      '適度增加每日可讀書時間（例如增加 30 ~ 60 分鐘）',
      '減少每週休息天數以增加考前可用讀書日',
      '調整科目章節，聚焦在最關鍵的章節或考科',
    ];
  }

  return result;
}
