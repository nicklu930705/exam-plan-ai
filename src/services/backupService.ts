import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import {
  BACKUP_SCHEMA_VERSION,
  CURRENT_APP_NAME,
  MAX_BACKUP_FILE_BYTES,
  type ExamPlanBackupPayload,
} from '../types/backup';
import type { AppData } from '../types/models';

export type ValidationResult =
  | { isValid: true; payload: ExamPlanBackupPayload }
  | { isValid: false; error: string };

/**
 * 產生命名符合規範的備份檔名
 * 格式：考試計畫AI_備份_YYYY-MM-DD.json
 */
export function getBackupFilename(date: Date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `考試計畫AI_備份_${yyyy}-${mm}-${dd}.json`;
}

/**
 * 將目前 AppData 萃取成標準純淨的備份結構
 * 嚴格排除任何敏感資訊（金鑰、裝置識別碼、自訂網址、會員狀態、進行中計時器、AI 配額等）
 */
export function createBackupPayload(
  data: AppData,
  appVersion: string = '1.0.0',
): ExamPlanBackupPayload {
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    appName: CURRENT_APP_NAME,
    appVersion,
    exportedAt: new Date().toISOString(),
    studyData: {
      exams: (data.exams || []).map((e) => ({
        id: e.id,
        name: e.name,
        examDate: e.examDate,
        subjects: (e.subjects || []).map((s) => ({
          id: s.id,
          name: s.name,
          familiarity: s.familiarity,
          chapters: (s.chapters || []).map((c) => ({
            id: c.id,
            title: c.title,
          })),
        })),
        createdAt: e.createdAt,
        archived: e.archived,
      })),
      tasks: (data.tasks || []).map((t) => ({
        id: t.id,
        examId: t.examId,
        subjectId: t.subjectId,
        subjectName: t.subjectName,
        chapterId: t.chapterId,
        title: t.title,
        kind: t.kind,
        date: t.date,
        estimatedMinutes: t.estimatedMinutes,
        actualMinutes: t.actualMinutes,
        timerMinutes: t.timerMinutes,
        status: t.status,
        completedAt: t.completedAt,
      })),
      preferences: {
        dailyMinutes: data.preferences?.dailyMinutes ?? 120,
        restDays: [...(data.preferences?.restDays ?? [0])],
        intensity: data.preferences?.intensity ?? 'normal',
      },
      selectedExamId: data.selectedExamId,
    },
  };
}


/**
 * 檢查是否為合理有效的公曆日期（YYYY-MM-DD，限制 2000 年至 2100 年）
 */
function isValidCalendarDate(dateStr: unknown): boolean {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return false;
  }
  const parts = dateStr.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) {
    return false;
  }
  const dateObj = new Date(Date.UTC(y, m - 1, d));
  return (
    dateObj.getUTCFullYear() === y &&
    dateObj.getUTCMonth() === m - 1 &&
    dateObj.getUTCDate() === d
  );
}

/**
 * 嚴格驗證備份 JSON 字串結構、版本、欄位與資料完整性
 */
