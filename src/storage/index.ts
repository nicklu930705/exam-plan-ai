import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AppData } from '../types/models';

export const STORAGE_KEY = '@exam_plan_ai:v1_data';
export const ROLLBACK_SNAPSHOT_KEY = '@exam_plan_ai:v1_data_recovery_snapshot';

/**
 * 序列化寫入佇列（FIFO Promise 鏈）
 * 確保任何本機儲存寫入操作依序執行，防止多個非同步寫入發生競態條件或順序錯亂。
 */
let storageWriteQueue: Promise<unknown> = Promise.resolve();

function enqueueStorageOperation<T>(operation: () => Promise<T>): Promise<T> {
  const current = storageWriteQueue.then(operation, operation);
  storageWriteQueue = current.catch(() => {});
  return current;
}

/**
 * 驗證 AppData 物件之基本結構完整性
 */
function isValidAppDataShape(obj: unknown): obj is AppData {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const candidate = obj as Record<string, unknown>;
  return (
    Array.isArray(candidate.exams) &&
    Array.isArray(candidate.tasks) &&
    typeof candidate.preferences === 'object' &&
    candidate.preferences !== null
  );
}

/**
 * 本機資料儲存模組（AsyncStorage）
 * 負責儲存與載入所有的考試、科目、章節、任務與偏好設定。
 * 支援中斷自癒（當主儲存損毀時自動自未完成的救援快照修復）。
 */
export async function loadAppDataFromStorage(): Promise<AppData | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    let parsed: AppData | null = null;

    if (raw) {
      try {
        const candidate = JSON.parse(raw);
        if (isValidAppDataShape(candidate)) {
          parsed = candidate;
        }
      } catch {
        console.warn('[本機儲存] 主儲存區資料損壞，嘗試自救援快照回復...');
      }
    }

    // 若主儲存區為空或損毀，檢查是否存在異常中斷留下的救援快照
    if (!parsed) {
      const rollbackRaw = await AsyncStorage.getItem(ROLLBACK_SNAPSHOT_KEY);
      if (rollbackRaw) {
        try {
          const candidate = JSON.parse(rollbackRaw);
          if (isValidAppDataShape(candidate)) {
            console.log('[本機儲存] 成功偵測到救援快照，自動自中斷中回復讀書資料');
            parsed = candidate;
            // 自救援快照寫回主儲存區並清理快照
            await AsyncStorage.setItem(STORAGE_KEY, rollbackRaw);
            await AsyncStorage.removeItem(ROLLBACK_SNAPSHOT_KEY);
          }
        } catch {
          console.error('[本機儲存] 救援快照亦損壞，無法復原。');
        }
      }
    }

    if (parsed) {
      console.log(
        '[本機儲存] 成功讀取本機資料，考試數量：',
        parsed.exams.length,
        '，任務數量：',
        parsed.tasks.length,
      );
      return parsed;
    }

    console.log('[本機儲存] 讀取本機資料：無已儲存的歷史資料');
    return null;
  } catch (error) {
    console.error('載入本機資料失敗：', error);
    return null;
  }
}

/**
 * 一般狀態變更的自動儲存（經由 FIFO 佇列保證寫入順序）
 */
export async function saveAppDataToStorage(data: AppData): Promise<boolean> {
  return enqueueStorageOperation(async () => {
    try {
      const json = JSON.stringify(data);
      await AsyncStorage.setItem(STORAGE_KEY, json);
      console.log(
        '[本機儲存] 成功儲存本機資料，考試數量：',
        data.exams.length,
        '，任務數量：',
        data.tasks.length,
      );
      return true;
    } catch (error) {
      console.error('儲存本機資料失敗：', error);
      return false;
    }
  });
}

/**
 * 安全還原讀書資料
 * 針對行動裝置無法保證絕對原子性交易的特性，實作以下容錯與回復策略：
 * 1. 寫入前建立舊資料之救援快照（ROLLBACK_SNAPSHOT_KEY）
 * 2. 寫入新資料至主儲存區（STORAGE_KEY）
 * 3. 讀回校驗：重新讀取並驗證考試與任務筆數是否相符
 * 4. 校驗通過後移除救援快照
 * 5. 若寫入或校驗發生任何失敗，自動嘗試自快照回復原始資料，並回傳明確失敗原因
 */
