/**
 * 考試計畫 AI - 後端 API 型別定義
 */

export interface SubjectInput {
  name: string;
  familiarity: number; // 1 = 不熟, 2 = 普通, 3 = 熟悉
  totalChapters?: number;
  completedChapters?: number;
}

export interface StudyAdviceRequest {
  examName: string;
  examDate: string; // 'YYYY-MM-DD'
  dailyAvailableMinutes: number;
  intensity?: 'light' | 'normal' | 'intense';
  subjects: SubjectInput[];
  recentCompletionRate?: number; // 0-100
  behindTasksCount?: number;
}

export interface StructuredAdvice {
  summary: string;
  focusSubjects: string[];
  actionableTips: string[];
  estimatedFeasibility: string;
}

export interface StudyAdviceResponse {
  success: boolean;
  advice?: StructuredAdvice;
  source: 'openai_ai' | 'gemini_ai' | 'fallback_rule_engine';
  disclaimer: string;
  error?: string;
  code?: string;
}
