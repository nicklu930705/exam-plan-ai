import React from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from '../components/AppText';
import { Screen } from '../components/Screen';
import { spacing } from '../theme';

const SECTIONS = [
  {
    title: '1. 方案與服務說明',
    body: '「考試計畫 AI」提供 Free 免費版、Pro 訂閱版（按月 / 按年）及 Lifetime 終身買斷版。免費版提供 1 場有效考試的本機排程與計時；Pro 與 Lifetime 方案解鎖多考試管理、智慧重排與進階分析等功能。',
  },
  {
    title: '2. 訂閱與自動續訂說明',
    body: 'Pro 月訂閱（NT$149）與 Pro 年訂閱（NT$990）為自動續訂服務。購買確認後將自您的 Apple ID 帳戶扣款。除非在當前訂閱期結束前至少 24 小時關閉自動續約，否則系統將依所選方案自動續訂。您可隨時至 iPhone「設定 → Apple ID → 訂閱項目」管理或取消訂閱。',
  },
  {
    title: '3. Lifetime 終身買斷版範圍說明',
    body: 'Lifetime 終身買斷版（NT$1,690）享有永久解鎖 iPhone 本機端所有核心備考功能、演算法與多考試管理。第三方生成式 AI API 服務提供每月 30 次基礎額度或自備金鑰（BYOK）；本方案不包含未來可能產生的第三方雲端儲存伺服器持續成本。',
  },
  {
    title: '4. 本機資料與隱私權保護',
    body: '所有讀書計畫、歷史完成紀錄及時間調整皆加密或安全儲存於您的手機本機。即使方案到期或更換方案，您既有的考試與歷史讀書紀錄絕不會被刪除或損壞。',
  },
  {
    title: '5. 開發者預覽測試提示',
    body: '當 App 處於「開發者測試預覽模式」時，方案切換僅用於本機功能驗證，不產生任何 App Store 扣款收據或實際金流交易。',
  },
];

export default function TermsScreen() {
  return (
    <Screen bottomInset>
      <View style={styles.container}>
        {SECTIONS.map((s) => (
          <View key={s.title} style={styles.block}>
            <AppText variant="headline" style={styles.title}>
              {s.title}
            </AppText>
            <AppText secondary style={styles.body}>
              {s.body}
            </AppText>
          </View>
        ))}
        <AppText variant="footnote" secondary style={styles.footer}>
          最後更新：2026 年 10 月
        </AppText>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: spacing.md,
  },
  block: {
    marginBottom: spacing.xl,
  },
  title: {
    marginBottom: spacing.xs,
  },
  body: {
    lineHeight: 22,
  },
  footer: {
    marginTop: spacing.md,
    textAlign: 'center',
  },
});
