import type { Familiarity, ISODate, StudyPreferences } from '../types/models';
import { countStudyDays } from '../store/selectors';
import { diffDays } from '../utils/date';

/**
 * 建立考試表單的驗證規則（純函式，不依賴畫面，方便測試）
 */

export const LIMITS = {
  examNameMax: 40,
  subjectNameMax: 20,
  chaptersMax: 100,
  chapterTitleMax: 60,
  subjectsMax: 15,
} as const;

export interface SubjectDraft {
  id: string;
  name: string;
  familiarity: Familiarity;
  /** 使用者輸入的章節文字，每行一個章節 */
  chaptersText: string;
}

/** 把多行文字拆成章節清單（去除空白行與前後空白） */
export function parseChapters(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export interface ExamInfoErrors {
  name?: string;
  examDate?: string;
}

export function validateExamInfo(name: string, examDate: ISODate, today: ISODate): ExamInfoErrors {
  const errors: ExamInfoErrors = {};
  const trimmed = name.trim();
  if (!trimmed) errors.name = '請輸入考試名稱';
  else if (trimmed.length > LIMITS.examNameMax)
    errors.name = `考試名稱最多 ${LIMITS.examNameMax} 個字`;

  if (diffDays(today, examDate) < 0) errors.examDate = '考試日期不能早於今天';
  return errors;
}

export interface SubjectErrors {
  name?: string;
  chapters?: string;
}

export function validateSubject(draft: SubjectDraft, others: SubjectDraft[]): SubjectErrors {
  const errors: SubjectErrors = {};
  const name = draft.name.trim();
  if (!name) errors.name = '請輸入科目名稱';
  else if (name.length > LIMITS.subjectNameMax)
    errors.name = `科目名稱最多 ${LIMITS.subjectNameMax} 個字`;
  else if (others.some((s) => s.id !== draft.id && s.name.trim() === name))
    errors.name = '已經有同名的科目';

  const chapters = parseChapters(draft.chaptersText);
  // 章節為選填：若有填寫則檢查上限；若未填寫，排程引擎會自動以科目名稱安排合理任務
  if (chapters.length > LIMITS.chaptersMax)
    errors.chapters = `一個科目最多 ${LIMITS.chaptersMax} 個章節`;
  else if (chapters.some((c) => c.length > LIMITS.chapterTitleMax))
    errors.chapters = `每個章節名稱最多 ${LIMITS.chapterTitleMax} 個字`;
  return errors;
}

/** 讀書時間設定是否能排出計畫；可以的話回傳 undefined */
export function validateStudyTime(
  prefs: StudyPreferences,
  today: ISODate,
  examDate: ISODate,
): string | undefined {
  if (prefs.restDays.length >= 7) return '每週至少要保留一天讀書';
  if (prefs.dailyMinutes < 15) return '每日可讀書時間至少 15 分鐘';
  if (countStudyDays(today, examDate, prefs.restDays) === 0)
    return '考試前沒有可以讀書的日子，請調整休息日或考試日期';
  return undefined;
}

export function hasErrors(errors: object): boolean {
  return Object.values(errors).some(Boolean);
}
