import type { Exam, StudyPreferences, StudyTask } from './models';

export const BACKUP_SCHEMA_VERSION = 1;
export const CURRENT_APP_NAME = '考試計畫 AI';
export const MAX_BACKUP_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

/** 備份中包含的純讀書資料（嚴格排除機密金鑰、裝置識別碼、後端網址與會員訂閱） */
export interface BackupStudyData {
  exams: Exam[];
  tasks: StudyTask[];
  preferences: StudyPreferences;
  selectedExamId?: string;
}

/** 匯出與匯入之標準備份 JSON 結構 */
export interface ExamPlanBackupPayload {
  schemaVersion: number;
  appName: string;
  appVersion: string;
  exportedAt: string; // ISO 8601
  studyData: BackupStudyData;
}
