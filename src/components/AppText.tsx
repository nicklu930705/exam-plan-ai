import { Text, type TextProps, type TextStyle } from 'react-native';

import { colors, typography } from '../theme';

type Variant = keyof typeof typography;

interface Props extends TextProps {
  variant?: Variant;
  color?: string;
  secondary?: boolean;
  align?: TextStyle['textAlign'];
}

/** 統一字級與顏色的文字元件 */
export function AppText({ variant = 'body', color, secondary, align, style, ...rest }: Props) {
  return (
    <Text
      {...rest}
      style={[
        typography[variant],
        { color: color ?? (secondary ? colors.textSecondary : colors.text), textAlign: align },
        style,
      ]}
    />
  );
}