export function validateBackupJson(jsonString: string): ValidationResult {
  if (!jsonString || typeof jsonString !== 'string') {
    return { isValid: false, error: '備份檔案內容為空。' };
  }

  // 1. 檔案大小檢查
  if (jsonString.length > MAX_BACKUP_FILE_BYTES) {
    return { isValid: false, error: '備份檔案過大（超過 5MB 上限），無法匯入。' };
  }

  // 2. 解析 JSON
  let parsed: any;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    return { isValid: false, error: '備份檔案損壞或格式不正確（無法解析為 JSON）。' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { isValid: false, error: '備份檔案格式不正確（根節點必須為物件）。' };
  }

  // 3. schemaVersion 檢查
  if (typeof parsed.schemaVersion !== 'number') {
    return { isValid: false, error: '缺少版本標記（schemaVersion）。' };
  }
  if (parsed.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    return {
      isValid: false,
      error: `不支援的備份版本（schemaVersion: ${parsed.schemaVersion}，目前僅支援版本 ${BACKUP_SCHEMA_VERSION}）。`,
    };
  }

  // 4. appName 檢查
  if (typeof parsed.appName !== 'string' || !parsed.appName.includes('考試計畫')) {
    return { isValid: false, error: '此備份檔案並非由「考試計畫 AI」所建立。' };
  }

  // 5. exportedAt 檢查
  if (typeof parsed.exportedAt !== 'string' || isNaN(Date.parse(parsed.exportedAt))) {
    return { isValid: false, error: '缺少或無效的匯出時間（exportedAt）。' };
  }

  // 6. studyData 檢查
  const { studyData } = parsed;
  if (!studyData || typeof studyData !== 'object' || Array.isArray(studyData)) {
    return { isValid: false, error: '備份檔案缺少讀書資料區塊（studyData）。' };
  }

  // 7. exams 檢查
  if (!Array.isArray(studyData.exams)) {
    return { isValid: false, error: '讀書資料中考試清單（exams）必須為陣列。' };
  }
  const examIds = new Set<string>();
  const subjectIds = new Set<string>();
  const examSubjectsMap = new Map<string, Set<string>>();
  const subjectChaptersMap = new Map<string, Set<string>>();

  for (let i = 0; i < studyData.exams.length; i++) {
    const exam = studyData.exams[i];
    if (!exam || typeof exam !== 'object') {
      return { isValid: false, error: `第 ${i + 1} 場考試格式不正確。` };
    }
    if (!exam.id || typeof exam.id !== 'string') {
      return { isValid: false, error: `第 ${i + 1} 場考試缺少有效識別碼（id）。` };
    }
    if (examIds.has(exam.id)) {
      return { isValid: false, error: `備份資料包含重複的考試識別碼：${exam.id}。` };
    }
    examIds.add(exam.id);

    if (!exam.name || typeof exam.name !== 'string' || exam.name.trim() === '') {
      return { isValid: false, error: `第 ${i + 1} 場考試名稱不可為空。` };
    }
    if (!isValidCalendarDate(exam.examDate)) {
      return {
        isValid: false,
        error: `考試「${exam.name}」的日期不正確或非有效公曆日期（須為 2000-2100 年間之 YYYY-MM-DD）。`,
      };
    }
    if (exam.archived !== undefined && typeof exam.archived !== 'boolean') {
      return {
        isValid: false,
        error: `考試「${exam.name}」的封存狀態格式不正確（必須為布林值）。`,
      };
    }
    if (!Array.isArray(exam.subjects)) {
      return { isValid: false, error: `考試「${exam.name}」的科目清單格式不正確。` };
    }

    const currentExamSubjects = new Set<string>();

    for (let j = 0; j < exam.subjects.length; j++) {
      const subj = exam.subjects[j];
      if (!subj || typeof subj !== 'object') {
        return { isValid: false, error: `考試「${exam.name}」的第 ${j + 1} 個科目格式不正確。` };
      }
      if (!subj.id || typeof subj.id !== 'string') {
        return { isValid: false, error: `科目缺少有效識別碼。` };
      }
      if (subjectIds.has(subj.id)) {
        return { isValid: false, error: `備份資料包含重複的科目識別碼：${subj.id}。` };
      }
      subjectIds.add(subj.id);
      currentExamSubjects.add(subj.id);

      if (!subj.name || typeof subj.name !== 'string' || subj.name.trim() === '') {
        return { isValid: false, error: `科目名稱不可為空。` };
      }
      if (![1, 2, 3].includes(subj.familiarity)) {
        return { isValid: false, error: `科目「${subj.name}」的熟悉度數值不正確（必須為 1, 2 或 3）。` };
      }
      if (!Array.isArray(subj.chapters)) {
        return { isValid: false, error: `科目「${subj.name}」的章節清單格式不正確。` };
      }
      const chapSet = new Set<string>();
      for (const chap of subj.chapters) {
        if (!chap || typeof chap !== 'object' || !chap.id || typeof chap.title !== 'string') {
          return { isValid: false, error: `科目「${subj.name}」包含無效章節資料。` };
        }
        chapSet.add(chap.id);
      }
      subjectChaptersMap.set(subj.id, chapSet);
    }

    examSubjectsMap.set(exam.id, currentExamSubjects);
  }

  // 8. tasks 檢查與關聯性完整性
  if (!Array.isArray(studyData.tasks)) {
    return { isValid: false, error: '讀書資料中任務清單（tasks）必須為陣列。' };
  }
  const taskIds = new Set<string>();

  for (let i = 0; i < studyData.tasks.length; i++) {
    const task = studyData.tasks[i];
    if (!task || typeof task !== 'object') {
      return { isValid: false, error: `第 ${i + 1} 項任務格式不正確。` };
    }
    if (!task.id || typeof task.id !== 'string') {
      return { isValid: false, error: `第 ${i + 1} 項任務缺少有效識別碼。` };
    }
    if (taskIds.has(task.id)) {
      return { isValid: false, error: `備份資料包含重複的任務識別碼：${task.id}。` };
    }
    taskIds.add(task.id);

    // 關聯性驗證：examId 必須存在於 exams
    const allowedSubjects = examSubjectsMap.get(task.examId);
    if (!allowedSubjects) {
      return {
        isValid: false,
        error: `任務「${task.title ?? task.id}」所屬的考試不存在（考試與任務關聯不一致）。`,
      };
    }
    // 關聯性驗證：subjectId 必須存在於該考試的科目中（嚴禁跨考試錯置）
    if (!allowedSubjects.has(task.subjectId)) {
      return {
        isValid: false,
        error: `任務「${task.title ?? task.id}」所屬的科目不屬於該場考試（科目與任務關聯不一致）。`,
      };
    }

    // 章節關聯性驗證（若有指定 chapterId）
    if (task.chapterId && typeof task.chapterId === 'string') {
      const allowedChapters = subjectChaptersMap.get(task.subjectId);
      if (allowedChapters && !allowedChapters.has(task.chapterId)) {
        return {
          isValid: false,
          error: `任務「${task.title ?? task.id}」所屬的章節不存在於對應科目中。`,
        };
      }
    }

    if (!task.title || typeof task.title !== 'string') {
      return { isValid: false, error: `第 ${i + 1} 項任務缺少標題。` };
    }
    if (!['study', 'practice', 'review'].includes(task.kind)) {
      return { isValid: false, error: `任務「${task.title}」的類型不正確。` };
    }
    if (!isValidCalendarDate(task.date)) {
      return {
        isValid: false,
        error: `任務「${task.title}」的排程日期非有效公曆日期（須為 2000-2100 年間之 YYYY-MM-DD）。`,
      };
    }
    if (
      typeof task.estimatedMinutes !== 'number' ||
      !Number.isInteger(task.estimatedMinutes) ||
      task.estimatedMinutes < 1 ||
      task.estimatedMinutes > 1440
    ) {
      return { isValid: false, error: `任務「${task.title}」的預估時間必須為合理正整數（1 至 1440 分鐘）。` };
    }
    if (
      task.actualMinutes !== undefined &&
      (typeof task.actualMinutes !== 'number' ||
        !Number.isInteger(task.actualMinutes) ||
        task.actualMinutes < 0 ||
        task.actualMinutes > 10080)
    ) {
      return { isValid: false, error: `任務「${task.title}」的實際讀書時間數值不合理。` };
    }
    if (
      task.timerMinutes !== undefined &&
      (typeof task.timerMinutes !== 'number' ||
        !Number.isInteger(task.timerMinutes) ||
        task.timerMinutes < 0 ||
        task.timerMinutes > 10080)
    ) {
      return { isValid: false, error: `任務「${task.title}」的計時累計時間數值不合理。` };
    }
    if (!['pending', 'done', 'needsReschedule'].includes(task.status)) {
      return { isValid: false, error: `任務「${task.title}」的狀態不正確。` };
    }
    if (
      task.completedAt !== undefined &&
      (typeof task.completedAt !== 'string' || isNaN(Date.parse(task.completedAt)))
    ) {
      return { isValid: false, error: `任務「${task.title}」的完成時間格式不正確。` };
    }
  }

  // 9. preferences 檢查
  const { preferences } = studyData;
  if (!preferences || typeof preferences !== 'object') {
    return { isValid: false, error: '缺少讀書偏好設定（preferences）。' };
  }
  if (
    typeof preferences.dailyMinutes !== 'number' ||
    !Number.isInteger(preferences.dailyMinutes) ||
    preferences.dailyMinutes < 15 ||
    preferences.dailyMinutes > 1440
  ) {
    return { isValid: false, error: '讀書偏好中每日時間數值不合理（須為 15 至 1440 分鐘）。' };
  }
  if (
    !Array.isArray(preferences.restDays) ||
    preferences.restDays.some((d: any) => ![0, 1, 2, 3, 4, 5, 6].includes(d))
  ) {
    return { isValid: false, error: '讀書偏好中每週休息日格式不正確。' };
  }
  if (!['light', 'normal', 'intense'].includes(preferences.intensity)) {
    return { isValid: false, error: '讀書偏好中讀書強度數值不正確。' };
  }

  // 10. 建構純淨、防偽的乾淨 Payload（過濾一切未預期之外掛欄位）
  const cleanPayload: ExamPlanBackupPayload = {
    schemaVersion: parsed.schemaVersion,
    appName: parsed.appName,
    appVersion: typeof parsed.appVersion === 'string' ? parsed.appVersion : '1.0.0',
    exportedAt: parsed.exportedAt,
    studyData: {
      exams: studyData.exams.map((e: any) => ({
        id: e.id,
        name: e.name,
        examDate: e.examDate,
        subjects: e.subjects.map((s: any) => ({
          id: s.id,
          name: s.name,
          familiarity: s.familiarity,
          chapters: (s.chapters || []).map((c: any) => ({
            id: c.id,
            title: c.title,
          })),
        })),
        createdAt: typeof e.createdAt === 'string' ? e.createdAt : new Date().toISOString(),
        archived: Boolean(e.archived),
      })),
      tasks: studyData.tasks.map((t: any) => ({
        id: t.id,
        examId: t.examId,
        subjectId: t.subjectId,
        subjectName: typeof t.subjectName === 'string' ? t.subjectName : undefined,
        chapterId: typeof t.chapterId === 'string' ? t.chapterId : undefined,
        title: t.title,
        kind: t.kind,
        date: t.date,
        estimatedMinutes: t.estimatedMinutes,
        actualMinutes: typeof t.actualMinutes === 'number' ? t.actualMinutes : 0,
        timerMinutes: typeof t.timerMinutes === 'number' ? t.timerMinutes : 0,
        status: t.status,
        completedAt: typeof t.completedAt === 'string' ? t.completedAt : undefined,
      })),
      preferences: {
        dailyMinutes: preferences.dailyMinutes,
        restDays: [...preferences.restDays],
        intensity: preferences.intensity,
      },
      selectedExamId:
        typeof studyData.selectedExamId === 'string' && examIds.has(studyData.selectedExamId)
          ? studyData.selectedExamId
          : studyData.exams[0]?.id,
    },
  };

  return { isValid: true, payload: cleanPayload };
}

