import Constants from 'expo-constants';
import DateTimePicker from '@react-native-community/datetimepicker';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Linking, StyleSheet, Switch, View } from 'react-native';

import { AppText } from '../../components/AppText';
import { Segmented, Stepper, WeekdayPicker } from '../../components/FormControls';
import { Row, Section } from '../../components/List';
import { Screen } from '../../components/Screen';
import { ScreenHeader } from '../../components/ScreenHeader';
import { INTENSITY_DESCRIPTIONS, INTENSITY_LABELS } from '../../constants/labels';
import {
  createBackupPayload,
  exportBackupToFile,
  pickAndReadBackupFile,
  validateBackupJson,
} from '../../services/backupService';
import {
  DEFAULT_REMINDER_SETTINGS,
  cancelDailyReminder,
  loadReminderSettings,
  openDeviceNotificationSettings,
  requestNotificationPermission,
  scheduleDailyReminder,
  syncReminderOnAppForeground,
  type ReminderSettings,
} from '../../services/notificationService';
import { useAppStore } from '../../store/AppStore';
import { colors, spacing } from '../../theme';
import type { Intensity, Weekday } from '../../types/models';
import { formatMinutes } from '../../utils/date';

const INTENSITY_OPTIONS = (['light', 'normal', 'intense'] as Intensity[]).map((value) => ({
  value,
  label: INTENSITY_LABELS[value],
}));

