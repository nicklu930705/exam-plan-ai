/**
 * 考試計畫 AI - AI 讀書教練建議本機快取與配額持久化服務
 *
 * 設計原則：
 * 1. 獨立儲存：使用專屬鍵值 (@exam_plan_ai:v1_ai_advice_cache)，絕不變更或損毀主 AppData。
 * 2. 嚴格隔離：依據 examId、日期 (YYYY-MM-DD)、會員等級 (PlanTier) 多維度隔離，防止串景與過期倒灌。
 * 3. 唯讀自癒：冷啟動與切換考試時僅讀取本地快取，絕不自動發送付費 AI 請求或消耗用量。
 * 4. 進度感應：記錄產生建議時的任務統計，當使用者後續有新打卡時標記「進度已更新」，引導手動重整。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { QuotaInfo, StructuredAdvice } from './aiAdviceService';
import type { PlanTier } from '../subscription/types';

export const AI_ADVICE_CACHE_STORAGE_KEY = '@exam_plan_ai:v1_ai_advice_cache';

export interface TaskProgressSnapshot {
  totalTasks: number;
  completedTasks: number;
  completionRate: number;
}

export interface CachedAiAdviceItem {
  examId: string;
  date: string; // 'YYYY-MM-DD' (本地日曆日)
  tier: PlanTier;
  advice: StructuredAdvice;
  source: 'openai_ai' | 'gemini_ai' | 'fallback_rule_engine';
  disclaimer: string;
  note?: string;
  createdAt: string; // ISO 日期時間字串
  deviceId?: string; // 產權識別（本機裝置識別碼，可選）
  quota?: QuotaInfo;
  quotaSnapshot?: QuotaInfo;
  taskStats?: TaskProgressSnapshot;
  taskSnapshot?: TaskProgressSnapshot;
}

export interface StoredAiAdviceCache {
  version: 1;
  items: Record<string, CachedAiAdviceItem>; // 以 examId 為 key
  latestQuota?: QuotaInfo;
  latestQuotaDate?: string; // 記錄額度寫入之日期（YYYY-MM-DD）
  updatedAt: string;
}

/**
 * 依據任務列表計算進度快照
 */
export function createTaskProgressSnapshot(tasks: { status: string }[]): TaskProgressSnapshot {
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter((t) => t.status === 'done').length;
  const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
  return { totalTasks, completedTasks, completionRate };
}

/**
 * 檢查進度是否相較建議產生時已有顯著變動
 */
export function isProgressChanged(
  savedStats?: TaskProgressSnapshot | null,
  currentTasksOrStats?: TaskProgressSnapshot | { status: string }[] | null,
): boolean {
  if (!savedStats || !currentTasksOrStats) return false;
  const currentStats = Array.isArray(currentTasksOrStats)
    ? createTaskProgressSnapshot(currentTasksOrStats)
    : currentTasksOrStats;
  return (
    savedStats.completedTasks !== currentStats.completedTasks ||
    savedStats.totalTasks !== currentStats.totalTasks ||
    savedStats.completionRate !== currentStats.completionRate
  );
}

/**
 * 讀取完整的快取資料庫物件
 */
async function loadFullCache(): Promise<StoredAiAdviceCache> {
  try {
    const raw = await AsyncStorage.getItem(AI_ADVICE_CACHE_STORAGE_KEY);
    if (!raw) {
      return { version: 1, items: {}, updatedAt: new Date().toISOString() };
    }
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.version === 1 && typeof parsed.items === 'object') {
      return parsed as StoredAiAdviceCache;
    }
    return { version: 1, items: {}, updatedAt: new Date().toISOString() };
  } catch (err) {
    console.warn('[AI Cache] 讀取 AI 建議快取失敗，重置為初始空快取：', err);
    return { version: 1, items: {}, updatedAt: new Date().toISOString() };
  }
}

/**
 * 寫入快取資料庫（自動清理超過 7 天的歷史廢棄紀錄）
 */
async function saveFullCache(cache: StoredAiAdviceCache): Promise<boolean> {
  try {
    const now = Date.now();
    const maxAgeMs = 7 * 86400 * 1000;
    const prunedItems: Record<string, CachedAiAdviceItem> = {};

    for (const [examId, item] of Object.entries(cache.items || {})) {
      const itemTime = Date.parse(item.createdAt);
      if (!isNaN(itemTime) && now - itemTime <= maxAgeMs) {
        prunedItems[examId] = item;
      }
    }

    cache.items = prunedItems;
    cache.updatedAt = new Date().toISOString();
    await AsyncStorage.setItem(AI_ADVICE_CACHE_STORAGE_KEY, JSON.stringify(cache));
    return true;
  } catch (err) {
    console.error('[AI Cache] 寫入 AI 建議快取失敗：', err);
    return false;
  }
}

