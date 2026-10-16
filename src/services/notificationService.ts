import * as Notifications from 'expo-notifications';
import { Linking, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const REMINDER_SETTINGS_KEY = '@exam_plan_ai:reminder_settings';
export const REMINDER_TAG = 'daily_study_reminder';
export const NOTIFICATION_TITLE = '考試計畫 AI';
export const NOTIFICATION_BODY = '今天的讀書時間到了！花一點時間完成今天的讀書計畫，讓自己離目標更近一步。';

export interface ReminderSettings {
  enabled: boolean;
  hour: number; // 0..23
  minute: number; // 0..59
  notificationId?: string | null;
}

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  enabled: false,
  hour: 20, // 預設晚上 8 點
  minute: 0,
  notificationId: null,
};

// 設定前景通知呈現處理方式（當 App 在前景時亦允許呈現橫幅與提示音）
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

/**
 * 讀取本機儲存的提醒設定
 */
export async function loadReminderSettings(): Promise<ReminderSettings> {
  try {
    const raw = await AsyncStorage.getItem(REMINDER_SETTINGS_KEY);
    if (!raw) {
      return DEFAULT_REMINDER_SETTINGS;
    }
    const parsed = JSON.parse(raw);
    return {
      enabled: Boolean(parsed.enabled),
      hour: typeof parsed.hour === 'number' && parsed.hour >= 0 && parsed.hour <= 23 ? parsed.hour : 20,
      minute: typeof parsed.minute === 'number' && parsed.minute >= 0 && parsed.minute <= 59 ? parsed.minute : 0,
      notificationId: typeof parsed.notificationId === 'string' ? parsed.notificationId : null,
    };
  } catch {
    return DEFAULT_REMINDER_SETTINGS;
  }
}

/**
 * 儲存本機提醒設定（嚴格與備份及雲端資料隔離）
 */
export async function saveReminderSettings(settings: ReminderSettings): Promise<void> {
  try {
    await AsyncStorage.setItem(REMINDER_SETTINGS_KEY, JSON.stringify(settings));
  } catch (error) {
    console.error('儲存提醒設定失敗：', error);
  }
}

/**
 * 取得當前通知權限狀態
 */
export async function getNotificationPermissionStatus(): Promise<Notifications.PermissionStatus> {
  try {
    const settings = await Notifications.getPermissionsAsync();
    return settings.status;
  } catch (err) {
    console.warn('檢查通知權限失敗：', err);
    return Notifications.PermissionStatus.UNDETERMINED;
  }
}

/**
 * 請求通知權限
 */
export async function requestNotificationPermission(): Promise<boolean> {
  try {
    const { status } = await Notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowBadge: true,
        allowSound: true,
      },
    });
    return status === Notifications.PermissionStatus.GRANTED;
  } catch (err) {
    console.warn('請求通知權限失敗：', err);
    return false;
  }
}

/**
 * 開啟 iOS 系統設定頁（引導使用者手動開啟權限）
 */
export async function openDeviceNotificationSettings(): Promise<void> {
  try {
    if (Platform.OS === 'ios') {
      await Linking.openURL('app-settings:');
    } else {
      await Linking.openSettings();
    }
  } catch {
    await Linking.openSettings();
  }
}

/**
 * 操作序列化佇列（確保排程、取消與前景同步操作嚴格依序執行，防範連續快速操作之競態條件）
 */
let reminderOpQueue: Promise<any> = Promise.resolve();

function enqueueReminderOp<T>(op: () => Promise<T>): Promise<T> {
  const resultPromise = reminderOpQueue.then(op, op);
  reminderOpQueue = resultPromise.catch(() => {});
  return resultPromise;
}

/**
 * 取消本 App 建立的每日讀書提醒排程
 * 僅取消符合 REMINDER_TAG 或特定 identifier 之通知，絕不影響 App 其他通知
 */
async function _cancelDailyReminderCore(): Promise<{ success: boolean; error?: string }> {
  try {
    const currentSettings = await loadReminderSettings();
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();

    for (const item of scheduled) {
      const isOurReminder =
        item.identifier === currentSettings.notificationId ||
        (item.content?.data && (item.content.data as any).tag === REMINDER_TAG);

      if (isOurReminder) {
        await Notifications.cancelScheduledNotificationAsync(item.identifier);
      }
    }

    await saveReminderSettings({
      ...currentSettings,
      enabled: false,
      notificationId: null,
    });

    return { success: true };
  } catch (err: any) {
    console.error('取消每日提醒排程失敗：', err);
    return { success: false, error: err?.message || '取消通知排程失敗' };
  }
}

