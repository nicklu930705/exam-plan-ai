import type { IncomingMessage, ServerResponse } from 'http';
import { getAiConfig } from '../lib/config';
import { getRedisClient } from '../lib/redis';

/**
 * 考試計畫 AI - 系統健康檢查端點 (GET /api/health)
 *
 * 安全原則：
 * 1. 僅允許 GET 請求。
 * 2. 測試 Upstash Redis 連線與響應延遲。
 * 3. 絕不回傳任何 API Key、Redis Token、URL 或敏感內部資料。
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const redisConfigured = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
  let redisStatus = 'disconnected';
  let redisLatencyMs: number | undefined;

  if (redisConfigured || process.env.MOCK_REDIS === 'true') {
    try {
      const client = getRedisClient();
      const startTime = Date.now();
      // 僅執行簡單只讀指令，不洩漏任何內部資料與金鑰
      await client.eval("return 'PONG'", [], []);
      redisLatencyMs = Date.now() - startTime;
      redisStatus = 'connected';
    } catch {
      redisStatus = 'error';
    }
  }

  const openAiConfigured = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0);
  const geminiConfigured = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 0);
  const config = getAiConfig();

  const isHealthy = redisStatus === 'connected' && (openAiConfigured || geminiConfigured);

  res.statusCode = isHealthy ? 200 : 503;
  res.end(
    JSON.stringify({
      status: isHealthy ? 'healthy' : 'degraded',
      redis: {
        configured: redisConfigured,
        status: redisStatus,
        latencyMs: redisLatencyMs,
      },
      ai: {
        provider: process.env.AI_PROVIDER || 'openai',
        model: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
        openaiConfigured: openAiConfigured,
        geminiConfigured: geminiConfigured,
      },
      quotaRules: {
        freeDailyLimit: config.FREE_DAILY_LIMIT,
        proDailyLimit: config.PRO_DAILY_LIMIT,
        rateLimitPerMinute: config.RATE_LIMIT_PER_MINUTE,
        dailyBudgetUSD: config.DAILY_BUDGET_USD,
        monthlyBudgetUSD: config.MONTHLY_BUDGET_USD,
        timezone: config.TIMEZONE,
      },
      timestamp: new Date().toISOString(),
    }),
  );
}
