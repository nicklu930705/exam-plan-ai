import { type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native';

import { colors, radius } from '../theme';

interface Props {
  /** 0 ~ 1 */
  value: number;
  height?: number;
  color?: string;
  style?: StyleProp<ViewStyle>;
}

/** 簡潔的細長進度條 */
export function ProgressBar({ value, height = 6, color = colors.primary, style }: Props) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(pct) }}
      style={[styles.track, { height }, style]}
    >
      <View style={[styles.fill, { width: `${pct}%`, backgroundColor: color }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    width: '100%',
    backgroundColor: colors.primarySoft,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: radius.pill },
});
