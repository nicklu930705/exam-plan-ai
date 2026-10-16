import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { spacing } from '../theme';
import { AppText } from './AppText';

interface Props {
  title: string;
  subtitle?: string;
  subtitlePosition?: 'above' | 'below';
  right?: ReactNode;
}

/** 分頁畫面的大標題 */
export function ScreenHeader({ title, subtitle, subtitlePosition = 'above', right }: Props) {
  return (
    <View style={styles.wrap}>
      <View style={{ flex: 1 }}>
        {subtitle && subtitlePosition === 'above' ? (
          <AppText variant="subhead" secondary style={{ marginBottom: spacing.xs }}>
            {subtitle}
          </AppText>
        ) : null}
        <AppText variant="largeTitle" accessibilityRole="header">
          {title}
        </AppText>
        {subtitle && subtitlePosition === 'below' ? (
          <AppText variant="subhead" secondary style={{ marginTop: spacing.xs }}>
            {subtitle}
          </AppText>
        ) : null}
      </View>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginBottom: spacing.xl,
    gap: spacing.md,
  },
});
