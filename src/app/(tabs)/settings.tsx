import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { AppText } from '../../components/AppText';
import { Segmented, Stepper, WeekdayPicker } from '../../components/FormControls';
import { Row, Section } from '../../components/List';
import { Screen } from '../../components/Screen';
import { ScreenHeader } from '../../components/ScreenHeader';
import { INTENSITY_DESCRIPTIONS, INTENSITY_LABELS } from '../../constants/labels';
import { getBackendUrlFromStorage, saveBackendUrlToStorage } from '../../storage';
import { useAppStore } from '../../store/AppStore';
import { spacing } from '../../theme';
import type { Intensity, Weekday } from '../../types/models';
import { formatMinutes } from '../../utils/date';

const INTENSITY_OPTIONS = (['light', 'normal', 'intense'] as Intensity[]).map((value) => ({
  value,
  label: INTENSITY_LABELS[value],
}));

export default function SettingsScreen() {
  const { data, updatePreferences, loadDemo, clearAll } = useAppStore();
  const { preferences } = data;
  const [backendUrl, setBackendUrl] = useState<string | null>(null);

  useEffect(() => {
    getBackendUrlFromStorage().then(setBackendUrl);
  }, []);

  const editBackendUrl = () => {
    Alert.prompt(
      '設定 Vercel 後端網址',
      '請輸入您的後端伺服器網址（預設已連線至您的正式 Vercel 後端）：',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '恢復預設網址',
          style: 'destructive',
          onPress: async () => {
            await saveBackendUrlToStorage(null);
            const def = await getBackendUrlFromStorage();
            setBackendUrl(def);
          },
        },
        {
          text: '儲存',
          onPress: async (val?: string) => {
            const trimmed = val ? val.trim() : null;
            await saveBackendUrlToStorage(trimmed);
            const updated = await getBackendUrlFromStorage();
            setBackendUrl(updated);
          },
        },
      ],
      'plain-text',
      backendUrl ?? '',
    );
  };

  const onRestDaysChange = (days: Weekday[]) => {
    if (days.length >= 7) {
      Alert.alert('至少要保留一天讀書', '每週七天都設為休息日的話，就沒辦法安排讀書任務。');
      return;
    }
    updatePreferences({ restDays: days });
  };

  const confirmLoadDemo = () => {
    Alert.alert('載入示範資料？', '目前所有考試與任務會被示範資料取代。', [
      { text: '取消', style: 'cancel' },
      { text: '載入', onPress: loadDemo },
    ]);
  };

  const confirmClearAll = () => {
    Alert.alert('清除所有資料？', '所有考試、任務與完成紀錄都會被刪除，這個動作無法復原。', [
      { text: '取消', style: 'cancel' },
      { text: '清除', style: 'destructive', onPress: clearAll },
    ]);
  };

  return (
    <Screen topInset>
      <ScreenHeader title="設定" />

      <Section
        title="讀書時間"
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

      <Section title="通知" footer="通知功能會在之後的版本加入，目前不會發送任何通知。">
        <Row title="讀書提醒" value="尚未開放" disabled />
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
      </Section>

      <Section
        title="AI 雲端服務（讀書教練）"
        footer="零金鑰原則：AI API 金鑰僅由 Vercel 後端環境變數安全保管，App 端無任何金鑰外洩風險。若未設定伺服端或連線中斷，將自動無縫使用高品質本機排程演算法。"
      >
        <Row
          title="後端伺服器端點"
          value={backendUrl ? (backendUrl.length > 25 ? `${backendUrl.slice(0, 22)}...` : backendUrl) : '尚未設定（本機模式）'}
          showChevron
          onPress={editBackendUrl}
        />
        <Row
          title="AI 建議每日額度"
          value={
            data.subscription?.plan === 'free'
              ? '免費版（每日 3 次 · 午夜重設）'
              : 'Pro 會員（每日 15 次 · 午夜重設）'
          }
          disabled
        />
        <Row
          title="零金鑰架構說明"
          value="安全防護"
          onPress={() =>
            Alert.alert(
              '零金鑰安全設計',
              '為了防止 API 金鑰遭到逆向工程竊取，本 App 嚴格遵循零金鑰原則：\n\n1. 所有 AI 讀書建議請求皆由您的獨立雲端後端（Vercel）安全代理轉發。\n2. 伺服端具備嚴格連線逾時、流量防禦、IP 頻率限制與日/月預算防護。\n3. 若離線或額度耗盡，自動降級為本機排程演算法，不中斷讀書流程。',
            )
          }
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
        title="資料"
        footer="所有考試、計畫進度與偏好設定均安全儲存在您的 iPhone 本機中，關閉 App 後資料依然完整保存。"
      >
        <Row title="匯出資料" value="尚未開放" disabled />
        <Row title="載入示範資料" onPress={confirmLoadDemo} />
        <Row title="清除所有資料" destructive onPress={confirmClearAll} />
      </Section>

      <Section title="關於">
        <Row title="服務條款" showChevron onPress={() => router.push('/terms')} />
        <Row title="隱私權政策" showChevron onPress={() => router.push('/privacy')} />
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
