import { ActivityIndicator, Pressable, StyleSheet, type ViewStyle } from 'react-native';

import { colors, MIN_TOUCH, radius, spacing, typography } from '../theme';
import { AppText } from './AppText';

type Variant = 'primary' | 'secondary' | 'plain' | 'destructive';

interface Props {
  title: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
  accessibilityHint?: string;
}

/**
 * 按鈕
 * - primary：每個畫面唯一的主要操作（鼠尾草綠實心）
 * - secondary：淺綠底的次要操作
 * - plain：純文字按鈕
 * - destructive：刪除、清除等破壞性操作
 */
export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  style,
  accessibilityHint,
}: Props) {
  const isDisabled = disabled || loading;
  const textColor =
    variant === 'primary'
      ? colors.onPrimary
      : variant === 'destructive'
        ? colors.danger
        : colors.primary;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!isDisabled }}
      accessibilityHint={accessibilityHint}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        variant === 'primary' && styles.primary,
        variant === 'secondary' && styles.secondary,
        variant === 'destructive' && styles.secondary,
        variant === 'plain' && styles.plain,
        pressed && { opacity: 0.7 },
        isDisabled && { opacity: 0.4 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={textColor} />
      ) : (
        <AppText style={[typography.headline, { color: textColor }]}>{title}</AppText>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 50,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  primary: { backgroundColor: colors.primary },
  secondary: { backgroundColor: colors.primarySoft },
  plain: { minHeight: MIN_TOUCH, backgroundColor: 'transparent' },
});
