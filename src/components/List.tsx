import { Ionicons } from '@expo/vector-icons';
import { Children, isValidElement, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { colors, MIN_TOUCH, radius, spacing } from '../theme';
import { AppText } from './AppText';

/**
 * iOS 分組列表（Inset Grouped List）風格
 * Section：一組列表，可有標題與說明文字
 * Row：列表中的一列
 */

interface SectionProps {
  title?: string;
  footer?: string;
  children: ReactNode;
}

export function Section({ title, footer, children }: SectionProps) {
  const items = Children.toArray(children).filter(isValidElement);
  return (
    <View style={styles.section}>
      {title ? (
        <AppText variant="footnote" secondary style={styles.sectionTitle}>
          {title}
        </AppText>
      ) : null}
      <View style={styles.group}>
        {items.map((child, i) => (
          <View key={`item-${i}`}>
            {i > 0 ? <View style={styles.separator} /> : null}
            {child}
          </View>
        ))}
      </View>
      {footer ? (
        <AppText variant="footnote" secondary style={styles.sectionFooter}>
          {footer}
        </AppText>
      ) : null}
    </View>
  );
}

interface RowProps {
  title: string;
  subtitle?: string;
  value?: string;
  onPress?: () => void;
  showChevron?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  left?: ReactNode;
  right?: ReactNode;
}

export function Row({
  title,
  subtitle,
  value,
  onPress,
  showChevron,
  destructive,
  disabled,
  left,
  right,
}: RowProps) {
  const content = (
    <View style={[styles.row, disabled && { opacity: 0.45 }]}>
      {left}
      <View style={styles.rowText}>
        <AppText color={destructive ? colors.danger : undefined}>{title}</AppText>
        {subtitle ? (
          <AppText variant="footnote" secondary style={{ marginTop: 2 }}>
            {subtitle}
          </AppText>
        ) : null}
      </View>
      {value ? (
        <AppText secondary style={styles.value}>
          {value}
        </AppText>
      ) : null}
      {right}
      {showChevron ? (
        <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
      ) : null}
    </View>
  );

  if (!onPress || disabled) return content;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => pressed && { backgroundColor: colors.primarySoft }}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: spacing.xl },
  sectionTitle: { marginBottom: spacing.sm, marginLeft: spacing.lg },
  sectionFooter: { marginTop: spacing.sm, marginHorizontal: spacing.lg },
  group: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.separator,
    marginLeft: spacing.lg,
  },
  row: {
    minHeight: MIN_TOUCH + 6,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  rowText: { flex: 1 },
  value: { maxWidth: '50%', textAlign: 'right' },
});
