/**
 * 考試計畫 AI - 模型費率表與預算成本計算模組
 *
 * 職責：
 * 1. 獨立管理各模型之輸入/輸出 Token 費率 (單位：美元 USD / 1,000,000 Tokens)。
 * 2. 呼叫前保守預估成本（包含安全緩衝），避免並行請求穿透總預算。
 * 3. 呼叫後依 OpenAI 官方回傳之實際 usage 精確結算。
 * 4. 明確標示「預估費用」與「實際費用」之差異，若模型未知則採用高額保守費率並記錄警示。
 */

export interface ModelPricing {
  modelId: string;
  inputPerMillionUSD: number; // 美元 / 百萬輸入 Token
  outputPerMillionUSD: number; // 美元 / 百萬輸出 Token
  description: string;
}

/**
 * 已知模型費率表 (美元 / 1M Tokens)
 */
export const MODEL_PRICING_TABLE: Record<string, ModelPricing> = {
  'gpt-5.6-luna': {
    modelId: 'gpt-5.6-luna',
    inputPerMillionUSD: 0.75,
    outputPerMillionUSD: 1.5,
    description: 'OpenAI gpt-5.6-luna 官方費率',
  },
  'gpt-5-mini': {
    modelId: 'gpt-5-mini',
    inputPerMillionUSD: 0.25,
    outputPerMillionUSD: 1.0,
    description: 'OpenAI gpt-5-mini 官方費率',
  },
  'gpt-4o-mini': {
    modelId: 'gpt-4o-mini',
    inputPerMillionUSD: 0.15,
    outputPerMillionUSD: 0.6,
    description: 'OpenAI gpt-4o-mini 官方費率',
  },
  'gemini-3.8-flash': {
    modelId: 'gemini-3.8-flash',
    inputPerMillionUSD: 0.75,
    outputPerMillionUSD: 1.5,
    description: 'Google Gemini 3.8 Flash 官方費率',
  },
};

/**
 * 未知模型之保守備用費率（防止未知昂貴模型刷爆預算）
 */
const CONSERVATIVE_FALLBACK_PRICING: ModelPricing = {
  modelId: 'unknown-conservative',
  inputPerMillionUSD: 5.0,
  outputPerMillionUSD: 15.0,
  description: '未知模型保守預估費率 (高估避免超支)',
};

/**
 * 取得指定模型費率，若未知則標記 isExact = false
 */
export function getModelPricing(modelId: string): { pricing: ModelPricing; isExact: boolean } {
  const normalized = (modelId || '').trim().toLowerCase();
  const found = MODEL_PRICING_TABLE[normalized];
  if (found) {
    return { pricing: found, isExact: true };
  }
  console.warn(`[費率警告] 模型「${modelId}」未在已知費率表中，採用高額保守費率計費。`);
  return {
    pricing: { ...CONSERVATIVE_FALLBACK_PRICING, modelId },
    isExact: false,
  };
}

/**
 * 計算實際成本（以微美元 Micro-USD 為整數單位，1 USD = 1,000,000 Micro-USD）
 * 使用整數避免浮點數精度誤差
 */
export function calculateTokenCostMicroUSD(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
): {
  costMicroUSD: number; // 微美元整數 (用於 Redis 原子計數)
  costUSD: number; // 美元浮點數 (用於日誌與報表)
  isExactPricing: boolean;
} {
  const { pricing, isExact } = getModelPricing(modelId);

  // inputCostUSD = (promptTokens / 1,000,000) * pricing.inputPerMillionUSD
  // 轉為 microUSD (乘上 1,000,000)：
  const inputCostMicro = Math.round(promptTokens * pricing.inputPerMillionUSD);
  const outputCostMicro = Math.round(completionTokens * pricing.outputPerMillionUSD);
  const totalMicro = Math.max(1, inputCostMicro + outputCostMicro);

  return {
    costMicroUSD: totalMicro,
    costUSD: totalMicro / 1_000_000,
    isExactPricing: isExact,
  };
}

/**
 * 在發送請求前預估最大成本，並附加 20% 安全緩衝（用於預先扣留伺服器預算）
 */
export function estimateMaxCostMicroUSD(
  modelId: string,
  inputChars: number,
  maxOutputTokens: number = 600,
): {
  reservedMicroUSD: number;
  estimatedPromptTokens: number;
} {
  // 繁體中文約 1 字 = 1.5 ~ 2 Tokens，加上系統提示約 300 Tokens
  const estimatedPromptTokens = Math.ceil(inputChars * 1.8) + 300;
  const rawCost = calculateTokenCostMicroUSD(modelId, estimatedPromptTokens, maxOutputTokens);

  // 加上 20% 安全緩衝
  const reservedMicroUSD = Math.ceil(rawCost.costMicroUSD * 1.2);
  return {
    reservedMicroUSD,
    estimatedPromptTokens,
  };
}