/**
 * 儲存指定考試當日生成的 AI 建議
 */
export async function saveCachedAiAdvice(item: {
  examId: string;
  date: string;
  tier: PlanTier;
  advice: StructuredAdvice;
  source: 'openai_ai' | 'gemini_ai' | 'fallback_rule_engine';
  disclaimer?: string;
  note?: string;
  createdAt: string;
  deviceId?: string;
  quota?: QuotaInfo;
  quotaSnapshot?: QuotaInfo;
  taskStats?: TaskProgressSnapshot;
  taskSnapshot?: TaskProgressSnapshot;
}): Promise<boolean> {
  if (!item || !item.examId || !item.date || !item.advice) {
    return false;
  }
  const normalizedItem: CachedAiAdviceItem = {
    examId: item.examId,
    date: item.date,
    tier: item.tier,
    advice: item.advice,
    source: item.source,
    disclaimer: item.disclaimer || 'AI 建議僅供學習策略與心理激勵參考。',
    note: item.note,
    createdAt: item.createdAt,
    deviceId: item.deviceId,
    quota: item.quota || item.quotaSnapshot,
    quotaSnapshot: item.quota || item.quotaSnapshot,
    taskStats: item.taskStats || item.taskSnapshot,
    taskSnapshot: item.taskStats || item.taskSnapshot,
  };
  const cache = await loadFullCache();
  cache.items[normalizedItem.examId] = normalizedItem;
  if (normalizedItem.quota) {
    cache.latestQuota = normalizedItem.quota;
  }
  return await saveFullCache(cache);
}

export interface GetCachedAiAdviceResult {
  cachedAdvice: CachedAiAdviceItem | null;
  item: CachedAiAdviceItem | null;
  isExpiredDay: boolean;
  isHistorical: boolean;
  isTierMismatch: boolean;
  isHistoricalProAdvice?: boolean;
}

/**
 * 取得指定考試、今日日期與會員等級相符（或符合方案 A 歷史閱讀權限）的有效快取建議
 *
 * 權限分離與跨日平滑策略（方案 A）：
 * 1. 讀取與生成權限分離：使用者從 Pro 到期降級為 Free 時，過去 7 天內所產生之 Pro 深度建議
 *    仍允許免費閱讀（cachedAdvice 不為 null），但明確標記 isHistorical = true 與 isHistoricalProAdvice = true。
 * 2. 升級隔離：若使用者由 Free 升級為 Pro，舊 Free 確定性建議不予呈現（isTierMismatch = true），引導生成 Pro 建議。
 * 3. 同一考試且等級相符之建議，在 7 天保留期內即使跨日仍可被安全讀取，標記 isHistorical = true。
 * 4. 超過 7 天保留期之紀錄一律視為失效（cachedAdvice = null）。
 * 5. 跨帳號/跨身分保護：若指定 expectedDeviceId 且紀錄存有不同 deviceId，阻斷跨身分讀取。
 */
