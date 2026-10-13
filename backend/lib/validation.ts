import type { StudyAdviceRequest, SubjectInput } from './types';

export interface ValidationResult {
  valid: boolean;
  message?: string;
}

/**
 * 驗證請求資料是否合法、安全且符合規範
 */
export function validateStudyAdviceRequest(body: unknown): ValidationResult {
  if (!body || typeof body !== 'object') {
    return { valid: false, message: '請求內文必須為 JSON 物件。' };
  }

  const req = body as Partial<StudyAdviceRequest>;

  // 1. 考試名稱
  if (!req.examName || typeof req.examName !== 'string' || req.examName.trim().length === 0) {
    return { valid: false, message: 'examName 必須為非空白字串。' };
  }
  if (req.examName.length > 80) {
    return { valid: false, message: 'examName 字數不得超過 80 字。' };
  }

  // 2. 考試日期 (YYYY-MM-DD)
  if (!req.examDate || typeof req.examDate !== 'string') {
    return { valid: false, message: 'examDate 必須為日期字串。' };
  }
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(req.examDate)) {
    return { valid: false, message: 'examDate 格式必須為 YYYY-MM-DD。' };
  }
  const parsedDate = new Date(req.examDate);
  if (isNaN(parsedDate.getTime())) {
    return { valid: false, message: 'examDate 並非有效日期。' };
  }

  // 3. 每日可用讀書分鐘數
  if (
    typeof req.dailyAvailableMinutes !== 'number' ||
    req.dailyAvailableMinutes < 10 ||
    req.dailyAvailableMinutes > 960
  ) {
    return { valid: false, message: 'dailyAvailableMinutes 必須介於 10 到 960 分鐘之間。' };
  }

  // 4. 科目清單
  if (!Array.isArray(req.subjects) || req.subjects.length === 0) {
    return { valid: false, message: 'subjects 必須為至少包含 1 個科目的陣列。' };
  }
  if (req.subjects.length > 20) {
    return { valid: false, message: '科目數量上限為 20 科。' };
  }

  for (let i = 0; i < req.subjects.length; i++) {
    const s = req.subjects[i] as Partial<SubjectInput>;
    if (!s.name || typeof s.name !== 'string' || s.name.trim().length === 0) {
      return { valid: false, message: `第 ${i + 1} 個科目名稱不可為空。` };
    }
    if (s.name.length > 50) {
      return { valid: false, message: `第 ${i + 1} 個科目名稱不可超過 50 字。` };
    }
    if (typeof s.familiarity !== 'number' || ![1, 2, 3].includes(s.familiarity)) {
      return { valid: false, message: `第 ${i + 1} 個科目的熟悉度必須為 1 (不熟)、2 (普通) 或 3 (熟悉)。` };
    }
  }

  // 5. 完成率與落後任務防呆
  if (
    req.recentCompletionRate !== undefined &&
    (typeof req.recentCompletionRate !== 'number' ||
      req.recentCompletionRate < 0 ||
      req.recentCompletionRate > 100)
  ) {
    return { valid: false, message: 'recentCompletionRate 必須介於 0 到 100 之間。' };
  }

  if (
    req.behindTasksCount !== undefined &&
    (typeof req.behindTasksCount !== 'number' || req.behindTasksCount < 0)
  ) {
    return { valid: false, message: 'behindTasksCount 必須為非負整數。' };
  }

  return { valid: true };
}
