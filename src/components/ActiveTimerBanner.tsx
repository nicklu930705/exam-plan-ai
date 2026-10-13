import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { useStudyTimer } from '../hooks/useStudyTimer';
import { colors, radius, shadow, spacing } from '../theme';
import { AppText } from './AppText';

export function ActiveTimerBanner() {
  const {
    activeTimer,
    formattedTime,
    isRunning,
    pauseTimer,
    resumeTimer,
    stopTimer,
    discardTimer,
  } = useStudyTimer();

  if (!activeTimer) return null;

  const handleStop = () => {
    Alert.alert('結束讀書計時？', `本次研讀時間：${formattedTime}\n是否要保存實際讀書時間並標記任務完成？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '僅記錄時間',
        onPress: () => stopTimer(activeTimer.taskId, false),
      },
      {
        text: '記錄並標記完成',
        style: 'default',
        onPress: () => stopTimer(activeTimer.taskId, true),
      },
    ]);
  };

  const handleDiscard = () => {
    Alert.alert('放棄本次計時？', '本次計時時間將不會被記錄。', [
      { text: '取消', style: 'cancel' },
      { text: '放棄計時', style: 'destructive', onPress: discardTimer },
    ]);
  };

  return (
    <View style={styles.container}>
      <Pressable
        onPress={() => router.push({ pathname: '/task/[id]', params: { id: activeTimer.taskId } })}
        style={({ pressed }) => [styles.banner, pressed && { opacity: 0.9 }]}
        accessibilityRole="button"
        accessibilityLabel={`開啟計時中的任務：${activeTimer.taskTitle}`}
      >
        <View style={styles.left}>
          <View style={[styles.pulseDot, isRunning ? styles.dotActive : styles.dotPaused]}>
            <Ionicons
              name={isRunning ? 'time' : 'pause'}
              size={18}
              color={isRunning ? colors.primary : colors.warning}
            />
          </View>
          <View style={{ flex: 1 }}>
            <AppText variant="caption" color={colors.primary} style={{ fontWeight: '600' }}>
              {isRunning ? '正在專注讀書' : '計時已暫停'} · {activeTimer.subjectName ?? ''}
            </AppText>
            <AppText numberOfLines={1} style={{ fontWeight: '600', marginTop: 1 }}>
              {activeTimer.taskTitle}
            </AppText>
          </View>
        </View>

        <View style={styles.right}>
          <AppText variant="headline" color={colors.primary} style={styles.timerText}>
            {formattedTime}
          </AppText>

          <View style={styles.actions}>
            <Pressable
              hitSlop={8}
              onPress={isRunning ? pauseTimer : resumeTimer}
              style={styles.actionBtn}
              accessibilityRole="button"
              accessibilityLabel={isRunning ? '暫停計時' : '繼續計時'}
            >
              <Ionicons
                name={isRunning ? 'pause-circle' : 'play-circle'}
                size={26}
                color={colors.primary}
              />
            </Pressable>

            <Pressable
              hitSlop={8}
              onPress={handleStop}
              style={styles.actionBtn}
              accessibilityRole="button"
              accessibilityLabel="結束計時並保存"
            >
              <Ionicons name="checkmark-circle" size={26} color={colors.primary} />
            </Pressable>

            <Pressable
              hitSlop={8}
              onPress={handleDiscard}
              style={styles.actionBtn}
              accessibilityRole="button"
              accessibilityLabel="放棄計時"
            >
              <Ionicons name="close-circle-outline" size={24} color={colors.textSecondary} />
            </Pressable>
          </View>
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    borderWidth: 1.5,
    borderColor: colors.primary,
    ...shadow.sm,
  },
  left: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginRight: spacing.sm,
  },
  pulseDot: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotActive: {
    backgroundColor: colors.primarySoft,
  },
  dotPaused: {
    backgroundColor: colors.warningSoft,
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  timerText: {
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.5,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  actionBtn: {
    padding: 2,
  },
});
