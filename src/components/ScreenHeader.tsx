import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { spacing } from '../theme';
import { AppText } from './AppText';

interface Props {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}

/** 分頁畫面的大標題 */
export function ScreenHeader({ title, subtitle, right }: Props) {
  return (
    <View style={styles.wrap}>
      <View style={{ flex: 1 }}>
        {subtitle ? (
          <AppText variant="subhead" secondary>
            {subtitle}
          </AppText>
        ) : null}
        <AppText variant="largeTitle" accessibilityRole="header">
          {title}
        </AppText>
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