/**
 * 取消本 App 建立的每日讀書提醒排程
 * 僅取消符合 REMINDER_TAG 或特定 identifier 之通知，絕不影響 App 其他通知
 */
export function cancelDailyReminder(): Promise<{ success: boolean; error?: string }> {
  return enqueueReminderOp(() => _cancelDailyReminderCore());
}

async function _scheduleDailyReminderCore(
  hour: number,
  minute: number,
): Promise<{ success: boolean; identifier?: string; error?: string }> {
  try {
    // 1. 檢查並確認通知權限
    const status = await getNotificationPermissionStatus();
    if (status !== Notifications.PermissionStatus.GRANTED) {
      const granted = await requestNotificationPermission();
      if (!granted) {
        return { success: false, error: 'PERMISSION_DENIED' };
      }
    }

    // 2. 防重複排程：先乾淨清理現存之每日提醒
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    for (const item of scheduled) {
      if (item.content?.data && (item.content.data as any).tag === REMINDER_TAG) {
        await Notifications.cancelScheduledNotificationAsync(item.identifier);
      }
    }

    // 3. 建立支援每日重複的日曆觸發排程
    const identifier = await Notifications.scheduleNotificationAsync({
      content: {
        title: NOTIFICATION_TITLE,
        body: NOTIFICATION_BODY,
        sound: true,
        data: { tag: REMINDER_TAG },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        hour,
        minute,
      },
    });

    // 4. 保存最新排程設定與識別碼
    await saveReminderSettings({
      enabled: true,
      hour,
      minute,
      notificationId: identifier,
    });

    return { success: true, identifier };
  } catch (err: any) {
    console.error('建立每日讀書提醒失敗：', err);
    return { success: false, error: err?.message || '建立通知排程失敗' };
  }
}

/**
 * 建立每日重複的日曆讀書提醒排程
 * 使用 SchedulableTriggerInputTypes.DAILY，精準依據本機日曆時區重複，自動適應日光節約時間
 */
export function scheduleDailyReminder(
  hour: number,
  minute: number,
): Promise<{ success: boolean; identifier?: string; error?: string }> {
  return enqueueReminderOp(() => _scheduleDailyReminderCore(hour, minute));
}

async function _syncReminderCore(): Promise<{
  updated: boolean;
  settings: ReminderSettings;
}> {
  try {
    const settings = await loadReminderSettings();
    if (!settings.enabled) {
      return { updated: false, settings };
    }

    const permission = await getNotificationPermissionStatus();
    if (permission !== Notifications.PermissionStatus.GRANTED) {
      // 權限已被系統設定關閉，自動同步為停用狀態
      await _cancelDailyReminderCore();
      const updatedSettings = { ...settings, enabled: false, notificationId: null };
      await saveReminderSettings(updatedSettings);
      return { updated: true, settings: updatedSettings };
    }

    // 權限依然有效，核對系統中實際存在的排程筆數
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    const ourReminders = scheduled.filter(
      (item) =>
        item.identifier === settings.notificationId ||
        (item.content?.data && (item.content.data as any).tag === REMINDER_TAG),
    );

    // 若排程意外遺失，重新補齊
    if (ourReminders.length === 0) {
      const res = await _scheduleDailyReminderCore(settings.hour, settings.minute);
      return {
        updated: true,
        settings: { ...settings, notificationId: res.identifier ?? null },
      };
    }

    // 若因邊際情況出現多筆重複排程，取消多餘者保留第一筆
    if (ourReminders.length > 1) {
      for (let i = 1; i < ourReminders.length; i++) {
        await Notifications.cancelScheduledNotificationAsync(ourReminders[i].identifier);
      }
      return {
        updated: true,
        settings: { ...settings, notificationId: ourReminders[0].identifier },
      };
    }

    return { updated: false, settings };
  } catch {
    const fallback = await loadReminderSettings();
    return { updated: false, settings: fallback };
  }
}

/**
 * App 啟動或重回前景時同步核對提醒狀態
 * 若使用者於 iOS 系統設定中撤銷權限，自動修正設定狀態為關閉，避免 UI 呈現虛假成功
 */
export function syncReminderOnAppForeground(): Promise<{
  updated: boolean;
  settings: ReminderSettings;
}> {
  return enqueueReminderOp(() => _syncReminderCore());
}
