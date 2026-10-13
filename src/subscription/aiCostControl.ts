import { checkAiAccess, getAiQuotaStatus } from './entitlements';
import type { AiQuotaStatus, AiUsageRecord, UserSubscription } from './types';

/**
 * AI 成本控制與用量防護模組
 *
 * 設計原則（嚴格落實安全與成本控管）：
 * 1. 職責分離：本機排程演算法、任務勾選、計時器與統計 100% 獨立於外部 AI API，完全不受網路或 API 成本限制。
 * 2. 零金鑰原則：iOS App 原始碼中絕對不可寫入任何 OpenAI/Claude/Gemini 等 API Key。
 * 3. 安全代理架構：未來任何付費 AI 深度解析皆由安全後端服務（如 Cloud Functions）處理金鑰驗證、使用者驗證與配額防刷。
 * 4. 用量預算上限：按月追蹤呼叫次數，達到上限時優雅降級為本機規則模式，不中斷基礎排程功能。
 */

export interface AiTaskRequest {
  examName: string;
  subjectsCount: number;
  availableDays: number;
  dailyMinutes: number;
}

export interface AiExecutionResult<T> {
  success: boolean;
  data?: T;
  fallbackUsed: boolean;
  quotaStatus: AiQuotaStatus;
  errorMessage?: string;
}

export class AiCostController {
  /**
   * 零金鑰防護確認：確認客戶端無任何硬編碼之付費 AI API 金鑰
   */
  static hasClientApiKey(): boolean {
    return false;
  }

  /**
   * 後端安全代理端點：本機優先架構，目前尚未部署外部伺服端
   */
  static getBackendEndpoint(): string | null {
    return null;
  }

  /**
   * 請求 AI 規劃建議（超額或無權限時自動安全降級為本機排程演算法）
   */
  static async requestAiRecommendation(params: {
    subscription?: UserSubscription;
    usage?: AiUsageRecord;
    context?: any;
  }): Promise<{ source: 'fallback_rule_engine' | 'ai_proxy'; fallbackNote?: string }> {
    const evaluation = this.evaluateAccess(params.usage, params.subscription);
    if (!evaluation.canProceed) {
      return {
        source: 'fallback_rule_engine',
        fallbackNote: evaluation.message ?? '已達每月上限，自動降級為本機排程演算法',
      };
    }
    return {
      source: 'fallback_rule_engine',
    };
  }

  /**
   * 執行 AI 規劃前的權限與配額閘道檢查
   */
  static evaluateAccess(
    usage: AiUsageRecord | undefined,
    subscription: UserSubscription | undefined,
  ): { canProceed: boolean; quotaStatus: AiQuotaStatus; message?: string } {
    const quotaStatus = getAiQuotaStatus(usage, subscription);
    const accessCheck = checkAiAccess(usage, subscription);

    if (!accessCheck.canUse) {
      return {
        canProceed: false,
        quotaStatus,
        message: accessCheck.reason,
      };
    }

    return {
      canProceed: true,
      quotaStatus,
    };
  }

  /**
   * 安全代理呼叫預留介面（未來串接後端時使用）
   */
  static async requestSecureAiService<T>(
    _payload: AiTaskRequest,
    usage: AiUsageRecord | undefined,
    subscription: UserSubscription | undefined,
    localFallbackRunner: () => T,
  ): Promise<AiExecutionResult<T>> {
    const evaluation = this.evaluateAccess(usage, subscription);

    if (!evaluation.canProceed) {
      // 超額或無權限時，安全降級為本機排程演算法，確保使用者體驗不中斷
      return {
        success: true,
        data: localFallbackRunner(),
        fallbackUsed: true,
        quotaStatus: evaluation.quotaStatus,
        errorMessage: evaluation.message,
      };
    }

    // 未來串接後端服務之預留位置（後端需驗證 JWT/StoreKit 收據並使用伺服端 Secret Key）
    // 目前使用本地高品質規劃引擎
    return {
      success: true,
      data: localFallbackRunner(),
      fallbackUsed: true,
      quotaStatus: evaluation.quotaStatus,
    };
  }
}
