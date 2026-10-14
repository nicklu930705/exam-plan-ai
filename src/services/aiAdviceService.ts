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
  source: 'openai_ai' | 'gemini_ai' | 'fallback_rule_engine';
  disclaimer: string;
  error?: string;
  code?: string;
}

export type AiAdviceStatus =
  | 'idle'
  | 'loading'
  | 'success'
  | 'quota_exceeded'
  | 'network_error'
  | 'timeout'
  | 'error';

export interface AiAdviceServiceResult {
  success: boolean;
  status?: AiAdviceStatus;
  advice?: StructuredAdvice;
  source: 'openai_ai' | 'gemini_ai' | 'fallback_rule_engine';
  quotaStatus?: AiQuotaStatus;
  disclaimer: string;
  note?: string;
  error?: string;
  errorCode?: string;
}

export interface RequestAiStudyAdviceParams {
  request: StudyAdviceRequest;
  subscription?: UserSubscription;
  aiUsage?: AiUsageRecord;
  customBackendUrl?: string | null;
  /** 是否強制連線呼叫後端 AI（用於使用者主動點擊時，避免因方案阻擋真實測試） */
  forceAi?: boolean;
  /** 當 API 失敗時，是否不使用假資料頂替而是真實回報錯誤（符合使用者原則 7） */
  strictError?: boolean;
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

export function logDiagnostic(event: string, payload?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [AI_DIAGNOSTIC] ${event}`, payload ? JSON.stringify(payload) : '');
}

/**
 * 對後端 Vercel Serverless Function 發送請求
 */
export async function fetchFromBackendApi(
  request: StudyAdviceRequest,
  backendUrl: string,
  timeoutMs = 30000,
): Promise<StudyAdviceResponse> {
  const startTime = Date.now();

  // 規範化後端 URL，強制確保包含 https:// 協定，避免重複 /api 或遺漏
  let cleanBase = backendUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(cleanBase)) {
    cleanBase = `https://${cleanBase}`;
  }
  if (cleanBase.endsWith('/api/study-advice')) {
    // 已經包含完整路徑
  } else if (cleanBase.endsWith('/api')) {
    cleanBase = `${cleanBase}/study-advice`;
  } else {
    cleanBase = `${cleanBase}/api/study-advice`;
  }
  const targetUrl = cleanBase;

  logDiagnostic('AI_REQUEST_STARTED', {
    targetUrl,
    examName: request.examName,
    examDate: request.examDate,
    timeoutMs,
  });

  const controller = new AbortController();
  let timerId: ReturnType<typeof setTimeout> | null = null;

