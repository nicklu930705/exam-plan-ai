import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Linking } from 'react-native';

import {
  DEFAULT_REMINDER_SETTINGS,
  NOTIFICATION_BODY,
  NOTIFICATION_TITLE,
  REMINDER_SETTINGS_KEY,
  REMINDER_TAG,
  cancelDailyReminder,
  getNotificationPermissionStatus,
  loadReminderSettings,
  openDeviceNotificationSettings,
  requestNotificationPermission,
  saveReminderSettings,
  scheduleDailyReminder,
  syncReminderOnAppForeground,
  type ReminderSettings,
} from '../notificationService';

// 模擬 AsyncStorage
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// 模擬 expo-notifications
jest.mock('expo-notifications', () => ({
  SchedulableTriggerInputTypes: {
    DAILY: 'daily',
    TIME_INTERVAL: 'timeInterval',
    CALENDAR: 'calendar',
  },
  PermissionStatus: {
    GRANTED: 'granted',
    DENIED: 'denied',
    UNDETERMINED: 'undetermined',
  },
  setNotificationHandler: jest.fn(),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  cancelScheduledNotificationAsync: jest.fn(),
  cancelAllScheduledNotificationsAsync: jest.fn(),
  getAllScheduledNotificationsAsync: jest.fn(),
}));

const mockScheduleNotificationAsync = Notifications.scheduleNotificationAsync as jest.Mock;
const mockCancelScheduledNotificationAsync =
  Notifications.cancelScheduledNotificationAsync as jest.Mock;
const mockCancelAllScheduledNotificationsAsync =
  Notifications.cancelAllScheduledNotificationsAsync as jest.Mock;
const mockGetAllScheduledNotificationsAsync =
  Notifications.getAllScheduledNotificationsAsync as jest.Mock;
const mockGetPermissionsAsync = Notifications.getPermissionsAsync as jest.Mock;
const mockRequestPermissionsAsync = Notifications.requestPermissionsAsync as jest.Mock;

// 監控 react-native Linking
jest.spyOn(Linking, 'openURL').mockImplementation(() => Promise.resolve(true as any));
jest.spyOn(Linking, 'openSettings').mockImplementation(() => Promise.resolve(true as any));

