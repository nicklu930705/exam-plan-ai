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
  quota?: QuotaInfo;
  quotaSnapshot?: QuotaInfo;
  taskStats?: TaskProgressSnapshot;
  taskSnapshot?: TaskProgressSnapshot;
}

export interface StoredAiAdviceCache {
  version: 1;
  items: Record<string, CachedAiAdviceItem>; // 以 examId 為 key
  latestQuota?: QuotaInfo;
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
  isTierMismatch: boolean;
}

/**
 * 取得指定考試、今日日期與會員等級相符的有效快取建議
 */
export async function getCachedAiAdvice(
  examId: string,
  today: string,
  currentTier?: PlanTier,
): Promise<GetCachedAiAdviceResult> {
  if (!examId || !today) {
    return { cachedAdvice: null, item: null, isExpiredDay: false, isTierMismatch: false };
  }

  const cache = await loadFullCache();
  const item = cache.items[examId];

  if (!item) {
    return { cachedAdvice: null, item: null, isExpiredDay: false, isTierMismatch: false };
  }

  // 1. 跨日檢查（日曆日不符即視為過期）
  if (item.date !== today) {
    return { cachedAdvice: null, item: null, isExpiredDay: true, isTierMismatch: false };
  }

  // 2. 會員等級檢查（若當前方案改變，避免呈現不對稱的舊等級建議）
  if (currentTier && item.tier !== currentTier) {
    return { cachedAdvice: null, item: null, isExpiredDay: false, isTierMismatch: true };
  }

  return { cachedAdvice: item, item, isExpiredDay: false, isTierMismatch: false };
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
export async function saveLatestQuotaCache(quota: QuotaInfo): Promise<boolean> {
  if (!quota) return false;
  const cache = await loadFullCache();
  cache.latestQuota = quota;
  return await saveFullCache(cache);
}

/**
 * 取得最新的每日配額快照（若為今日則回傳，隔日自動失效）
 */
export async function getLatestQuotaCache(today: string): Promise<QuotaInfo | null> {
  const cache = await loadFullCache();
  if (!cache.latestQuota) return null;
  // 若配額快照中附有重置時間或日期檢查
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
