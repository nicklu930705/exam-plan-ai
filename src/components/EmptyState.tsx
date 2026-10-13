import { StyleSheet, View } from 'react-native';

import { spacing } from '../theme';
import { AppText } from './AppText';
import { Button } from './Button';

interface Props {
  title: string;
  message: string;
  actionTitle?: string;
  onAction?: () => void;
}

/** 空白狀態：清楚說明現況，並提供下一步 */
export function EmptyState({ title, message, actionTitle, onAction }: Props) {
  return (
    <View style={styles.wrap}>
      <AppText variant="title" align="center">
        {title}
      </AppText>
      <AppText secondary align="center" style={styles.message}>
        {message}
      </AppText>
      {actionTitle && onAction ? (
        <Button title={actionTitle} onPress={onAction} style={styles.button} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', paddingVertical: spacing.xxl, paddingHorizontal: spacing.lg },
  message: { marginTop: spacing.sm },
  button: { marginTop: spacing.xl, alignSelf: 'stretch' },
});
