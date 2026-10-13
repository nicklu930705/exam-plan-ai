import { StyleSheet } from 'react-native';

import { AppText } from '../components/AppText';
import { Screen } from '../components/Screen';
import { spacing } from '../theme';

const SECTIONS: { title: string; body: string }[] = [
  {
    title: '我們收集哪些資料',
    body: '「考試計畫 AI」只會使用你自行輸入的考試名稱、日期、科目、章節、讀書時間與任務完成狀態，用來安排你的讀書計畫。',
  },
  {
    title: '資料存放在哪裡',
    body: '所有資料都只存在你的 iPhone 上。目前沒有帳號、登入或雲端同步功能，也不會把資料傳送到任何伺服器。',
  },
  {
    title: '第三方服務',
    body: '目前沒有使用廣告、分析追蹤或 AI 服務。如果未來加入 AI 建議或雲端備份，會在使用前清楚說明會傳送哪些資料，並徵求你的同意。',
  },
  {
    title: '刪除資料',
    body: '你可以隨時在「設定 → 清除所有資料」刪除 App 中的全部資料；刪除 App 也會一併移除所有資料。',
  },
];

export default function PrivacyScreen() {
  return (
    <Screen bottomInset>
      {SECTIONS.map((s) => (
        <AppText key={s.title} style={styles.block}>
          <AppText variant="headline">{s.title}</AppText>
          {'\n'}
          <AppText secondary>{s.body}</AppText>
        </AppText>
      ))}
      <AppText variant="footnote" secondary>
        最後更新：第一版開發階段
      </AppText>
    </Screen>
  );
}

const styles = StyleSheet.create({
  block: { marginBottom: spacing.xl },
});
