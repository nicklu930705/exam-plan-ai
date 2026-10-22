import type { VercelRequest, VercelResponse } from '@vercel/node';
import { resolveUserIdentity } from '../lib/identity';
import { getDailyQuotaStatus } from '../lib/redis';

/**
 * 考試計畫 AI - 唯讀每日 AI 額度查詢端點 (GET /api/ai-quota)
 *
 * 核心職責：
 * 1. 唯讀查詢當前使用者（依據 Device ID 與可信任的 Proof Token）今日已用與剩餘 AI 次數。
 * 2. 嚴格不消耗任何額度、不扣除預算、不執行鎖定、不呼叫 OpenAI/Gemini。
 * 3. 供 App 在冷啟動或頁面切換時，安全重整當前額度狀態。
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // 1. CORS 標頭
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-Type, Authorization, X-Client-Device-Id, X-Device-Id, X-Apple-Proof-Token',
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      code: 'METHOD_NOT_ALLOWED',
      error: '僅支援 GET 方法查詢額度。',
    });
  }

  try {
    const identity = await resolveUserIdentity(req, { skipJwsVerification: true });
    const quota = await getDailyQuotaStatus(identity.userId, identity.tier);

    return res.status(200).json({
      success: true,
      quota,
    });
  } catch (err: any) {
    console.error('[AI Quota API Error]:', err?.message || err);
    return res.status(500).json({
      success: false,
      code: 'INTERNAL_ERROR',
      error: '無法取得 AI 額度狀態，請稍後重試。',
    });
  }
}