/**
 * 內部檔案系統寫入輔助
 * 使用 Expo File/Paths 將內容寫入暫存區
 */
async function writeBackupFile(fileName: string, content: string): Promise<string> {
  const file = new File(Paths.cache, fileName);
  if (file.exists) {
    file.delete();
  }
  file.create();
  file.write(content);
  return file.uri;
}

/**
 * 內部檔案系統讀取輔助
 */
async function readBackupFile(uri: string): Promise<string> {
  const file = new File(uri);
  return await file.text();
}

/**
 * 匯出備份檔案並叫起系統分享面版
 */
export async function exportBackupToFile(
  payload: ExamPlanBackupPayload,
): Promise<{ success: boolean; canceled?: boolean; error?: string }> {
  try {
    const isShareAvailable = await Sharing.isAvailableAsync();
    if (!isShareAvailable) {
      return { success: false, error: '此裝置或執行環境不支援系統檔案分享功能。' };
    }

    const fileName = getBackupFilename(new Date(payload.exportedAt || Date.now()));
    const jsonContent = JSON.stringify(payload, null, 2);
    const fileUri = await writeBackupFile(fileName, jsonContent);

    await Sharing.shareAsync(fileUri, {
      mimeType: 'application/json',
      UTI: 'public.json',
      dialogTitle: '匯出讀書計畫備份',
    });

    return { success: true };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || '匯出備份檔案時發生未預期的錯誤。',
    };
  }
}

/**
 * 叫起系統文件選取器並讀取備份檔案內容
 */
export async function pickAndReadBackupFile(): Promise<
  | { status: 'success'; content: string }
  | { status: 'cancelled' }
  | { status: 'error'; error: string }
> {
  try {
    const result = await DocumentPicker.getDocumentAsync({
      type: ['application/json', 'public.json', '*/*'],
      copyToCacheDirectory: true,
      multiple: false,
    });

    if (result.canceled || !result.assets || result.assets.length === 0) {
      return { status: 'cancelled' };
    }

    const asset = result.assets[0];
    if (asset.size && asset.size > MAX_BACKUP_FILE_BYTES) {
      return { status: 'error', error: '選取的備份檔案過大（超過 5MB 上限）。' };
    }

    const content = await readBackupFile(asset.uri);
    return { status: 'success', content };
  } catch (err: any) {
    return {
      status: 'error',
      error: err?.message || '讀取選取的檔案失敗。',
    };
  }
}
