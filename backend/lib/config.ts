/**
 * 考試計畫 AI - 後端核心限制與預算配置模組
 *
 * 所有數值集中管理，優先自 Vercel 環境變數讀取，並提供安全的預設值。
 * 若設定值不合法（如小於等於 0 或非數字），自動降級回安全預設值。
 */

function parsePositiveInt(val: string | undefined, defaultVal: number): number {
  if (!val) return defaultVal;
  const parsed = parseInt(val, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultVal;
}

function parsePositiveFloat(val: string | undefined, defaultVal: number): number {
  if (!val) return defaultVal;
  const parsed = parseFloat(val);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultVal;
}

export const AI_CONFIG = {
  // 1. 每日配額 (次 / 日)
  FREE_DAILY_LIMIT: parsePositiveInt(process.env.FREE_DAILY_AI_LIMIT, 3),
  PRO_DAILY_LIMIT: parsePositiveInt(process.env.PRO_DAILY_AI_LIMIT, 15),

  // 2. 單次呼叫限制
  MAX_INPUT_CHARS: parsePositiveInt(process.env.AI_MAX_INPUT_CHARS, 4000),
  MAX_OUTPUT_TOKENS: parsePositiveInt(process.env.AI_MAX_OUTPUT_TOKENS, 600),
  REQUEST_TIMEOUT_MS: parsePositiveInt(process.env.AI_REQUEST_TIMEOUT_MS, 20000),
  MAX_RETRIES: parsePositiveInt(process.env.AI_MAX_RETRIES, 1),
  RATE_LIMIT_PER_MINUTE: parsePositiveInt(process.env.AI_RATE_LIMIT_PER_MINUTE, 3),

  // 3. 伺服器總成本與預算控制 (美元 USD)
  MONTHLY_BUDGET_USD: parsePositiveFloat(process.env.AI_MONTHLY_BUDGET_USD, 5.0),
  DAILY_BUDGET_USD: parsePositiveFloat(process.env.AI_DAILY_BUDGET_USD, 0.5),
  BUDGET_WARNING_PERCENT: parsePositiveFloat(process.env.AI_BUDGET_WARNING_PERCENT, 50.0),

  // 4. 時區設定 (亞洲/台北，每日 00:00:00 重置)
  TIMEZONE: 'Asia/Taipei',

  // 5. 並行鎖定超時時間 (秒)
  CONCURRENCY_LOCK_TTL_SECONDS: 30,

  // 6. 冪等鍵快取保留時間 (秒，預設 10 分鐘)
  IDEMPOTENCY_TTL_SECONDS: 600,
};

/**
 * 取得最新配置（測試時若動態修改 process.env 可重新整理）
 */
export function getAiConfig() {
  return {
    FREE_DAILY_LIMIT: parsePositiveInt(process.env.FREE_DAILY_AI_LIMIT, 3),
    PRO_DAILY_LIMIT: parsePositiveInt(process.env.PRO_DAILY_AI_LIMIT, 15),
    MAX_INPUT_CHARS: parsePositiveInt(process.env.AI_MAX_INPUT_CHARS, 4000),
    MAX_OUTPUT_TOKENS: parsePositiveInt(process.env.AI_MAX_OUTPUT_TOKENS, 600),
    REQUEST_TIMEOUT_MS: parsePositiveInt(process.env.AI_REQUEST_TIMEOUT_MS, 20000),
    MAX_RETRIES: parsePositiveInt(process.env.AI_MAX_RETRIES, 1),
    RATE_LIMIT_PER_MINUTE: parsePositiveInt(process.env.AI_RATE_LIMIT_PER_MINUTE, 3),
    MONTHLY_BUDGET_USD: parsePositiveFloat(process.env.AI_MONTHLY_BUDGET_USD, 5.0),
    DAILY_BUDGET_USD: parsePositiveFloat(process.env.AI_DAILY_BUDGET_USD, 0.5),
    BUDGET_WARNING_PERCENT: parsePositiveFloat(process.env.AI_BUDGET_WARNING_PERCENT, 50.0),
    TIMEZONE: 'Asia/Taipei',
    CONCURRENCY_LOCK_TTL_SECONDS: 30,
    IDEMPOTENCY_TTL_SECONDS: 600,
  };
}
