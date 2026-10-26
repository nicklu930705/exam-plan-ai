import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, spacing } from '../theme';

interface Props {
  children: ReactNode;
  /**
   * 分頁畫面沒有系統導覽列，需要自己避開瀏海／動態島；
   * 有導覽列（例如任務詳情）的畫面則由系統處理。
   */
  topInset?: boolean;
  /** 固定在畫面底部的主要操作區（例如「產生讀書計畫」按鈕） */
  footer?: ReactNode;
  /** 底部是否需要避開 Home 指示條（分頁畫面由底部導覽列處理） */
  bottomInset?: boolean;
  contentStyle?: ViewStyle;
}

export function Screen({ children, topInset, footer, bottomInset, contentStyle }: Props) {
  const insets = useSafeAreaInsets();
  const bottomPad = bottomInset ? insets.bottom : 0;
  // 分頁畫面在 iPhone 頂部需避開狀態列／瀏海／動態島
  // 透過 SafeAreaProvider initialMetrics，首幀即可取得精確原生 insets
  const topPad = topInset ? insets.top : 0;

  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.root}
        contentInsetAdjustmentBehavior="never"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[
          styles.content,
          { paddingTop: topPad + spacing.md },
          { paddingBottom: (footer ? 0 : bottomPad) + spacing.xxl },
          contentStyle,
        ]}
      >
        {children}
      </ScrollView>
      {footer ? (
        <View style={[styles.footer, { paddingBottom: bottomPad + spacing.md }]}>{footer}</View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: spacing.lg },
  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    backgroundColor: colors.background,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
  },
});
