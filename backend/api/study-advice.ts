import crypto from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getAiConfig } from '../lib/config';
import { generateGeminiAdvice } from '../lib/gemini';
import { resolveUserIdentity } from '../lib/identity';
import { DEFAULT_OPENAI_MODEL, generateOpenAiAdvice } from '../lib/openai';
import { estimateMaxCostMicroUSD } from '../lib/pricing';
import {
  postCallSettleFailure,
  postCallSettleSuccess,
  preFlightQuotaAndBudgetCheck,
} from '../lib/redis';
import { getNextTaipeiResetIso } from '../lib/timezone';
import type { StudyAdviceRequest, StudyAdviceResponse } from '../lib/types';
import { validateStudyAdviceRequest } from '../lib/validation';

const MAX_PAYLOAD_BYTES = 15 * 1024; // 15 KB

const DISCLAIMER_TEXT =
  'AI 建議僅供學習策略與心理激勵參考；每日讀書日程與時間限制仍由排程引擎安全計算。';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const config = getAiConfig();

  // 1. 設定通用 CORS 跨來源存取標頭
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-Type, Authorization, X-Client-Device-Id, X-Device-Id, X-Idempotency-Key, X-Apple-Transaction-Id, X-Apple-Jws, X-User-Tier',
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

  // 3. 輸入欄位與格式驗證 (含總字元數限制 ≤ 4000)
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

  // 4. 解析使用者身分與會員等級 (嚴禁前端未驗證偽造 Pro)
  const identity = await resolveUserIdentity(req);

  // 5. 決定 AI 提供商與模型
  const explicitProvider = (process.env.AI_PROVIDER || '').trim().toLowerCase();
  const provider = explicitProvider === 'gemini' ? 'gemini' : 'openai';
  const modelName = (process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL).trim();

  // 6. 冪等性鍵 (Idempotency Key) 解析
  const rawIdempotency =
    (req.headers['x-idempotency-key'] as string) ||
    studyRequest.idempotencyKey;
  const idempotencyKey = rawIdempotency && rawIdempotency.trim().length > 0 ? rawIdempotency.trim() : undefined;
  const requestId = crypto.randomUUID();

  // 7. 計算輸入字數並預估最大呼叫成本 (含 20% 安全緩衝)
  let totalInputChars = (studyRequest.examName || '').length;
  for (const s of studyRequest.subjects) {
    totalInputChars += (s.name || '').length;
  }
  const { reservedMicroUSD: reservedCostMicroUSD } = estimateMaxCostMicroUSD(
    modelName,
    totalInputChars,
    config.MAX_OUTPUT_TOKENS,
  );

  // 8. 執行 Redis 原子預檢 (檢查頻率、並行鎖定、日預算、月預算與個人每日額度)
  let preFlight;
  try {
    preFlight = await preFlightQuotaAndBudgetCheck({
      userId: identity.userId,
      tier: identity.tier,
      reservedCostMicroUSD,
      idempotencyKey,
      requestId,
    });
  } catch (err: any) {
    // 依據原則 10：Fail-Closed (安全關閉) 原則，資料庫異常時拒絕 AI 請求，絕不退回不可靠的記憶體計數
    console.error('[伺服器安全攔截] Redis 無法使用或配置遺失：', err?.message);
    return res.status(503).json({
      success: false,
      code: 'STORAGE_UNAVAILABLE',
      error: 'AI 服務目前暫時無法連接用量資料庫，基於預算與用量安全考量暫停服務，請稍後重試。',
      source: 'fallback_rule_engine',
      disclaimer: DISCLAIMER_TEXT,
    });
  }

  // 處理命中冪等快取 (避免網路重試重複呼叫 OpenAI 或重複扣額)
  if (preFlight.status === 'CACHED') {
    try {
      const cachedPayload = JSON.parse(preFlight.cachedResponse);
      return res.status(200).json(cachedPayload);
    } catch {
      // 若快取字串損毀則繼續正常請求
    }
  }

  // 處理被額度或預算規則攔截
  if (preFlight.status === 'BLOCKED') {
    return res.status(429).json({
      success: false,
      code: preFlight.code,
      error: preFlight.message,
      source: 'fallback_rule_engine',
      disclaimer: DISCLAIMER_TEXT,
      quota: {
        usedToday: identity.tier === 'pro' ? config.PRO_DAILY_LIMIT : config.FREE_DAILY_LIMIT,
        dailyLimit: identity.tier === 'pro' ? config.PRO_DAILY_LIMIT : config.FREE_DAILY_LIMIT,
        remainingToday: 0,
        resetsAt: getNextTaipeiResetIso(),
        tier: identity.tier,
      },
    });
  }

  if (preFlight.status !== 'OK') {
    return res.status(500).json({
      success: false,
      code: 'UNEXPECTED_STATE',
      error: '伺服端處理狀態未預期。',
      source: 'fallback_rule_engine',
      disclaimer: DISCLAIMER_TEXT,
    });
  }

  // 安全超時包裹器 (執行結束時必定清除計時器，避免記憶體洩漏)
  const executeWithTimeout = async <T>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('TIMEOUT'));
      }, config.REQUEST_TIMEOUT_MS);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const requestStartTime = Date.now();

  // ───── 分支 A: OpenAI API (優先使用，預設 gpt-5.6-luna) ─────
  if (provider === 'openai') {
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey || openaiApiKey.trim().length === 0) {
      console.error('[後端設定錯誤] 尚未在環境變數中設定 OPENAI_API_KEY。');
      // 失敗時退回預扣額度
      await postCallSettleFailure({ userId: identity.userId, reservedCostMicroUSD });
      return res.status(500).json({
        success: false,
        code: 'API_KEY_MISSING',
        error: '伺服端尚未設定 OPENAI_API_KEY 環境變數，請在 Vercel 專案設定中加入。',
        source: 'fallback_rule_engine',
        disclaimer: DISCLAIMER_TEXT,
      });
    }

    console.log('[AI 後端請求開始]', {
      provider: 'openai',
      model: modelName,
      userId: identity.userId,
      tier: identity.tier,
      examName: studyRequest.examName,
    });

    try {
      const openAiPromise = generateOpenAiAdvice(studyRequest, openaiApiKey, modelName);
      const openAiResult = await executeWithTimeout(openAiPromise);

      const responsePayload: StudyAdviceResponse = {
        success: true,
        advice: openAiResult.advice,
        source: 'openai_ai',
        disclaimer: DISCLAIMER_TEXT,
        quota: {
          usedToday: preFlight.usedToday,
          dailyLimit: preFlight.dailyLimit,
          remainingToday: preFlight.remainingToday,
          resetsAt: getNextTaipeiResetIso(),
          tier: identity.tier,
        },
        costInfo: {
          actualCostUSD: openAiResult.costUSD,
          isExactPricing: openAiResult.isExactPricing,
        },
      };

      // 結算實際成本、寫入冪等快取並釋放並行鎖
      await postCallSettleSuccess({
        userId: identity.userId,
        reservedCostMicroUSD,
        actualCostMicroUSD: openAiResult.costMicroUSD,
        idempotencyKey,
        responsePayloadString: JSON.stringify(responsePayload),
      });

      return res.status(200).json(responsePayload);
    } catch (error: any) {
      // 發生錯誤或逾時，退回預扣預算與次數
      await postCallSettleFailure({ userId: identity.userId, reservedCostMicroUSD });

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
          error: `AI 服務回應逾時 (超過 ${config.REQUEST_TIMEOUT_MS / 1000} 秒)，已為您自動退回額度，請稍後再試。`,
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
          error: 'OpenAI 帳戶額度不足或 API 呼叫頻率已達上限，請檢查帳戶餘額。',
          source: 'fallback_rule_engine',
          disclaimer: DISCLAIMER_TEXT,
        });
      }

      return res.status(500).json({
        success: false,
        code: 'INTERNAL_ERROR',
        error: error?.message || '生成讀書建議時發生未預期錯誤，已退回今日配額。',
        source: 'fallback_rule_engine',
        disclaimer: DISCLAIMER_TEXT,
      });
    }
  }

  // ───── 分支 B: Google Gemini API (備援方案) ─────
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey || geminiApiKey.trim().length === 0) {
    await postCallSettleFailure({ userId: identity.userId, reservedCostMicroUSD });
    return res.status(500).json({
      success: false,
      code: 'API_KEY_MISSING',
      error: '伺服端尚未設定 GEMINI_API_KEY 環境變數，請確認 Vercel 設定。',
      source: 'fallback_rule_engine',
      disclaimer: DISCLAIMER_TEXT,
    });
  }

  const geminiModel = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  try {
    const geminiPromise = generateGeminiAdvice(studyRequest, geminiApiKey, geminiModel);
    const advice = await executeWithTimeout(geminiPromise);

    const responsePayload: StudyAdviceResponse = {
      success: true,
      advice,
      source: 'gemini_ai',
      disclaimer: DISCLAIMER_TEXT,
      quota: {
        usedToday: preFlight.usedToday,
        dailyLimit: preFlight.dailyLimit,
        remainingToday: preFlight.remainingToday,
        resetsAt: getNextTaipeiResetIso(),
        tier: identity.tier,
      },
    };

    await postCallSettleSuccess({
      userId: identity.userId,
      reservedCostMicroUSD,
      actualCostMicroUSD: reservedCostMicroUSD,
      idempotencyKey,
      responsePayloadString: JSON.stringify(responsePayload),
    });

    return res.status(200).json(responsePayload);
  } catch (error: any) {
    await postCallSettleFailure({ userId: identity.userId, reservedCostMicroUSD });

    if (error?.message === 'TIMEOUT') {
      return res.status(504).json({
        success: false,
        code: 'GATEWAY_TIMEOUT',
        error: 'AI 服務回應逾時，已為您自動退回額度，請稍後再試。',
        source: 'fallback_rule_engine',
        disclaimer: DISCLAIMER_TEXT,
      });
    }

    return res.status(500).json({
      success: false,
      code: 'INTERNAL_ERROR',
      error: error?.message || 'Gemini 建議生成失敗，已退回額度。',
      source: 'fallback_rule_engine',
      disclaimer: DISCLAIMER_TEXT,
    });
  }
}
