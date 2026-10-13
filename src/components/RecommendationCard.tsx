import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { StudyRecommendation } from '../scheduler/recommendations';
import { colors, radius, shadow, spacing } from '../theme';
import { AppText } from './AppText';

interface Props {
  recommendation: StudyRecommendation;
  onAction?: () => void;
  onDismiss?: () => void;
}

export const RecommendationCard: React.FC<Props> = ({
  recommendation,
  onAction,
  onDismiss,
}) => {
  const isWarning = recommendation.severity === 'warning';
  const isSuccess = recommendation.severity === 'success';

  const badgeBg = isWarning
    ? colors.warningSoft
    : isSuccess
      ? colors.primarySoft
      : colors.primarySoft;

  const badgeColor = isWarning
    ? colors.warning
    : isSuccess
      ? colors.primary
      : colors.primary;

  const iconName: keyof typeof Ionicons.glyphMap = isWarning
    ? 'alert-circle-outline'
    : isSuccess
      ? 'checkmark-circle-outline'
      : recommendation.type === 'rest_day'
        ? 'cafe-outline'
        : 'bulb-outline';

  return (
    <View style={[styles.container, isWarning && styles.warningBorder]}>
      <View style={styles.header}>
        <View style={[styles.badge, { backgroundColor: badgeBg }]}>
          <Ionicons name={iconName} size={14} color={badgeColor} style={{ marginRight: 4 }} />
          <AppText variant="caption" color={badgeColor} style={{ fontWeight: '600' }}>
            {isWarning ? '排程建議' : isSuccess ? '達標反思' : '今日學習建議'}
          </AppText>
        </View>

        {onDismiss ? (
          <Pressable
            onPress={onDismiss}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="忽略此建議"
            style={({ pressed }) => [styles.dismissBtn, pressed && { opacity: 0.6 }]}
          >
            <Ionicons name="close" size={16} color={colors.textSecondary} />
          </Pressable>
        ) : null}
      </View>

      <AppText variant="headline" style={styles.title}>
        {recommendation.title}
      </AppText>

      <AppText variant="subhead" secondary style={styles.description}>
        {recommendation.description}
      </AppText>

      {/* 客觀理由解釋區塊 */}
      <View style={styles.reasonBox}>
        <View style={styles.reasonHeader}>
          <Ionicons name="information-circle-outline" size={13} color={colors.primary} />
          <AppText variant="caption" color={colors.primary} style={{ fontWeight: '600' }}>
            推薦理由說明
          </AppText>
        </View>
        <AppText variant="footnote" secondary style={{ marginTop: 2, lineHeight: 18 }}>
          {recommendation.reason}
        </AppText>
      </View>

      {recommendation.actionTitle && onAction ? (
        <View style={styles.actionRow}>
          <Pressable
            onPress={onAction}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.actionButton,
              isWarning ? styles.actionBtnWarning : styles.actionBtnPrimary,
              pressed && { opacity: 0.8 },
            ]}
          >
            <AppText
              variant="subhead"
              color={colors.onPrimary}
              style={{ fontWeight: '600' }}
            >
              {recommendation.actionTitle}
            </AppText>
            <Ionicons name="arrow-forward" size={14} color={colors.onPrimary} />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.separator,
    ...shadow.sm,
  },
  warningBorder: {
    borderColor: colors.warning,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  dismissBtn: {
    padding: 2,
  },
  title: {
    marginTop: 4,
    marginBottom: 4,
    fontWeight: '600',
  },
  description: {
    lineHeight: 20,
    marginBottom: spacing.sm,
  },
  reasonBox: {
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginTop: 2,
    marginBottom: spacing.xs,
  },
  reasonHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  actionRow: {
    marginTop: spacing.sm,
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
  },
  actionBtnPrimary: {
    backgroundColor: colors.primary,
  },
  actionBtnWarning: {
    backgroundColor: colors.warning,
  },
});