export default function SettingsScreen() {
  const { data, updatePreferences, restoreStudyData, clearAll } = useAppStore();
  const { preferences } = data;
  const [isExporting, setIsExporting] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [reminderSettings, setReminderSettings] = useState<ReminderSettings>(DEFAULT_REMINDER_SETTINGS);
  const [isTogglingReminder, setIsTogglingReminder] = useState(false);
  const reminderTimeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingScheduleRef = useRef<{ hour: number; minute: number } | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;

    // 載入初始提醒設定並同步檢查權限
    loadReminderSettings().then((loaded) => {
      if (!isMountedRef.current) return;
      setReminderSettings(loaded);
      syncReminderOnAppForeground().then((syncRes) => {
        if (!isMountedRef.current) return;
        if (syncRes.updated) {
          setReminderSettings(syncRes.settings);
        }
      });
    });

    // 監聽 App 從背景重回前景（同步使用者可能在 iOS 系統設定修改的權限）
    const subscription = AppState.addEventListener('change', async (nextState) => {
      if (nextState === 'active') {
        const syncRes = await syncReminderOnAppForeground();
        if (isMountedRef.current && syncRes.updated) {
          setReminderSettings(syncRes.settings);
        }
      }
    });

    return () => {
      isMountedRef.current = false;
      subscription.remove();
      if (reminderTimeDebounceRef.current) {
        clearTimeout(reminderTimeDebounceRef.current);
      }
      // 使用者在 300ms 內快速離開設定頁時，立即刷新排程，確保設定絕不遺失
      if (pendingScheduleRef.current) {
        const { hour, minute } = pendingScheduleRef.current;
        pendingScheduleRef.current = null;
        scheduleDailyReminder(hour, minute).catch((err) => {
          console.error('離開設定頁時執行排程失敗：', err);
        });
      }
    };
  }, []);

  const reminderTimeDate = useMemo(() => {
    const d = new Date();
    d.setHours(reminderSettings.hour, reminderSettings.minute, 0, 0);
    return d;
  }, [reminderSettings.hour, reminderSettings.minute]);

  const handleToggleReminder = async (enabled: boolean) => {
    if (enabled) {
      setIsTogglingReminder(true);
      try {
        const granted = await requestNotificationPermission();
        if (!granted) {
          Alert.alert(
            '無法開啟讀書提醒',
            '「考試計畫 AI」需要通知權限才能在每天預定時間提醒您讀書。請至 iOS「設定」允許本 App 發送通知。',
            [
              { text: '稍後再說', style: 'cancel' },
              {
                text: '前往設定',
                onPress: () => {
                  openDeviceNotificationSettings();
                },
              },
            ],
          );
          return;
        }

        const res = await scheduleDailyReminder(reminderSettings.hour, reminderSettings.minute);
        if (res.success) {
          setReminderSettings((prev) => ({
            ...prev,
            enabled: true,
            notificationId: res.identifier ?? null,
          }));
        } else {
          Alert.alert('設定失敗', res.error ?? '無法排程每日提醒通知。');
        }
      } catch (err: any) {
        Alert.alert('設定失敗', err?.message ?? '開啟通知時發生未預期的錯誤。');
      } finally {
        setIsTogglingReminder(false);
      }
    } else {
      setIsTogglingReminder(true);
      if (reminderTimeDebounceRef.current) {
        clearTimeout(reminderTimeDebounceRef.current);
      }
      pendingScheduleRef.current = null;
      try {
        await cancelDailyReminder();
        setReminderSettings((prev) => ({
          ...prev,
          enabled: false,
          notificationId: null,
        }));
      } catch (err: any) {
        Alert.alert('取消失敗', err?.message ?? '關閉通知時發生未預期的錯誤。');
      } finally {
        setIsTogglingReminder(false);
      }
    }
  };

  const handleReminderTimeChange = (_event: any, selectedDate?: Date) => {
    if (!selectedDate) return;
    const hour = selectedDate.getHours();
    const minute = selectedDate.getMinutes();

    if (hour === reminderSettings.hour && minute === reminderSettings.minute) {
      return;
    }

    setReminderSettings((prev) => ({
      ...prev,
      hour,
      minute,
    }));

    if (reminderSettings.enabled) {
      pendingScheduleRef.current = { hour, minute };
      if (reminderTimeDebounceRef.current) {
        clearTimeout(reminderTimeDebounceRef.current);
      }
      reminderTimeDebounceRef.current = setTimeout(async () => {
        pendingScheduleRef.current = null;
        const res = await scheduleDailyReminder(hour, minute);
        if (isMountedRef.current) {
          if (res.success) {
            setReminderSettings((prev) => ({
              ...prev,
              hour,
              minute,
              notificationId: res.identifier ?? null,
            }));
          } else {
            Alert.alert('更新失敗', res.error ?? '更新提醒時間失敗。');
          }
        }
      }, 300);
    }
  };

  const onRestDaysChange = (days: Weekday[]) => {
    if (days.length >= 7) {
      Alert.alert('至少要保留一天讀書', '每週七天都設為休息日的話，就沒辦法安排讀書任務。');
      return;
    }
    updatePreferences({ restDays: days });
  };

  const confirmClearAll = () => {
    Alert.alert(
      '清除所有讀書資料？',
      '這將永久刪除本機中的所有考試、任務與讀書完成紀錄。\n\n⚠️ 此操作無法復原。如果您需要保留現有的讀書進度，請先在上方執行「匯出備份」。是否確定清除？',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '確定清除',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              '最後確認：確定清空資料？',
              '點選「確認刪除」後，所有讀書資料將立即被清空。',
              [
                { text: '放棄', style: 'cancel' },
                {
                  text: '確認刪除',
                  style: 'destructive',
                  onPress: () => {
                    clearAll();
                    Alert.alert('已清除', '所有讀書資料已清除完畢。');
                  },
                },
              ],
            );
          },
        },
      ],
    );
  };

  const handleExportBackup = async () => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const payload = createBackupPayload(data, Constants.expoConfig?.version ?? '1.0.0');
      const result = await exportBackupToFile(payload);
      if (!result.success && !result.canceled) {
        Alert.alert('匯出失敗', result.error ?? '無法完成備份檔案匯出，請稍後再試。');
      } else if (result.success) {
        Alert.alert(
          '備份檔案已備妥',
          '已叫起系統分享面板。請於分享面板中選擇「儲存到檔案」或分享至其他裝置，並請由您自行確認儲存結果。',
        );
      }
    } catch {
      Alert.alert('匯出失敗', '產生備份檔案時發生錯誤，請稍後再試。');
    } finally {
      setIsExporting(false);
    }
  };

  const handleRestoreBackup = async () => {
    if (isRestoring) return;
    setIsRestoring(true);
    try {
      const pickResult = await pickAndReadBackupFile();
      if (pickResult.status === 'cancelled') {
        return;
      }
      if (pickResult.status === 'error') {
        Alert.alert('讀取失敗', pickResult.error);
        return;
      }

      const validation = validateBackupJson(pickResult.content);
      if (!validation.isValid) {
        Alert.alert('無法還原備份', validation.error);
        return;
      }

      const { payload } = validation;
      const { exams, tasks } = payload.studyData;
      const exportDateStr = new Date(payload.exportedAt).toLocaleString('zh-TW', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });

      Alert.alert(
        '確認還原讀書資料？',
        `備份時間：${exportDateStr}\n包含內容：${exams.length} 場考試、${tasks.length} 項任務\n\n⚠️ 警告：還原將以備份內容完整取代手機現有的考試與讀書進度，未備份的進度將被覆蓋且無法復原。是否確定還原？`,
        [
          { text: '取消', style: 'cancel' },
          {
            text: '確認還原',
            style: 'destructive',
            onPress: async () => {
              const res = await restoreStudyData(payload.studyData);
              if (res.success) {
                Alert.alert(
                  '還原成功',
                  `已成功還原 ${exams.length} 場考試與 ${tasks.length} 項任務。`,
                );
              } else {
                Alert.alert('還原失敗', res.error ?? '寫入本機資料庫失敗。');
              }
            },
          },
        ],
      );
    } catch {
      Alert.alert('還原失敗', '解析備份檔案時發生未預期的錯誤，請稍後再試。');
    } finally {
      setIsRestoring(false);
    }
  };

  return (
    <Screen topInset>
      <ScreenHeader title="設定" />

      <Section
        title="讀書偏好"
        footer="這些設定會用在之後產生與重新安排的計畫，不會改動已經完成的任務。"
      >
        <Row
          title="每日可讀書時間"
          right={
            <Stepper
              label="每日可讀書時間"
              value={preferences.dailyMinutes}
              min={30}
              max={720}
              step={15}
              format={formatMinutes}
              onChange={(dailyMinutes) => updatePreferences({ dailyMinutes })}
            />
          }
        />
        <View style={styles.block}>
          <AppText style={styles.blockTitle}>每週休息日</AppText>
          <WeekdayPicker selected={preferences.restDays} onChange={onRestDaysChange} />
          <AppText variant="footnote" secondary style={styles.blockNote}>
            選取的日子預設不安排讀書任務。
          </AppText>
        </View>
        <View style={styles.block}>
          <AppText style={styles.blockTitle}>讀書強度</AppText>
          <Segmented
            options={INTENSITY_OPTIONS}
            value={preferences.intensity}
            onChange={(intensity) => updatePreferences({ intensity })}
          />
          <AppText variant="footnote" secondary style={styles.blockNote}>
            {INTENSITY_DESCRIPTIONS[preferences.intensity]}
          </AppText>
        </View>
      </Section>

      <Section
        title="每日讀書提醒"
        footer={
          reminderSettings.enabled
            ? `每日將於 ${String(reminderSettings.hour).padStart(2, '0')}:${String(reminderSettings.minute).padStart(2, '0')} 發送讀書提醒通知。`
            : '開啟後，App 將在每天指定時間提醒您讀書進度。'
        }
      >
        <Row
          title="每日讀書提醒"
          right={
            <Switch
              value={reminderSettings.enabled}
              onValueChange={handleToggleReminder}
              disabled={isTogglingReminder}
              trackColor={{ false: colors.separator, true: colors.primary }}
            />
          }
        />
        {reminderSettings.enabled ? (
          <Row
            title="提醒時間"
            right={
              <DateTimePicker
                value={reminderTimeDate}
                mode="time"
                display="compact"
                locale="zh-TW"
                accentColor={colors.primary}
                themeVariant="light"
                onChange={handleReminderTimeChange}
              />
            }
          />
        ) : null}
      </Section>

      <Section
        title="會員方案與權限"
        footer="升級 Pro 或 Lifetime 解鎖多考試管理、智慧重新排程、弱科衝刺與個人化建議。"
      >
        <Row
          title="方案與功能權限"
          value={
            data.subscription?.plan === 'lifetime'
              ? '終身買斷版'
              : data.subscription?.plan === 'pro'
                ? 'Pro 訂閱版'
                : 'Free 免費版'
          }
          showChevron
          onPress={() => router.push('/subscription')}
        />
        <Row
          title="AI 讀書教練每日額度"
          value={
            data.subscription?.plan === 'free'
              ? '免費版（每日 3 次 · 午夜重設）'
              : 'Pro 會員（每日 15 次 · 午夜重設）'
          }
          disabled
        />
      </Section>

      <Section title="考試與計畫">
        <Row
          title="管理考試"
          value={`${data.exams.length} 場`}
          showChevron
          onPress={() => router.push('/exams')}
        />
      </Section>

      <Section
        title="資料管理"
        footer="匯出之備份檔案可安全保存於您的「檔案」App 或 iCloud 雲碟，供日後還原使用。"
      >
        <Row title="匯出備份" onPress={handleExportBackup} />
        <Row title="從備份還原" onPress={handleRestoreBackup} />
        <Row title="清除所有資料" destructive onPress={confirmClearAll} />
      </Section>

      <Section title="關於與支援">
        <Row title="服務條款" showChevron onPress={() => router.push('/terms')} />
        <Row title="隱私權政策" showChevron onPress={() => router.push('/privacy')} />
        <Row
          title="聯絡客服"
          value="examplanai.support@gmail.com"
          showChevron
          onPress={() => Linking.openURL('mailto:examplanai.support@gmail.com')}
        />
        <Row title="版本" value={Constants.expoConfig?.version ?? '1.0.0'} />
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({
  block: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  blockTitle: { marginBottom: spacing.md },
  blockNote: { marginTop: spacing.sm },
});
