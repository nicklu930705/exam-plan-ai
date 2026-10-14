import type { VercelRequest, VercelResponse } from '@vercel/node';
import { generateGeminiAdvice } from '../lib/gemini';
import { DEFAULT_OPENAI_MODEL, generateOpenAiAdvice } from '../lib/openai';
import { checkRateLimit } from '../lib/rateLimit';
import type { StructuredAdvice, StudyAdviceRequest, StudyAdviceResponse } from '../lib/types';
import { validateStudyAdviceRequest } from '../lib/validation';

const MAX_PAYLOAD_BYTES = 15 * 1024; // 15 KB
const REQUEST_TIMEOUT_MS = 20 * 1000; // 20 秒安全超時

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

  // 4. 輸入驗證 (Input Validation)
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

  // 5. 決定 AI 提供商 (Provider Selection)
  // 預設為 OpenAI；若設定 AI_PROVIDER=gemini 則切換至 Google Gemini 作為備援
  const explicitProvider = (process.env.AI_PROVIDER || '').trim().toLowerCase();
  const provider = explicitProvider === 'gemini' ? 'gemini' : 'openai';

  const requestStartTime = Date.now();

  // 安全超時包裹器 (執行結束時必定清除計時器，避免記憶體與未捕捉錯誤洩漏)
  const executeWithTimeout = async <T>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('TIMEOUT'));
      }, REQUEST_TIMEOUT_MS);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  // ───── 分支 A: OpenAI API (優先使用，預設 gpt-5.6-luna) ─────
  if (provider === 'openai') {
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey || openaiApiKey.trim().length === 0) {
      console.error('[後端設定錯誤] 尚未在環境變數中設定 OPENAI_API_KEY。');
      return res.status(500).json({
        success: false,
        code: 'API_KEY_MISSING',
        error: '伺服端尚未設定 OPENAI_API_KEY 環境變數，請在 Vercel 專案設定中加入。',
        source: 'fallback_rule_engine',
        disclaimer: DISCLAIMER_TEXT,
      });
    }

    const modelName = (process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL).trim();
    console.log('[AI 後端請求開始]', {
      provider: 'openai',
      model: modelName,
      examName: studyRequest.examName,
    });

    try {
      const openAiPromise = generateOpenAiAdvice(studyRequest, openaiApiKey, modelName);
      const { advice } = await executeWithTimeout(openAiPromise);

      const responsePayload: StudyAdviceResponse = {
        success: true,
        advice,
        source: 'openai_ai',
        disclaimer: DISCLAIMER_TEXT,
      };

      return res.status(200).json(responsePayload);
    } catch (error: any) {
      const elapsed = Date.now() - requestStartTime;
      console.error('[OpenAI 處理失敗]', {
        model: modelName,
        elapsedMs: elapsed,
        status: error?.status,
        code: error?.code,
        message: error?.message,
      });

      if (error?.message === 'TIMEOUT') {
        return res.status(504).json({
          success: false,
          code: 'GATEWAY_TIMEOUT',
          error: 'AI 服務回應逾時 (超過 20 秒)，請稍後再試。',
          source: 'fallback_rule_engine',
          disclaimer: DISCLAIMER_TEXT,
        });
      }

      // OpenAI 401 授權失敗
      if (error?.status === 401 || error?.code === 'invalid_api_key') {
        return res.status(401).json({
          success: false,
          code: 'OPENAI_AUTH_ERROR',
          error: 'OpenAI API Key 無效或未被授權，請檢查 Vercel 環境變數設定。',
          source: 'fallback_rule_engine',
          disclaimer: DISCLAIMER_TEXT,
        });
      }

      // OpenAI 429 額度不足或頻率限制
      if (error?.status === 429 || error?.code === 'insufficient_quota') {
        return res.status(429).json({
          success: false,
          code: 'QUOTA_EXCEEDED',
          error: 'OpenAI 帳戶額度不足或 API 呼叫頻率已達上限，請檢查 OpenAI 帳戶餘額。',
          source: 'fallback_rule_engine',
          disclaimer: DISCLAIMER_TEXT,
        });
      }

      return res.status(500).json({
        success: false,
        code: 'INTERNAL_ERROR',
        error: error?.message || '生成讀書建議時 OpenAI 發生未預期錯誤。',
        source: 'fallback_rule_engine',
        disclaimer: DISCLAIMER_TEXT,
      });
    }
  }

  // ───── 分支 B: Google Gemini API (保留切換備援方案) ─────
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey || geminiApiKey.trim().length === 0) {
    console.error('[後端設定錯誤] 尚未在環境變數中設定 GEMINI_API_KEY。');
    return res.status(500).json({
      success: false,
      code: 'API_KEY_MISSING',
      error: '伺服端尚未設定 GEMINI_API_KEY 環境變數，請確認 Vercel 設定。',
      source: 'fallback_rule_engine',
      disclaimer: DISCLAIMER_TEXT,
    });
  }

  const geminiModel = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  console.log('[AI 後端請求開始]', {
    provider: 'gemini',
    model: geminiModel,
    examName: studyRequest.examName,
  });

  try {
    const geminiPromise = generateGeminiAdvice(studyRequest, geminiApiKey, geminiModel);
    const advice: StructuredAdvice = await executeWithTimeout(geminiPromise);

    const responsePayload: StudyAdviceResponse = {
      success: true,
      advice,
      source: 'gemini_ai',
      disclaimer: DISCLAIMER_TEXT,
    };

    return res.status(200).json(responsePayload);
  } catch (error: any) {
    const elapsed = Date.now() - requestStartTime;
    console.error('[Gemini 處理失敗]', {
      model: geminiModel,
      elapsedMs: elapsed,
      status: error?.status,
      message: error?.message,
    });

    if (error?.message === 'TIMEOUT') {
      return res.status(504).json({
        success: false,
        code: 'GATEWAY_TIMEOUT',
        error: 'AI 服務回應逾時 (超過 20 秒)，請稍後再試。',
        source: 'fallback_rule_engine',
        disclaimer: DISCLAIMER_TEXT,
      });
    }

    const isQuotaError =
      error?.status === 429 ||
      error?.message?.includes('429') ||
      error?.message?.includes('RESOURCE_EXHAUSTED') ||
      error?.message?.includes('quota');

    if (isQuotaError) {
      return res.status(429).json({
        success: false,
        code: 'GEMINI_QUOTA_EXCEEDED',
        error: 'Google Gemini 額度已達頻率上限，請稍候再試。',
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
