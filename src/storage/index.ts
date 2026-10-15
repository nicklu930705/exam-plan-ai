import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AppData } from '../types/models';

const STORAGE_KEY = '@exam_plan_ai:v1_data';

/**
 * 本機資料儲存模組（AsyncStorage）
 * 負責儲存與載入所有的考試、科目、章節、任務與偏好設定。
 */

export async function loadAppDataFromStorage(): Promise<AppData | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) {
      console.log('[本機儲存] 讀取本機資料：無已儲存的歷史資料');
      return null;
    }
    const parsed = JSON.parse(raw) as AppData;
    // 基礎格式驗證
    if (Array.isArray(parsed.exams) && Array.isArray(parsed.tasks) && parsed.preferences) {
      console.log('[本機儲存] 成功讀取本機資料，考試數量：', parsed.exams.length, '，任務數量：', parsed.tasks.length);
      return parsed;
    }
    console.warn('[本機儲存] 讀取之資料格式不符合規範');
    return null;
  } catch (error) {
    console.error('載入本機資料失敗：', error);
    return null;
  }
}

export async function saveAppDataToStorage(data: AppData): Promise<void> {
  try {
    const json = JSON.stringify(data);
    await AsyncStorage.setItem(STORAGE_KEY, json);
    console.log('[本機儲存] 成功儲存本機資料，考試數量：', data.exams.length, '，任務數量：', data.tasks.length);
  } catch (error) {
    console.error('儲存本機資料失敗：', error);
  }
}

export async function clearAppDataFromStorage(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.error('清除本機資料失敗：', error);
  }
}

const BACKEND_URL_KEY = '@exam_plan_ai:backend_url';

export const DEFAULT_BACKEND_URL = 'https://exam-plan-ai-backend-coral.vercel.app';

export function normalizeBackendUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }
  return trimmed;
}

export async function getBackendUrlFromStorage(allowDefault: boolean = true): Promise<string | null> {
  try {
    const saved = await AsyncStorage.getItem(BACKEND_URL_KEY);
    if (saved && saved.trim().length > 0) {
      return normalizeBackendUrl(saved);
    }
    // 環境變數預設值（非機密之 API 伺服器端點，嚴禁放入任何 API 金鑰）
    const envUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
    if (envUrl && envUrl.trim().length > 0) {
      return normalizeBackendUrl(envUrl);
    }
    return allowDefault ? DEFAULT_BACKEND_URL : null;
  } catch {
    return allowDefault ? DEFAULT_BACKEND_URL : null;
  }
}

export async function saveBackendUrlToStorage(url: string | null): Promise<void> {
  try {
    const normalized = normalizeBackendUrl(url);
    if (!normalized) {
      await AsyncStorage.removeItem(BACKEND_URL_KEY);
    }
  } catch (error) {
    console.error('儲存後端伺服器網址失敗：', error);
  }
}

const DEVICE_ID_KEY = '@exam_plan_ai:client_device_id';

export async function getOrCreateClientDeviceId(): Promise<string> {
  try {
    const existing = await AsyncStorage.getItem(DEVICE_ID_KEY);
    if (existing && existing.trim().length >= 8) {
      return existing.trim();
    }
    const newId = `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
    await AsyncStorage.setItem(DEVICE_ID_KEY, newId);
    return newId;
  } catch {
    return `dev_fallback_${Date.now().toString(36)}`;
  }
}