describe('notificationService（每日讀書提醒服務）', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();

    // 預設排程清單為空
    mockGetAllScheduledNotificationsAsync.mockResolvedValue([]);
    // 預設已取得權限
    mockGetPermissionsAsync.mockResolvedValue({
      status: Notifications.PermissionStatus.GRANTED,
    });
    mockRequestPermissionsAsync.mockResolvedValue({
      status: Notifications.PermissionStatus.GRANTED,
    });
    mockScheduleNotificationAsync.mockResolvedValue('notif-id-123');
    mockCancelScheduledNotificationAsync.mockResolvedValue(undefined);
  });

  describe('1. 讀取與儲存提醒設定（loadReminderSettings & saveReminderSettings）', () => {
    it('在無任何儲存資料時，應回傳預設設定（關閉、晚上 20:00）', async () => {
      const settings = await loadReminderSettings();
      expect(settings).toEqual({
        enabled: false,
        hour: 20,
        minute: 0,
        notificationId: null,
      });
    });

    it('能正確讀取已儲存之自訂時間與狀態', async () => {
      const custom: ReminderSettings = {
        enabled: true,
        hour: 19,
        minute: 30,
        notificationId: 'notif-custom-99',
      };
      await saveReminderSettings(custom);

      const loaded = await loadReminderSettings();
      expect(loaded).toEqual(custom);
    });

    it('若儲存的 JSON 損壞或格式不合法，應安全退回預設設定而不拋出錯誤', async () => {
      await AsyncStorage.setItem(REMINDER_SETTINGS_KEY, '{invalid_json}');

      const loaded = await loadReminderSettings();
      expect(loaded).toEqual(DEFAULT_REMINDER_SETTINGS);
    });

    it('若儲存的時間超出合法範圍（例如 hour: 99），應校正回合法預設值', async () => {
      await AsyncStorage.setItem(
        REMINDER_SETTINGS_KEY,
        JSON.stringify({ enabled: true, hour: 99, minute: -5, notificationId: 'bad' }),
      );

      const loaded = await loadReminderSettings();
      expect(loaded.hour).toBe(20);
      expect(loaded.minute).toBe(0);
      expect(loaded.enabled).toBe(true);
    });
  });

  describe('2. 權限檢查與引導設定（Permissions & Settings Navigation）', () => {
    it('getNotificationPermissionStatus 應正確回傳目前系統通知權限狀態', async () => {
      mockGetPermissionsAsync.mockResolvedValueOnce({
        status: Notifications.PermissionStatus.DENIED,
      });
      const status = await getNotificationPermissionStatus();
      expect(status).toBe(Notifications.PermissionStatus.DENIED);
    });

    it('requestNotificationPermission 請求通知權限且使用者允許時應回傳 true', async () => {
      mockRequestPermissionsAsync.mockResolvedValueOnce({
        status: Notifications.PermissionStatus.GRANTED,
      });
      const granted = await requestNotificationPermission();
      expect(granted).toBe(true);
      expect(mockRequestPermissionsAsync).toHaveBeenCalledWith({
        ios: {
          allowAlert: true,
          allowBadge: true,
          allowSound: true,
        },
      });
    });

    it('requestNotificationPermission 使用者拒絕或拋出錯誤時應回傳 false', async () => {
      mockRequestPermissionsAsync.mockResolvedValueOnce({
        status: Notifications.PermissionStatus.DENIED,
      });
      const granted = await requestNotificationPermission();
      expect(granted).toBe(false);

      mockRequestPermissionsAsync.mockRejectedValueOnce(new Error('Permission dialog cancelled'));
      const errorResult = await requestNotificationPermission();
      expect(errorResult).toBe(false);
    });

    it('openDeviceNotificationSettings 在 iOS 上應導引至 app-settings:', async () => {
      await openDeviceNotificationSettings();
      expect(Linking.openURL).toHaveBeenCalledWith('app-settings:');
    });
  });

  describe('3. 每日讀書提醒排程建立（scheduleDailyReminder）', () => {
    it('權限已具備時，應成功建立日曆型每日重複排程並更新 storage', async () => {
      const res = await scheduleDailyReminder(21, 15);

      expect(res.success).toBe(true);
      expect(res.identifier).toBe('notif-id-123');

      // 驗證呼叫排程 API 傳入正確之文案與觸發器
      expect(mockScheduleNotificationAsync).toHaveBeenCalledWith({
        content: {
          title: NOTIFICATION_TITLE,
          body: NOTIFICATION_BODY,
          sound: true,
          data: { tag: REMINDER_TAG },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DAILY,
          hour: 21,
          minute: 15,
        },
      });

      // 驗證儲存至本機
      const saved = await loadReminderSettings();
      expect(saved).toEqual({
        enabled: true,
        hour: 21,
        minute: 15,
        notificationId: 'notif-id-123',
      });
    });

    it('若初次排程時權限為 UNDETERMINED，應主動請求權限並在使用者同意後建立排程', async () => {
      mockGetPermissionsAsync.mockResolvedValueOnce({
        status: Notifications.PermissionStatus.UNDETERMINED,
      });
      mockRequestPermissionsAsync.mockResolvedValueOnce({
        status: Notifications.PermissionStatus.GRANTED,
      });

      const res = await scheduleDailyReminder(20, 0);
      expect(mockRequestPermissionsAsync).toHaveBeenCalled();
      expect(res.success).toBe(true);
    });

    it('若使用者拒絕通知權限，應返回 PERMISSION_DENIED 且絕不呼叫 scheduleNotificationAsync', async () => {
      mockGetPermissionsAsync.mockResolvedValueOnce({
        status: Notifications.PermissionStatus.UNDETERMINED,
      });
      mockRequestPermissionsAsync.mockResolvedValueOnce({
        status: Notifications.PermissionStatus.DENIED,
      });

      const res = await scheduleDailyReminder(20, 0);
      expect(res.success).toBe(false);
      expect(res.error).toBe('PERMISSION_DENIED');
      expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();

      // 本機設定亦不得被寫入為啟用
      const saved = await loadReminderSettings();
      expect(saved.enabled).toBe(false);
    });

    it('排程前應執行防重複清理，取消舊的每日讀書提醒', async () => {
      // 模擬系統已有舊的 daily_study_reminder 通知
      mockGetAllScheduledNotificationsAsync.mockResolvedValueOnce([
        {
          identifier: 'old-reminder-1',
          content: { data: { tag: REMINDER_TAG } },
        },
        {
          identifier: 'other-app-alarm',
          content: { data: { tag: 'other_purpose' } },
        },
      ]);

      await scheduleDailyReminder(20, 0);

      // 應取消舊的讀書提醒，但絕對不影響 other-app-alarm
      expect(mockCancelScheduledNotificationAsync).toHaveBeenCalledWith('old-reminder-1');
      expect(mockCancelScheduledNotificationAsync).not.toHaveBeenCalledWith('other-app-alarm');
      // 絕對不可清空所有通知
      expect(mockCancelAllScheduledNotificationsAsync).not.toHaveBeenCalled();
    });

    it('若 scheduleNotificationAsync 發生例外，應妥善捕捉並回傳失敗，不得拋出 crash', async () => {
      mockScheduleNotificationAsync.mockRejectedValueOnce(new Error('OS Notification Error'));

      const res = await scheduleDailyReminder(20, 0);
      expect(res.success).toBe(false);
      expect(res.error).toContain('OS Notification Error');
    });
  });

  describe('4. 取消每日讀書提醒（cancelDailyReminder）', () => {
    it('應準確取消本 App 之每日提醒通知，將 storage 標記為 disabled，並保留其他通知', async () => {
      await saveReminderSettings({
        enabled: true,
        hour: 20,
        minute: 0,
        notificationId: 'my-reminder-id',
      });

      mockGetAllScheduledNotificationsAsync.mockResolvedValueOnce([
        {
          identifier: 'my-reminder-id',
          content: { data: { tag: REMINDER_TAG } },
        },
        {
          identifier: 'unrelated-notification',
          content: { data: {} },
        },
      ]);

      const res = await cancelDailyReminder();
      expect(res.success).toBe(true);

      expect(mockCancelScheduledNotificationAsync).toHaveBeenCalledWith('my-reminder-id');
      expect(mockCancelScheduledNotificationAsync).not.toHaveBeenCalledWith(
        'unrelated-notification',
      );
      expect(mockCancelAllScheduledNotificationsAsync).not.toHaveBeenCalled();

      const saved = await loadReminderSettings();
      expect(saved.enabled).toBe(false);
      expect(saved.notificationId).toBeNull();
      // 時間設定應保留（供日後再次開啟時沿用）
      expect(saved.hour).toBe(20);
      expect(saved.minute).toBe(0);
    });

    it('若取消排程時發生異常，應回傳包含 error 的物件而不拋出 unhandled rejection', async () => {
      mockGetAllScheduledNotificationsAsync.mockRejectedValueOnce(
        new Error('Failed to query notifications'),
      );

      const res = await cancelDailyReminder();
      expect(res.success).toBe(false);
      expect(res.error).toBeDefined();
    });
  });

  describe('5. App 重回前景同步權限與排程狀態（syncReminderOnAppForeground）', () => {
    it('若提醒本身未開啟，重回前景時應不執行多餘操作', async () => {
      await saveReminderSettings({
        enabled: false,
        hour: 20,
        minute: 0,
        notificationId: null,
      });

      const res = await syncReminderOnAppForeground();
      expect(res.updated).toBe(false);
      expect(res.settings.enabled).toBe(false);
      expect(mockCancelScheduledNotificationAsync).not.toHaveBeenCalled();
      expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
    });

    it('若使用者在 iOS 系統設定中關閉了通知權限，重回前景時應自動同步為關閉狀態並清理排程', async () => {
      await saveReminderSettings({
        enabled: true,
        hour: 20,
        minute: 0,
        notificationId: 'notif-revoked-1',
      });

      // 模擬 iOS 系統設定權限已被改為 DENIED
      mockGetPermissionsAsync.mockResolvedValueOnce({
        status: Notifications.PermissionStatus.DENIED,
      });

      const res = await syncReminderOnAppForeground();
      expect(res.updated).toBe(true);
      expect(res.settings.enabled).toBe(false);
      expect(res.settings.notificationId).toBeNull();

      // 檢查 storage 也已更新為關閉
      const saved = await loadReminderSettings();
      expect(saved.enabled).toBe(false);
    });

    it('若權限依然允許，但系統排程意外遺失（0 筆），重回前景時應自動重新補上排程', async () => {
      await saveReminderSettings({
        enabled: true,
        hour: 20,
        minute: 0,
        notificationId: 'lost-id',
      });

      // 系統中已無任何排程
      mockGetAllScheduledNotificationsAsync.mockResolvedValueOnce([]);
      mockScheduleNotificationAsync.mockResolvedValueOnce('new-healed-id');

      const res = await syncReminderOnAppForeground();
      expect(res.updated).toBe(true);
      expect(mockScheduleNotificationAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.DAILY,
            hour: 20,
            minute: 0,
          },
        }),
      );
      expect(res.settings.notificationId).toBe('new-healed-id');
    });

    it('若系統中出現重複的排程（2 筆以上），應保留第一筆並取消多餘的重複排程', async () => {
      await saveReminderSettings({
        enabled: true,
        hour: 20,
        minute: 0,
        notificationId: 'dup-1',
      });

      mockGetAllScheduledNotificationsAsync.mockResolvedValueOnce([
        { identifier: 'dup-1', content: { data: { tag: REMINDER_TAG } } },
        { identifier: 'dup-2', content: { data: { tag: REMINDER_TAG } } },
      ]);

      const res = await syncReminderOnAppForeground();
      expect(res.updated).toBe(true);
      expect(mockCancelScheduledNotificationAsync).toHaveBeenCalledWith('dup-2');
      expect(mockCancelScheduledNotificationAsync).not.toHaveBeenCalledWith('dup-1');
      expect(res.settings.notificationId).toBe('dup-1');
    });

    it('若排程狀態健康（恰有 1 筆吻合排程），應返回 updated: false', async () => {
      await saveReminderSettings({
        enabled: true,
        hour: 20,
        minute: 0,
        notificationId: 'healthy-id',
      });

      mockGetAllScheduledNotificationsAsync.mockResolvedValueOnce([
        { identifier: 'healthy-id', content: { data: { tag: REMINDER_TAG } } },
      ]);

      const res = await syncReminderOnAppForeground();
      expect(res.updated).toBe(false);
      expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
      expect(mockCancelScheduledNotificationAsync).not.toHaveBeenCalled();
    });
  });

  describe('6. 本機資料隔離性（Data Isolation & Security）', () => {
    it('提醒設定儲存鍵應為 @exam_plan_ai:reminder_settings，獨立於讀書資料', () => {
      expect(REMINDER_SETTINGS_KEY).toBe('@exam_plan_ai:reminder_settings');
    });

    it('通知設定操作不應影響任何會員權限或 AI 額度鍵值', async () => {
      // 設置模擬的 subscription 與 ai_usage
      await AsyncStorage.setItem('@exam_plan_ai:subscription', JSON.stringify({ plan: 'pro' }));
      await AsyncStorage.setItem('@exam_plan_ai:ai_usage', JSON.stringify({ count: 5 }));

      // 執行通知排程與取消
      await scheduleDailyReminder(19, 0);
      await cancelDailyReminder();

      // 檢查 subscription 與 ai_usage 完好無缺
      const sub = await AsyncStorage.getItem('@exam_plan_ai:subscription');
      const ai = await AsyncStorage.getItem('@exam_plan_ai:ai_usage');

      expect(JSON.parse(sub!)).toEqual({ plan: 'pro' });
      expect(JSON.parse(ai!)).toEqual({ count: 5 });
    });
  });

  describe('7. 操作序列化與連續快速變更防護（Serialization Queue & Race Condition Defense）', () => {
    it('連續並發呼叫 scheduleDailyReminder 時應依序執行，不發生競爭或重複錯誤，並以最後一次為準', async () => {
      let callSeq = 0;
      mockScheduleNotificationAsync.mockImplementation(async () => {
        callSeq++;
        return `notif-id-${callSeq}`;
      });

      // 模擬連續快速變更時間（並行發送 3 次排程請求）
      const results = await Promise.all([
        scheduleDailyReminder(18, 0),
        scheduleDailyReminder(19, 0),
        scheduleDailyReminder(20, 30),
      ]);

      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(results[2].success).toBe(true);

      // 最終儲存設定應精準對應最後一次操作（20:30）
      const saved = await loadReminderSettings();
      expect(saved.hour).toBe(20);
      expect(saved.minute).toBe(30);
      expect(saved.enabled).toBe(true);
    });

    it('連續交替開關與排程操作應依序結算，最終狀態穩定一致', async () => {
      // 開啟 -> 關閉 -> 開啟
      const p1 = scheduleDailyReminder(20, 0);
      const p2 = cancelDailyReminder();
      const p3 = scheduleDailyReminder(21, 15);

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
      expect(r3.success).toBe(true);

      const saved = await loadReminderSettings();
      expect(saved.enabled).toBe(true);
      expect(saved.hour).toBe(21);
      expect(saved.minute).toBe(15);
    });
  });
});
