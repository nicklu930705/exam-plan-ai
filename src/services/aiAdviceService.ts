/**
 * 考試計畫 AI - Gemini AI 讀書建議客戶端服務
 *
 * 設計原則（嚴格落實安全與成本控管）：
 * 1. 零金鑰原則：本前端 App 嚴禁存在任何 Gemini API 金鑰或付費密鑰。
 * 2. 伺服端代理：呼叫獨立後端 /api/study-advice，由後端環境變數安全保管 GEMINI_API_KEY。
 * 3. 優雅降級：若離線、逾時、伺服端配額耗盡（429）或尚未設定後端網址，自動無縫切換為高品質本機排程演算法，絕不中斷學習流程。
 * 4. 職責分離：AI 只提供學習輔導建議與策略分析，絕不直接篡改本機確定性排程資料。
 */

import { getBackendUrlFromStorage } from '../storage';
import { checkAiAccess, getAiQuotaStatus } from '../subscription/entitlements';
import type { AiQuotaStatus, AiUsageRecord, UserSubscription } from '../subscription/types';
import { diffDays } from '../utils/date';

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
  source: 'gemini_ai' | 'fallback_rule_engine';
  disclaimer: string;
  error?: string;
  code?: string;
}

export interface AiAdviceServiceResult {
  success: boolean;
  advice: StructuredAdvice;
  source: 'gemini_ai' | 'fallback_rule_engine';
  quotaStatus: AiQuotaStatus;
  disclaimer: string;
  note?: string;
  error?: string;
}

/**
 * 產生高品質的本機確定性規則建議（離線、未設定伺服端或額度耗盡時自動備援）
 */
export function generateLocalRuleAdvice(request: StudyAdviceRequest): StructuredAdvice {
  const { examName, examDate, dailyAvailableMinutes, subjects, recentCompletionRate = 100, behindTasksCount = 0 } = request;

  const todayStr = new Date().toISOString().slice(0, 10);
  const daysLeft = Math.max(0, diffDays(todayStr, examDate));

  // 弱科（熟悉度 1 最優先，其次 2）
  const weakSubjects = subjects.filter((s) => s.familiarity === 1).map((s) => s.name);
  const moderateSubjects = subjects.filter((s) => s.familiarity === 2).map((s) => s.name);
  const focusSubjects =
    weakSubjects.length > 0
      ? weakSubjects
      : moderateSubjects.length > 0
        ? moderateSubjects
        : subjects.slice(0, 2).map((s) => s.name);

  // 1. 總結分析
  let summary = `距離「${examName}」還有 ${daysLeft} 天，每日預計研讀 ${dailyAvailableMinutes} 分鐘。`;
  if (behindTasksCount > 0) {
    summary += ` 目前有 ${behindTasksCount} 項任務進度落後，建議先透過智慧排程平衡每日負荷。`;
  } else if (recentCompletionRate >= 80) {
    summary += ` 近期完成率達 ${recentCompletionRate}%，整體進度維持良好節奏。`;
  } else {
    summary += ` 目前進度稍微趨緩，可適度縮短單次研讀時段，提高專注效率。`;
  }

  // 2. 具體可執行的行動提示
  const tips: string[] = [];
  if (focusSubjects.length > 0) {
    tips.push(`將前半段精力集中於弱項科目「${focusSubjects.join('、')}」，在精力最充沛時先攻克困難觀念。`);
  }
  if (behindTasksCount > 0) {
    tips.push('利用「智慧重新排程」將落後章節自動平攤至後續讀書日，避免考前累積壓力。');
  } else {
    tips.push('每研讀 45-50 分鐘安排 10 分鐘短暫休息，維持高專注度與吸收效果。');
  }
  if (daysLeft <= 14) {
    tips.push('考前衝刺階段應著重全真模擬試題演練與錯題訂正，減少全新觀念的涉略。');
  } else {
    tips.push('持續按計畫勾選每日任務與計時打卡，建立穩定的讀書慣性。');
  }

  // 3. 可行性評估
  let feasibility = '';
  if (daysLeft === 0) {
    feasibility = '今天是考試日，請保持平常心、沉著應試！';
  } else if (daysLeft < 7 && behindTasksCount > 3) {
    feasibility = '考期緊迫且有積累任務，建議優先聚焦核心必考題型，適度捨棄低權重細節。';
  } else if (dailyAvailableMinutes >= 90) {
    feasibility = '每日時間充裕，只要穩定推進每日排程，達成目標可行性高。';
  } else {
    feasibility = '每日時間精實，建議專注核心章節並利用零碎時間複習關鍵字卡。';
  }

  return {
    summary,
    focusSubjects,
    actionableTips: tips,
    estimatedFeasibility: feasibility,
  };
}