  // 使用 Promise.race 建立強制超時保證，timeout 獨立 reject，不依賴 fetch 的 AbortController
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        // 忽略中斷例外
      }
      const timeoutError = new Error('TIMEOUT');
      timeoutError.name = 'TimeoutError';
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    const fetchPromise = fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    const res = await Promise.race([fetchPromise, timeoutPromise]);
    if (timerId) clearTimeout(timerId);

    const elapsed = Date.now() - startTime;
    logDiagnostic('AI_RESPONSE_RECEIVED', {
      status: res.status,
      statusText: res.statusText,
      elapsedMs: elapsed,
    });

    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }

    if (!res.ok) {
      const rawError = json?.error;
      let code =
        json?.code ||
        (res.status === 429
          ? 'QUOTA_EXCEEDED'
          : res.status === 504
            ? 'TIMEOUT'
            : res.status === 503
              ? 'SERVICE_UNAVAILABLE'
              : res.status === 500
                ? 'INTERNAL_ERROR'
                : 'API_ERROR');

      let errorMsg = rawError;
      if (rawError && typeof rawError === 'string') {
        if (
          rawError.includes('high demand') ||
          rawError.includes('UNAVAILABLE') ||
          rawError.includes('"code":503')
        ) {
          code = 'SERVICE_UNAVAILABLE';
          errorMsg = 'Google Gemini 模型目前處於高負載尖峰，為暫時性現象，請稍候片刻後點擊「重新嘗試」。';
        } else if (rawError.includes('quota') || rawError.includes('RESOURCE_EXHAUSTED')) {
          code = 'QUOTA_EXCEEDED';
          errorMsg = 'Google Gemini API 呼叫額度暫時達上限，請稍候 30 秒再試。';
        } else {
          try {
            const parsed = JSON.parse(rawError);
            if (parsed?.error?.message) {
              errorMsg = parsed.error.message;
            }
          } catch {
            // rawError 不是 JSON 字串，維持原內容
          }
        }
      }

      if (!errorMsg) {
        if (res.status === 429) {
          errorMsg = 'AI 伺服器流量或 Google API 頻率已達上限，請稍候 30 秒再試。';
        } else if (res.status === 504) {
          errorMsg = 'AI 服務回應逾時 (超過 30 秒)，請稍後再試。';
        } else if (res.status === 503) {
          errorMsg = 'Google Gemini 模型伺服器暫時繁忙，請點擊下方重新嘗試。';
        } else if (res.status === 500) {
          errorMsg = 'AI 雲端服務內部發生錯誤，請稍後重試。';
        } else {
          errorMsg = `伺服器回應錯誤 (HTTP ${res.status})`;
        }
      }

      logDiagnostic('AI_REQUEST_FAILED', {
        status: res.status,
        code,
        error: errorMsg,
        elapsedMs: elapsed,
      });

      return {
        success: false,
        source: 'fallback_rule_engine',
        disclaimer: 'AI 建議僅供學習策略與心理激勵參考。',
        error: errorMsg,
        code,
      };
    }

    // 當 HTTP 200 但後端業務邏輯宣告失敗時
    if (json && json.success === false) {
      logDiagnostic('AI_REQUEST_FAILED', {
        code: json.code,
        error: json.error,
        elapsedMs: elapsed,
      });
      return {
        success: false,
        source: 'fallback_rule_engine',
        disclaimer: json.disclaimer || 'AI 建議僅供學習策略參考。',
        error: json.error || '後端回傳未成功，請稍後重試。',
        code: json.code || 'API_ERROR',
      };
    }

    logDiagnostic('AI_RESPONSE_PARSED', {
      source: json?.source,
      hasAdvice: !!json?.advice,
      elapsedMs: elapsed,
    });

    return json as StudyAdviceResponse;
  } catch (err: any) {
    if (timerId) clearTimeout(timerId);
    const elapsed = Date.now() - startTime;
    const isTimeout =
      err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.message === 'TIMEOUT';

    const code = isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR';
    const errorMsg = isTimeout
      ? '連線逾時（超過 30 秒），伺服器處理時間過長，請檢查網路或稍後重試。'
      : '網路連線失敗，請檢查 iPhone 網路連線是否正常。';

    logDiagnostic('AI_REQUEST_FAILED', {
      isTimeout,
      errorName: err?.name,
      errorMessage: err?.message,
      elapsedMs: elapsed,
      code,
    });

    return {
      success: false,
      source: 'fallback_rule_engine',
      disclaimer: 'AI 建議僅供學習策略與心理激勵參考。',
      error: errorMsg,
      code,
    };
  }
}

/**
 * 智慧讀書建議請求主函式
 * 完整整合會員等級檢查、用量額度防護、後端呼叫與本機無縫降級
 */
