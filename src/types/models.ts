/**
 * 資料模型
 * 日期一律使用本地日期字串 'YYYY-MM-DD'，避免時區造成日期偏移。
 */

import type { AiUsageRecord, UserSubscription } from '../subscription/types';

/** 0 = 星期日, 1 = 星期一, ..., 6 = 星期六（與 JavaScript Date.getDay() 一致） */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** 熟悉程度：1 不熟、2 普通、3 熟悉 */
export type Familiarity = 1 | 2 | 3;

/** 讀書強度 */
export type Intensity = 'light' | 'normal' | 'intense';

export type ISODate = string; // 'YYYY-MM-DD'

export interface Chapter {
  id: string;
  title: string;
}

export interface Subject {
  id: string;
  name: string;
  familiarity: Familiarity;
  chapters: Chapter[];
}

export interface Exam {
  id: string;
  name: string;
  examDate: ISODate;
  subjects: Subject[];
  createdAt: string; // ISO timestamp
  archived?: boolean; // 是否封存（保留歷史與紀錄，但從現有日常排程中隱藏）
}

export type TaskKind = 'study' | 'practice' | 'review';

/**
 * 任務狀態
 * - pending：尚未完成
 * - done：已完成
 * - needsReschedule：使用者標記需要重新安排
 */
export type TaskStatus = 'pending' | 'done' | 'needsReschedule';

export interface StudyTask {
  id: string;
  examId: string;
  subjectId: string;
  subjectName?: string;
  chapterId?: string;
  title: string;
  kind: TaskKind;
  date: ISODate;
  estimatedMinutes: number;
  /** 實際讀書累計時間（分鐘），包含計時與手動調整，與預估時間分開記錄 */
  actualMinutes?: number;
  /** 由專注計時器累計的分鐘數 */
  timerMinutes?: number;
  status: TaskStatus;
  completedAt?: string;
}

/** 進行中的讀書計時器狀態 */
export interface ActiveTimer {
  taskId: string;
  taskTitle: string;
  subjectName?: string;
  examId?: string;
  /** 本段計時開始時間（Unix 毫秒時間戳） */
  startedAt: number;
  /** 之前各暫停片段累計的秒數 */
  accumulatedSeconds: number;
  /** 是否正在計時中（false 表示暫停中） */
  isRunning: boolean;
}

/** 使用者的讀書偏好（全域設定，建立考試時也會沿用並可修改） */
export interface StudyPreferences {
  dailyMinutes: number;
  restDays: Weekday[];
  intensity: Intensity;
}

export interface AppData {
  exams: Exam[];
  tasks: StudyTask[];
  preferences: StudyPreferences;
  /** 當前聚焦的考試 ID（剛建立或使用者最後選取的考試） */
  selectedExamId?: string;
  /** 是否為示範資料（讓介面可以清楚標示） */
  isDemo: boolean;
  /** 當前全域進行中的讀書計時器 */
  activeTimer?: ActiveTimer | null;
  /** 使用者目前方案與訂閱狀態 */
  subscription?: UserSubscription;
  /** 本機記錄之 AI 呼叫用量記錄（按月統計） */
  aiUsage?: AiUsageRecord;
}