/**
 * 對後端 Vercel Serverless Function 發送請求
 */
export async function fetchFromBackendApi(
  request: StudyAdviceRequest,
  backendUrl: string,
  timeoutMs = 12000,
): Promise<StudyAdviceResponse> {
  const cleanBase = backendUrl.trim().replace(/\/+$/, '');
  const targetUrl = cleanBase.endsWith('/api/study-advice')
    ? cleanBase
    : `${cleanBase}/api/study-advice`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    clearTimeout(timer);

    const json = (await res.json()) as StudyAdviceResponse;

    if (!res.ok) {
      return {
        success: false,
        source: 'fallback_rule_engine',
        disclaimer: 'AI 服務暫時無法連線，已為您切換為本機規則建議。',
        error: json.error || `HTTP ${res.status}: ${res.statusText}`,
        code: json.code || (res.status === 429 ? 'QUOTA_EXCEEDED' : 'API_ERROR'),
      };
    }

    return json;
  } catch (err: any) {
    clearTimeout(timer);
    const isTimeout = err?.name === 'AbortError';
    return {
      success: false,
      source: 'fallback_rule_engine',
      disclaimer: '網路連線逾時或後端未回應，已切換為本機排程演算法。',
      error: isTimeout ? '連線逾時（超過 12 秒）' : (err?.message ?? '網路請求失敗'),
      code: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
    };
  }
}

/**
 * 智慧讀書建議請求主函式
 * 完整整合會員等級檢查、用量額度防護、後端呼叫與本機無縫降級
 */
export async function requestAiStudyAdvice(params: {
  request: StudyAdviceRequest;
  subscription?: UserSubscription;
  aiUsage?: AiUsageRecord;
  customBackendUrl?: string | null;
}): Promise<AiAdviceServiceResult> {
  const { request, subscription, aiUsage, customBackendUrl } = params;

  const quotaStatus = getAiQuotaStatus(aiUsage, subscription);
  const accessCheck = checkAiAccess(aiUsage, subscription);

  // 1. 會員等級與額度防護檢查（Free 免費版或已超額使用者）
  if (!accessCheck.canUse) {
    const localAdvice = generateLocalRuleAdvice(request);
    return {
      success: true,
      advice: localAdvice,
      source: 'fallback_rule_engine',
      quotaStatus,
      disclaimer: '此建議由本機排程演算法客觀計算生成。',
      note: accessCheck.reason ?? '升級 Pro 會員即可解鎖 Gemini AI 深度個人化教練。',
    };
  }

  // 2. 解析後端伺服器端點
  const backendUrl =
    (customBackendUrl && customBackendUrl.trim().length > 0)
      ? customBackendUrl.trim()
      : await getBackendUrlFromStorage();

  // 若尚未設定後端 URL，提供明確友善的本機降級建議
  if (!backendUrl) {
    const localAdvice = generateLocalRuleAdvice(request);
    return {
      success: true,
      advice: localAdvice,
      source: 'fallback_rule_engine',
      quotaStatus,
      disclaimer: '目前尚未設定 AI 雲端伺服器網址，已自動由本機排程引擎為您分析。',
      note: '提示：您可在「設定 > AI 雲端服務」填入您的 Vercel 後端網址以啟用 Gemini AI。',
    };
  }

  // 3. 呼叫後端安全代理
  const backendRes = await fetchFromBackendApi(request, backendUrl);

  if (backendRes.success && backendRes.advice) {
    return {
      success: true,
      advice: backendRes.advice,
      source: 'gemini_ai',
      quotaStatus,
      disclaimer: backendRes.disclaimer,
    };
  }

  // 4. 後端失敗（429、500、連線逾時等）時，安全切換至本機演算法
  const localAdvice = generateLocalRuleAdvice(request);
  const failureNote =
    backendRes.code === 'QUOTA_EXCEEDED'
      ? 'Google Gemini API 免費額度暫時用盡，已自動切換為本機排程演算法。'
      : `AI 伺服器暫時無法回應（${backendRes.error}），已自動啟用本機排程建議。`;

  return {
    success: true,
    advice: localAdvice,
    source: 'fallback_rule_engine',
    quotaStatus,
    disclaimer: 'AI 連線異常，已為您切換為本機排程演算法。',
    note: failureNote,
    error: backendRes.error,
  };
}