export async function requestAiStudyAdvice(
  params: RequestAiStudyAdviceParams,
): Promise<AiAdviceServiceResult> {
  const { request, subscription, aiUsage, customBackendUrl, forceAi = false, strictError = false } = params;

  const quotaStatus = getAiQuotaStatus(aiUsage, subscription);

  // 1. 若非強制呼叫，執行會員等級與額度防護檢查（Free 免費版或已超額使用者）
  if (!forceAi && subscription) {
    const accessCheck = checkAiAccess(aiUsage, subscription);
    if (!accessCheck.canUse) {
      if (strictError) {
        return {
          success: false,
          status: 'quota_exceeded',
          source: 'fallback_rule_engine',
          quotaStatus,
          disclaimer: '此建議由本機排程演算法客觀計算生成。',
          error: accessCheck.reason,
        };
      }
      const localAdvice = generateLocalRuleAdvice(request);
      return {
        success: true,
        status: 'success',
        advice: localAdvice,
        source: 'fallback_rule_engine',
        quotaStatus,
        disclaimer: '此建議由本機排程演算法客觀計算生成。',
        note: accessCheck.reason ?? '升級 Pro 會員即可解鎖 Gemini AI 深度個人化教練。',
      };
    }
  }

  // 2. 解析後端伺服器端點
  // 當明確傳入 customBackendUrl: null 時視為未設定端點
  const backendUrl =
    customBackendUrl !== undefined
      ? (customBackendUrl && customBackendUrl.trim().length > 0 ? customBackendUrl.trim() : null)
      : await getBackendUrlFromStorage();

  // 若尚未設定後端 URL
  if (!backendUrl) {
    if (strictError) {
      return {
        success: false,
        status: 'error',
        source: 'fallback_rule_engine',
        quotaStatus,
        disclaimer: '尚未設定 AI 雲端伺服器網址。',
        error: '尚未設定 AI 雲端伺服器網址，請在「設定 > AI 雲端服務」確認。',
      };
    }
    const localAdvice = generateLocalRuleAdvice(request);
    return {
      success: true,
      status: 'success',
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
      status: 'success',
      advice: backendRes.advice,
      source: backendRes.source ?? 'openai_ai',
      quotaStatus,
      disclaimer: backendRes.disclaimer,
    };
  }

  // 4. 後端失敗（429、500、連線逾時、網路中斷等）處理
  if (strictError) {
    let status: AiAdviceStatus = 'error';
    if (backendRes.code === 'QUOTA_EXCEEDED' || backendRes.code === 'RATE_LIMIT_EXCEEDED') {
      status = 'quota_exceeded';
    } else if (backendRes.code === 'TIMEOUT' || backendRes.code === 'GATEWAY_TIMEOUT') {
      status = 'timeout';
    } else if (backendRes.code === 'NETWORK_ERROR') {
      status = 'network_error';
    } else if (backendRes.code === 'SERVICE_UNAVAILABLE') {
      status = 'error';
    }

    const finalResult: AiAdviceServiceResult = {
      success: false,
      status,
      source: backendRes.source ?? 'openai_ai',
      quotaStatus,
      disclaimer: backendRes.disclaimer || 'AI 建議僅供學習策略與心理激勵參考。',
      error: backendRes.error || 'AI 伺服器回應異常，請稍後再試。',
      errorCode: backendRes.code,
    };

    console.log('[AI Service] AI 請求結束（嚴格錯誤模式）', {
      status: finalResult.status,
      errorCode: finalResult.errorCode,
      error: finalResult.error,
    });

    return finalResult;
  }

  // 非嚴格模式下，安全切換至本機演算法（相容舊測試）
  const localAdvice = generateLocalRuleAdvice(request);
  const failureNote =
    backendRes.code === 'QUOTA_EXCEEDED'
      ? 'Google Gemini API 免費額度暫時用盡，已自動切換為本機排程演算法。'
      : `AI 伺服器暫時無法回應（${backendRes.error}），已自動啟用本機排程建議。`;

  return {
    success: true,
    status: 'success',
    advice: localAdvice,
    source: 'fallback_rule_engine',
    quotaStatus,
    disclaimer: 'AI 連線異常，已為您切換為本機排程演算法。',
    note: failureNote,
    error: backendRes.error,
  };
}
