import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { AppStoreProvider } from '../store/AppStore';
import { colors } from '../theme';

/**
 * 根導覽（Stack）
 * - (tabs)：底部四個分頁
 * - 其他畫面從分頁推入，使用 iOS 標準返回手勢
 */
export default function RootLayout() {
  return (
    <AppStoreProvider>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerTintColor: colors.primary,
          headerStyle: { backgroundColor: colors.background },
          headerTitleStyle: { color: colors.text },
          headerShadowVisible: false,
          headerBackTitle: '返回',
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="exam/new" options={{ title: '建立考試', presentation: 'modal' }} />
        <Stack.Screen name="exam/edit" options={{ title: '編輯考試', presentation: 'modal' }} />
        <Stack.Screen name="task/[id]" options={{ title: '任務詳情' }} />
        <Stack.Screen name="reschedule" options={{ title: '重新安排計畫' }} />
        <Stack.Screen name="exams" options={{ title: '考試與計畫管理' }} />
        <Stack.Screen name="terms" options={{ title: '服務條款' }} />
        <Stack.Screen name="privacy" options={{ title: '隱私權政策' }} />
      </Stack>
    </AppStoreProvider>
  );
}