export async function getCachedAiAdvice(
  examId: string,
  today: string,
  currentTier?: PlanTier,
  expectedDeviceId?: string,
): Promise<GetCachedAiAdviceResult> {
  if (!examId || !today) {
    return {
      cachedAdvice: null,
      item: null,
      isExpiredDay: false,
      isHistorical: false,
      isTierMismatch: false,
      isHistoricalProAdvice: false,
    };
  }

  const cache = await loadFullCache();
  const item = cache.items[examId];

  if (!item) {
    return {
      cachedAdvice: null,
      item: null,
      isExpiredDay: false,
      isHistorical: false,
      isTierMismatch: false,
      isHistoricalProAdvice: false,
    };
  }

  // 1. 跨帳號/跨身分檢查（若兩者皆有值且不相符時阻斷，相容 Build 8/9/10 無 deviceId 紀錄）
  if (expectedDeviceId && item.deviceId && item.deviceId !== expectedDeviceId) {
    return {
      cachedAdvice: null,
      item: null,
      isExpiredDay: false,
      isHistorical: false,
      isTierMismatch: false,
      isHistoricalProAdvice: false,
    };
  }

  // 2. 超過 7 天保留期的紀錄視為過期清理，不予回傳
  const now = Date.now();
  const maxAgeMs = 7 * 86400 * 1000;
  const itemTime = Date.parse(item.createdAt);
  if (!isNaN(itemTime) && now - itemTime > maxAgeMs) {
    return {
      cachedAdvice: null,
      item: null,
      isExpiredDay: true,
      isHistorical: true,
      isTierMismatch: false,
      isHistoricalProAdvice: false,
    };
  }

  // 3. 會員等級檢查與方案 A 閱讀/生成權限分離
  // 方案 A：當 Pro/Lifetime 到期降為 Free 時，7 天內產生的 Pro 深度建議仍可供 Free 使用者閱讀，但標記為歷史建議
  const isProToFreeDowngrade =
    (item.tier === 'pro' || item.tier === 'lifetime') && currentTier === 'free';

  if (isProToFreeDowngrade) {
    const isExpiredDay = item.date !== today;
    return {
      cachedAdvice: item,
      item,
      isExpiredDay,
      isHistorical: true, // 降級為 Free 後一律視為歷史建議，不可視為今日全新生成
      isTierMismatch: false,
      isHistoricalProAdvice: true,
    };
  }

  // 若使用者升級至 Pro，或其它不相容等級變更，嚴格隔離舊等級快取
  if (currentTier && item.tier !== currentTier) {
    return {
      cachedAdvice: null,
      item: null,
      isExpiredDay: false,
      isHistorical: false,
      isTierMismatch: true,
      isHistoricalProAdvice: false,
    };
  }

  // 4. 等級相符之一般跨日檢查（日曆日不符即標記為歷史過期建議，但仍回傳以利使用者免費閱讀）
  const isExpiredDay = item.date !== today;

  return {
    cachedAdvice: item,
    item,
    isExpiredDay,
    isHistorical: isExpiredDay,
    isTierMismatch: false,
    isHistoricalProAdvice: false,
  };
}

/**
 * 當使用者刪除特定考試時，連帶清理其對應之 AI 建議快取
 */
export async function removeCachedAiAdviceForExam(examId: string): Promise<boolean> {
  if (!examId) return false;
  const cache = await loadFullCache();
  if (cache.items && cache.items[examId]) {
    delete cache.items[examId];
    return await saveFullCache(cache);
  }
  return true;
}

/**
 * 儲存最新的每日配額快照
 */
export async function saveLatestQuotaCache(quota: QuotaInfo, date?: string): Promise<boolean> {
  if (!quota) return false;
  const cache = await loadFullCache();
  cache.latestQuota = quota;
  if (date) {
    cache.latestQuotaDate = date;
  }
  return await saveFullCache(cache);
}

/**
 * 取得最新的每日配額快照（若為今日且會員方案相符則回傳，跨日或方案不符自動失效）
 */
export async function getLatestQuotaCache(
  today: string,
  expectedTier?: 'free' | 'pro' | 'lifetime',
): Promise<QuotaInfo | null> {
  const cache = await loadFullCache();
  if (!cache.latestQuota) return null;

  // 1. 會員方案嚴格隔離：舊 Pro 額度（例如每日 15 次）絕不得冒充 Free 額度
  if (expectedTier) {
    const quotaTier = cache.latestQuota.tier;
    if (expectedTier === 'free' && quotaTier !== 'free') {
      return null;
    }
    if ((expectedTier === 'pro' || expectedTier === 'lifetime') && quotaTier === 'free') {
      return null;
    }
  }

  // 2. 日期檢查：若有記錄儲存日期且與今日不同，則為跨日舊額度，自動失效
  if (cache.latestQuotaDate) {
    if (cache.latestQuotaDate !== today) {
      return null;
    }
  } else if (cache.latestQuota.resetsAt) {
    // 若無記錄日期但有重設時間戳記，若重設日期已在今日或過去，代表跨日失效
    const resetDate = cache.latestQuota.resetsAt.slice(0, 10);
    if (resetDate <= today) {
      return null;
    }
  }

  return cache.latestQuota;
}

/**
 * 清除所有 AI 建議快取（如帳號切換或測試清除）
 */
export async function clearAllAiAdviceCache(): Promise<boolean> {
  try {
    await AsyncStorage.removeItem(AI_ADVICE_CACHE_STORAGE_KEY);
    return true;
  } catch (err) {
    console.error('[AI Cache] 清除快取失敗：', err);
    return false;
  }
}
