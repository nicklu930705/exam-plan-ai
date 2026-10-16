import React from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from '../components/AppText';
import { Screen } from '../components/Screen';
import { colors, radius, spacing } from '../theme';

const SECTIONS: { title: string; body: string }[] = [
  {
    title: '1. 本機資料保存與範圍',
    body: '「考試計畫 AI」專注於協助您有效管理備考進度。您自行輸入的考試名稱、考試目標日期、各科目名稱與熟悉度、章節劃分、每日預計研讀時間、讀書強度、每週休息日、任務勾選狀態以及專注計時器紀錄，均直接保存在您的 iPhone 本機儲存空間（AsyncStorage）中。\n\n在您未主動使用 AI 建議或雲端功能前，上述所有備考資訊僅於您的裝置內部進行離線運算與呈現，不會自動同步至任何外部伺服器。',
  },
  {
    title: '2. 使用「AI 讀書建議」時傳送之資料',
    body: '當您在 App 內主動點擊「AI 讀書建議」時，為生成貼合您備考進度的具體建言，App 會將當前必要的上下文資訊經由 HTTPS 加密傳送至本服務部署於 Vercel 的專用後端安全代理，並轉發至第三方大型語言模型供應商（OpenAI API）進行分析與建議生成。\n\n實際傳輸的欄位包含：\n• 考試名稱與考試日期\n• 每日可用研讀時間與讀書強度\n• 科目名稱、熟悉度評估、章節總數與已完成章節數\n• 近期讀書任務完成率與落後任務數量\n\n【不收集之敏感資訊】：本服務絕不存取或傳輸您的真實姓名、身分證字號、電話號碼、聯絡人通訊錄、照片相簿、精確 GPS 定位或任何金融付款帳號資訊。',
  },
  {
    title: '3. 裝置識別碼與用量防護',
    body: '為提供每位使用者每日合理的使用額度（例如免費版每日 3 次 AI 讀書建議），並防止伺服器遭受異常頻繁呼叫或阻斷服務攻擊，App 於首次啟動時會在您的裝置本機產生一組隨機亂數之裝置識別碼（X-Client-Device-Id）。\n\n此識別碼連同發起請求時的網路 IP 位址，僅用於伺服器端 Redis 資料庫計算當日呼叫次數、執行每分鐘頻率限制（Rate Limit）以及全域成本預算安全鎖定。該識別碼未與任何外部個人身分或帳號資料庫進行關聯。',
  },
  {
    title: '4. 第三方服務、伺服器日誌與資料保留',
    body: '本服務在提供雲端 AI 建議時，使用以下受信任之第三方雲端基礎設施：\n\n• Vercel（雲端運算代管）：負責執行無伺服器後端代理函式。在網路連線傳輸過程中，系統可能會記錄暫態標準伺服器存取紀錄（如連線 IP、User-Agent、請求時間與 HTTP 回應碼），以維護連線安全與診斷伺服器狀態。此類存取日誌僅依 Vercel 平台預設之有限週期短暫保存，本服務未額外設置永久日誌資料倉儲。\n• Upstash Redis（用量控制資料庫）：負責儲存每日呼叫次數計數器、頻率限制與並行安全鎖。所有鍵值均依程式碼設定自動過期機制（TTL）：防並行鎖與每分鐘頻率限制鍵於約 30～65 秒內自動釋放刪除；使用者每日額度與日預算統計鍵於 48 小時內由 Redis 記憶體中自動過期清除；每月預算統計鍵於約 65 天後自動失效。伺服端資料庫不永久保留您的個人備考歷史紀錄。\n• OpenAI API（AI 模型推論）：負責處理備考上下文並生成繁體中文研讀策略。依據 OpenAI 官方目前公開之商用 API 資料處理規範，透過商用 API 傳輸之資料預設不應用於訓練其公共基礎模型；OpenAI 官方政策說明其系統通常為防範濫用而保留資料最多 30 天，期滿後自動清除（具體保留時限與政策隨 OpenAI 官方規範更新為準）。',
  },
  {
    title: '5. 資料刪除與使用者權利',
    body: '您對自己的資料擁有完全的控制權：\n\n• 清除本機資料：您可隨時至 App「設定 → 資料 → 清除所有資料」，一鍵清空手機上保存的所有考試、任務、進度與計時歷史紀錄。\n• 移除 App：若您從 iPhone 解除安裝（刪除）本 App，iOS 系統將一併清除該 App 沙盒內的所有本機儲存資料。\n• 伺服端查詢或清除請求：若您對本服務之伺服端存取紀錄或用量資料有任何疑問，或欲請求清除特定裝置識別碼之紀錄，可透過下方聯絡方式與我們聯繫。',
  },
  {
    title: '6. 開發者聯絡方式與政策更新',
    body: '本隱私權政策將隨著服務功能演進與法規要求適時修訂。若您對本政策或個人資料處理有任何疑問、建議或需求，請透過以下管道聯絡：\n\n• 客服與技術支援信箱：examplanai.support@gmail.com\n• 支援網頁：https://exam-plan-ai-backend-coral.vercel.app/support\n• 隱私權政策公開網頁：https://exam-plan-ai-backend-coral.vercel.app/privacy\n\n最後更新日期：2026 年 10 月',
  },
];

export default function PrivacyScreen() {
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
    backgroundColor: colors.surface,
    padding: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.separator,
  },
  title: {
    marginBottom: spacing.sm,
    color: colors.text,
  },
  body: {
    lineHeight: 22,
    color: colors.textSecondary,
  },
});