export async function safeRestoreAppDataToStorage(
  data: AppData,
): Promise<{ success: boolean; error?: string }> {
  return enqueueStorageOperation(async () => {
    let originalRaw: string | null = null;
    try {
      originalRaw = await AsyncStorage.getItem(STORAGE_KEY);
      if (originalRaw) {
        // 1. 建立救援快照
        await AsyncStorage.setItem(ROLLBACK_SNAPSHOT_KEY, originalRaw);
      }

      // 2. 寫入新資料
      const newJson = JSON.stringify(data);
      await AsyncStorage.setItem(STORAGE_KEY, newJson);

      // 3. 讀回校驗
      const readBack = await AsyncStorage.getItem(STORAGE_KEY);
      if (!readBack) {
        throw new Error('讀回校驗失敗：儲存內容為空。');
      }
      const verified = JSON.parse(readBack);
      if (
        !isValidAppDataShape(verified) ||
        verified.exams.length !== data.exams.length ||
        verified.tasks.length !== data.tasks.length
      ) {
        throw new Error('讀回校驗失敗：寫入之資料與預期筆數不一致。');
      }

      // 4. 校驗通過，清理救援快照
      await AsyncStorage.removeItem(ROLLBACK_SNAPSHOT_KEY);
      console.log('[本機儲存] 安全還原成功並通過讀回校驗。');
      return { success: true };
    } catch (err: any) {
      console.error('[本機儲存] 安全還原失敗，啟動回復策略：', err);
      // 5. 失敗回復
      try {
        if (originalRaw) {
          await AsyncStorage.setItem(STORAGE_KEY, originalRaw);
          console.log('[本機儲存] 成功回復至還原前之讀書資料。');
        }
      } catch (rollbackErr) {
        console.error('[本機儲存] 執行資料回復時失敗：', rollbackErr);
      }
      return {
        success: false,
        error: err?.message || '寫入本機儲存時發生錯誤，已保留還原前之資料。',
      };
    }
  });
}

export async function clearAppDataFromStorage(): Promise<void> {
  return enqueueStorageOperation(async () => {
    try {
      await AsyncStorage.multiRemove([STORAGE_KEY, ROLLBACK_SNAPSHOT_KEY]);
    } catch (error) {
      console.error('清除本機資料失敗：', error);
    }
  });
}

const BACKEND_URL_KEY = '@exam_plan_ai:backend_url';

export const DEFAULT_BACKEND_URL = 'https://exam-plan-ai-backend-coral.vercel.app';
export const SANDBOX_BACKEND_URL = 'https://exam-plan-ai-backend-sandbox.vercel.app';

export function normalizeBackendUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }
  return trimmed;
}

const ENV_KEY_SANDBOX = ['EXPO_PUBLIC', 'ENABLE_IAP_SANDBOX'].join('_');
const ENV_KEY_BACKEND = ['EXPO_PUBLIC', 'BACKEND_URL'].join('_');

/**
 * 檢查當前建置是否宣告啟用 Apple IAP 沙盒測試旗標
 */
export function isIapSandboxConfigured(): boolean {
  return (
    process.env[ENV_KEY_SANDBOX] === 'true' ||
    process.env.EXPO_PUBLIC_ENABLE_IAP_SANDBOX === 'true'
  );
}

/**
 * 檢查當前建置之沙盒環境是否合法合規：
 * 必須同時滿足：
 * 1. EXPO_PUBLIC_ENABLE_IAP_SANDBOX === 'true'
 * 2. EXPO_PUBLIC_BACKEND_URL 經規範化後完全符合官方指定的 SANDBOX_BACKEND_URL
 */
export function isSandboxEnvironmentValid(): boolean {
  if (!isIapSandboxConfigured()) return false;
  const rawUrl =
    process.env[ENV_KEY_BACKEND] ?? process.env.EXPO_PUBLIC_BACKEND_URL;
  const envUrl = normalizeBackendUrl(rawUrl);
  return envUrl === SANDBOX_BACKEND_URL;
}

