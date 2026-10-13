import { Ionicons } from '@expo/vector-icons';
import { useRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { colors, MIN_TOUCH, radius, spacing } from '../theme';
import type { StudyTask } from '../types/models';
import { formatMinutes } from '../utils/date';
import { AppText } from './AppText';

interface Props {
  task: StudyTask;
  examName?: string;
  subjectName?: string;
  chapterTitle?: string;
  onToggle: () => void;
  onPress: () => void;
  onStartTimer?: () => void;
  isTiming?: boolean;
  timingFormatted?: string;
  /** 日期已過但未完成時顯示提醒 */
  overdue?: boolean;
  /** 智慧推薦標籤（如：弱項衝刺、倒數推薦） */
  priorityLabel?: string;
  /** 智慧推薦理由說明 */
  priorityReason?: string;
}

/**
 * 任務列
 * 點左邊圓圈：切換完成／未完成
 * 點計時圖示：開始讀書計時
 * 點其他區域：開啟任務詳情
 */
export function TaskRow({
  task,
  examName,
  subjectName,
  chapterTitle,
  onToggle,
  onPress,
  onStartTimer,
  isTiming,
  timingFormatted,
  overdue,
  priorityLabel,
  priorityReason,
}: Props) {
  const done = task.status === 'done';
  const flagged = task.status === 'needsReschedule';
  const lastToggleRef = useRef<number>(0);

  const handleToggle = () => {
    const now = Date.now();
    if (now - lastToggleRef.current < 250) return;
    lastToggleRef.current = now;
    onToggle();
  };

  const metaParts = [
    examName,
    subjectName,
    chapterTitle,
    `預計 ${formatMinutes(task.estimatedMinutes)}`,
    task.actualMinutes && task.actualMinutes > 0
      ? `實讀 ${formatMinutes(task.actualMinutes)}`
      : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <View style={styles.row}>
      <Pressable
        onPress={handleToggle}
        hitSlop={8}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: done }}
        accessibilityLabel={done ? `將「${task.title}」恢復為未完成` : `將「${task.title}」標記完成`}
        style={styles.check}
      >
        <Ionicons
          name={done ? 'checkmark-circle' : 'ellipse-outline'}
          size={26}
          color={done ? colors.primary : colors.textSecondary}
        />
      </Pressable>

      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityHint="開啟任務詳情"
        style={({ pressed }) => [styles.body, pressed && { opacity: 0.6 }]}
      >
        <View style={{ flex: 1 }}>
          <View style={styles.titleRow}>
            <AppText
              color={done ? colors.textSecondary : colors.text}
              style={[styles.title, done && styles.doneText]}
              numberOfLines={2}
            >
              {task.title}
            </AppText>
            {isTiming ? (
              <View style={styles.timingBadge}>
                <Ionicons name="time" size={12} color={colors.primary} />
                <AppText variant="caption" color={colors.primary} style={{ fontWeight: '600' }}>
                  {timingFormatted ?? '計時中'}
                </AppText>
              </View>
            ) : null}
          </View>

          <AppText variant="footnote" secondary style={{ marginTop: 2 }} numberOfLines={1}>
            {metaParts}
          </AppText>

          {priorityLabel && !done ? (
            <View style={styles.priorityRow}>
              <View style={styles.priorityBadge}>
                <Ionicons name="sparkles" size={11} color={colors.primary} />
                <AppText variant="caption" color={colors.primary} style={{ fontWeight: '600' }}>
                  {priorityLabel}
                </AppText>
              </View>
              {priorityReason ? (
                <AppText
                  variant="caption"
                  color={colors.textSecondary}
                  style={{ flex: 1 }}
                  numberOfLines={1}
                >
                  · {priorityReason}
                </AppText>
              ) : null}
            </View>
          ) : null}

          {flagged || (overdue && !done) ? (
            <AppText variant="footnote" color={colors.warning} style={{ marginTop: 2 }}>
              {flagged ? '已標記需要重新安排' : '已過預定日期'}
            </AppText>
          ) : null}
        </View>

        {/* 快速開始計時按鈕（未完成且尚未計時該任務時提供） */}
        {!done && onStartTimer && !isTiming ? (
          <Pressable
            hitSlop={8}
            onPress={(e) => {
              e.stopPropagation();
              onStartTimer();
            }}
            accessibilityRole="button"
            accessibilityLabel={`開始研讀「${task.title}」計時`}
            style={styles.timerBtn}
          >
            <Ionicons name="play" size={15} color={colors.primary} />
            <AppText variant="caption" color={colors.primary} style={{ fontWeight: '600' }}>
              計時
            </AppText>
          </Pressable>
        ) : null}

        <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingRight: spacing.md },
  check: {
    width: MIN_TOUCH + spacing.sm,
    minHeight: MIN_TOUCH + 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: spacing.sm,
  },
  body: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexWrap: 'wrap',
  },
  title: {
    fontWeight: '500',
  },
  doneText: {
    textDecorationLine: 'line-through',
  },
  timingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.primarySoft,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  timerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: colors.primarySoft,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  priorityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: 4,
  },
  priorityBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: colors.primarySoft,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
});
