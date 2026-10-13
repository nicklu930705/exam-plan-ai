import type { VercelRequest, VercelResponse } from '@vercel/node';
import { generateGeminiAdvice } from '../lib/gemini';
import { checkRateLimit } from '../lib/rateLimit';
import type { StudyAdviceRequest, StudyAdviceResponse } from '../lib/types';
import { validateStudyAdviceRequest } from '../lib/validation';

const MAX_PAYLOAD_BYTES = 15 * 1024; // 15 KB
const REQUEST_TIMEOUT_MS = 12 * 1000; // 12 秒

const DISCLAIMER_TEXT =
  'AI 建議僅供學習策略與心理激勵參考；每日讀書日程與時間限制仍由排程引擎安全計算。';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // 1. 設定通用 CORS 跨來源存取標頭
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-Type, Authorization',
  );

  // 處理瀏覽器預檢請求 (OPTIONS Preflight)
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 只允許 POST 請求
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: '僅支援 POST 方法。',
      source: 'fallback_rule_engine',
      disclaimer: DISCLAIMER_TEXT,
    });
  }

  // 2. 請求大小限制 (Payload Size Guard)
  const contentLength = Number(req.headers['content-length'] ?? 0);
  if (contentLength > MAX_PAYLOAD_BYTES) {
    return res.status(413).json({
      success: false,
      error: `請求內文過大 (超過 ${MAX_PAYLOAD_BYTES / 1024} KB 上限)。`,
      source: 'fallback_rule_engine',
      disclaimer: DISCLAIMER_TEXT,
    });
  }

  // 3. 來源 IP 簡易防刷限制 (Rate Limiting)
  const forwardedFor = req.headers['x-forwarded-for'];
  const clientIp = typeof forwardedFor === 'string'
    ? forwardedFor.split(',')[0].trim()
    : req.socket?.remoteAddress || 'unknown-client';

  const rateCheck = checkRateLimit(clientIp);
  if (!rateCheck.allowed) {
    res.setHeader('Retry-After', String(rateCheck.resetInSeconds));
    return res.status(429).json({
      success: false,
      code: 'RATE_LIMIT_EXCEEDED',
      error: `請求過於頻繁，請於 ${rateCheck.resetInSeconds} 秒後再試。`,
      source: 'fallback_rule_engine',
      disclaimer: DISCLAIMER_TEXT,
    });
  }

  // 4. 檢查環境變數金鑰
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    console.error('[後端設定錯誤] 尚未在環境變數中設定 GEMINI_API_KEY。');
    return res.status(500).json({
      success: false,
      code: 'API_KEY_MISSING',
      error: '伺服端尚未設定 GEMINI_API_KEY 環境變數，請確認 Vercel 設定。',
      source: 'fallback_rule_engine',
      disclaimer: DISCLAIMER_TEXT,
    });
  }

  const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

  // 5. 輸入驗證 (Input Validation)
  const validation = validateStudyAdviceRequest(req.body);
  if (!validation.valid) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_INPUT',
      error: validation.message || '輸入資料不符合規範。',
      source: 'fallback_rule_engine',
      disclaimer: DISCLAIMER_TEXT,
    });
  }

  const studyRequest = req.body as StudyAdviceRequest;

  // 6. 逾時中斷保護 (Timeout Guard)
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error('TIMEOUT'));
    }, REQUEST_TIMEOUT_MS);
  });

  try {
    const advice = await Promise.race([
      generateGeminiAdvice(studyRequest, apiKey, modelName),
      timeoutPromise,
    ]);

    const responsePayload: StudyAdviceResponse = {
      success: true,
      advice,
      source: 'gemini_ai',
      disclaimer: DISCLAIMER_TEXT,
    };

    return res.status(200).json(responsePayload);
  } catch (error: any) {
    console.error('[Gemini API 處理失敗]', error);

    if (error?.message === 'TIMEOUT') {
      return res.status(504).json({
        success: false,
        code: 'GATEWAY_TIMEOUT',
        error: 'AI 服務回應逾時 (超過 12 秒)，請稍後再試。',
        source: 'fallback_rule_engine',
        disclaimer: DISCLAIMER_TEXT,
      });
    }

    // Google API Quota 429 處理
    const isQuotaError =
      error?.status === 429 ||
      error?.message?.includes('429') ||
      error?.message?.includes('RESOURCE_EXHAUSTED') ||
      error?.message?.includes('quota');

    if (isQuotaError) {
      return res.status(429).json({
        success: false,
        code: 'GEMINI_QUOTA_EXCEEDED',
        error: 'Google Gemini 免費額度已達每分鐘頻率上限，請稍候 30 秒再試。',
        source: 'fallback_rule_engine',
        disclaimer: DISCLAIMER_TEXT,
      });
    }

    return res.status(500).json({
      success: false,
      code: 'INTERNAL_ERROR',
      error: error?.message || '生成讀書建議時發生未預期錯誤。',
      source: 'fallback_rule_engine',
      disclaimer: DISCLAIMER_TEXT,
    });
  }
}