export async function getBackendUrlFromStorage(allowDefault: boolean = true): Promise<string | null> {
  try {
    // 正式版僅連線至正式生產後端（或建置時環境變數），防止舊版儲存的自訂未知網址造成連線風險
    // 若本機存有舊版自訂網址鍵值，自動清理以確保連線一致性，且絕不影響考試與讀書紀錄
    const saved = await AsyncStorage.getItem(BACKEND_URL_KEY);
    if (saved) {
      await AsyncStorage.removeItem(BACKEND_URL_KEY);
    }

    const rawUrl =
      process.env[ENV_KEY_BACKEND] ?? process.env.EXPO_PUBLIC_BACKEND_URL;
    const envUrl = normalizeBackendUrl(rawUrl);

    // 若建置宣告為 Sandbox 測試版
    if (isIapSandboxConfigured()) {
      if (envUrl === SANDBOX_BACKEND_URL) {
        return SANDBOX_BACKEND_URL;
      }
      // 若宣告為 Sandbox 但環境變數缺失、為空或錯誤（例如指向了正式後端或其他未知網址），
      // 必須安全拒絕發送 API 請求，絕不可自動回退到正式後端！
      console.warn(
        '[Storage] Sandbox 建置宣告啟用，但 EXPO_PUBLIC_BACKEND_URL 未設定或不符合指定之 Sandbox URL，已安全阻斷。',
      );
      return null;
    }

    // 一般正式建置流程
    if (envUrl && envUrl.trim().length > 0) {
      return envUrl;
    }
    return allowDefault ? DEFAULT_BACKEND_URL : null;
  } catch {
    if (isIapSandboxConfigured()) {
      return null;
    }
    return allowDefault ? DEFAULT_BACKEND_URL : null;
  }
}

export async function saveBackendUrlToStorage(_url: string | null): Promise<void> {
  try {
    // 正式版不再支援自訂後端網址，一律清理舊版可能殘留之鍵值
    await AsyncStorage.removeItem(BACKEND_URL_KEY);
  } catch (error) {
    console.error('清理舊版後端伺服器網址失敗：', error);
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

const PROOF_TOKEN_KEY = '@exam_plan_ai:apple_proof_token';

export async function getStoredProofToken(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(PROOF_TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function saveStoredProofToken(token: string): Promise<void> {
  try {
    if (token && typeof token === 'string' && token.trim().length > 0) {
      await AsyncStorage.setItem(PROOF_TOKEN_KEY, token.trim());
    } else {
      await AsyncStorage.removeItem(PROOF_TOKEN_KEY);
    }
  } catch (error) {
    console.error('儲存 Apple 驗證權杖失敗：', error);
  }
}

export async function clearStoredProofToken(): Promise<void> {
  try {
    await AsyncStorage.removeItem(PROOF_TOKEN_KEY);
  } catch (error) {
    console.error('清除 Apple 驗證權杖失敗：', error);
  }
}

const LATEST_APPLE_JWS_KEY = '@exam_plan_ai:latest_apple_jws';

export async function getStoredLatestAppleJws(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(LATEST_APPLE_JWS_KEY);
  } catch {
    return null;
  }
}

export async function saveStoredLatestAppleJws(jws: string): Promise<void> {
  try {
    if (jws && typeof jws === 'string' && jws.trim().length > 0) {
      await AsyncStorage.setItem(LATEST_APPLE_JWS_KEY, jws.trim());
    } else {
      await AsyncStorage.removeItem(LATEST_APPLE_JWS_KEY);
    }
  } catch (error) {
    console.error('儲存 Apple 交易憑證 (JWS) 失敗：', error);
  }
}

export async function clearStoredLatestAppleJws(): Promise<void> {
  try {
    await AsyncStorage.removeItem(LATEST_APPLE_JWS_KEY);
  } catch (error) {
    console.error('清除 Apple 交易憑證 (JWS) 失敗：', error);
  }
}
