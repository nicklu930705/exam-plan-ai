import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import type { StructuredAdvice } from '../services/aiAdviceService';
import type { AiQuotaStatus } from '../subscription/types';
import { colors, radius, shadow, spacing } from '../theme';
import { AppText } from './AppText';

interface Props {
  advice: StructuredAdvice;
  source: 'gemini_ai' | 'fallback_rule_engine';
  disclaimer?: string;
  note?: string;
  quotaStatus?: AiQuotaStatus;
  isLoading?: boolean;
  onRefresh?: () => void;
  onDismiss?: () => void;
}

export const AiAdviceCard: React.FC<Props> = ({
  advice,
  source,
  disclaimer,
  note,
  quotaStatus,
  isLoading = false,
  onRefresh,
  onDismiss,
}) => {
  const isGemini = source === 'gemini_ai';

  return (
    <View style={[styles.container, isGemini && styles.geminiContainer]}>
      {/* 標頭與來源標籤 */}
      <View style={styles.header}>
        <View style={[styles.badge, isGemini ? styles.geminiBadge : styles.localBadge]}>
          <Ionicons
            name={isGemini ? 'sparkles' : 'bulb-outline'}
            size={14}
            color={isGemini ? colors.primary : colors.textSecondary}
            style={{ marginRight: 4 }}
          />
          <AppText
            variant="caption"
            color={isGemini ? colors.primary : colors.textSecondary}
            style={{ fontWeight: '700' }}
          >
            {isGemini ? '✦ Google Gemini AI 深度建議' : '智慧讀書教練 (本機引擎)'}
          </AppText>
        </View>

        <View style={styles.headerActions}>
          {onRefresh ? (
            <Pressable
              onPress={onRefresh}
              disabled={isLoading}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="重新取得 AI 建議"
              style={({ pressed }) => [styles.actionIconBtn, pressed && { opacity: 0.6 }]}
            >
              {isLoading ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <Ionicons name="refresh" size={16} color={colors.primary} />
              )}
            </Pressable>
          ) : null}

          {onDismiss ? (
            <Pressable
              onPress={onDismiss}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="收合 AI 建議"
              style={({ pressed }) => [styles.actionIconBtn, pressed && { opacity: 0.6 }]}
            >
              <Ionicons name="close" size={16} color={colors.textSecondary} />
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* 總結核心重點 */}
      <AppText variant="headline" style={styles.summaryTitle}>
        學習策略總結
      </AppText>
      <AppText variant="subhead" secondary style={styles.summaryText}>
        {advice.summary}
      </AppText>

      {/* 建議重點突破科目 */}
      {advice.focusSubjects && advice.focusSubjects.length > 0 ? (
        <View style={styles.focusSection}>
          <AppText variant="footnote" secondary style={{ fontWeight: '600', marginBottom: 6 }}>
            建議優先突破科目：
          </AppText>
          <View style={styles.chipsRow}>
            {advice.focusSubjects.map((subject, idx) => (
              <View key={`${subject}-${idx}`} style={styles.chip}>
                <Ionicons name="flag-outline" size={12} color={colors.primary} />
                <AppText variant="caption" color={colors.primary} style={{ fontWeight: '600' }}>
                  {subject}
                </AppText>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {/* 具體行動方針 */}
      {advice.actionableTips && advice.actionableTips.length > 0 ? (
        <View style={styles.tipsSection}>
          <AppText variant="footnote" secondary style={{ fontWeight: '600', marginBottom: 6 }}>
            具體執行建議：
          </AppText>
          {advice.actionableTips.map((tip, idx) => (
            <View key={idx} style={styles.tipRow}>
              <View style={styles.bulletDot}>
                <Ionicons name="checkmark-circle" size={14} color={colors.primary} />
              </View>
              <AppText variant="footnote" style={styles.tipText}>
                {tip}
              </AppText>
            </View>
          ))}
        </View>
      ) : null}

      {/* 可行性評估 */}
      {advice.estimatedFeasibility ? (
        <View style={styles.feasibilityBox}>
          <View style={styles.feasibilityHeader}>
            <Ionicons name="speedometer-outline" size={14} color={colors.primary} />
            <AppText variant="caption" color={colors.primary} style={{ fontWeight: '600' }}>
              進度與可行性評估
            </AppText>
          </View>
          <AppText variant="footnote" secondary style={{ marginTop: 2, lineHeight: 18 }}>
            {advice.estimatedFeasibility}
          </AppText>
        </View>
      ) : null}

      {/* 附註與說明 */}
      {note ? (
        <View style={styles.noteBox}>
          <Ionicons name="information-circle-outline" size={13} color={colors.textSecondary} />
          <AppText variant="caption" secondary style={{ flex: 1 }}>
            {note}
          </AppText>
        </View>
      ) : null}

      {/* 配額與免責說明 */}
      <View style={styles.footer}>
        {quotaStatus && quotaStatus.limit > 0 ? (
          <AppText variant="caption" secondary style={styles.quotaText}>
            本月 AI 額度：剩餘 {quotaStatus.remaining} / {quotaStatus.limit} 次
          </AppText>
        ) : null}
        {disclaimer ? (
          <AppText variant="caption" secondary style={styles.disclaimerText}>
            {disclaimer}
          </AppText>
        ) : null}
      </View>
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
  geminiContainer: {
    borderColor: colors.primary,
    borderWidth: 1.2,
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
  geminiBadge: {
    backgroundColor: colors.primarySoft,
  },
  localBadge: {
    backgroundColor: colors.warningSoft,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  actionIconBtn: {
    padding: 2,
  },
  summaryTitle: {
    marginTop: 6,
    marginBottom: 4,
    fontWeight: '700',
  },
  summaryText: {
    lineHeight: 20,
    marginBottom: spacing.sm,
  },
  focusSection: {
    marginTop: 4,
    marginBottom: spacing.sm,
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.primarySoft,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  tipsSection: {
    marginBottom: spacing.sm,
  },
  tipRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginBottom: 4,
  },
  bulletDot: {
    marginTop: 2,
  },
  tipText: {
    flex: 1,
    lineHeight: 18,
  },
  feasibilityBox: {
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginTop: 2,
    marginBottom: spacing.xs,
  },
  feasibilityHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  noteBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
    padding: spacing.xs,
    borderRadius: radius.sm,
    backgroundColor: colors.background,
  },

  footer: {
    marginTop: spacing.xs,
    paddingTop: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
    gap: 2,
  },
  quotaText: {
    color: colors.primary,
    fontWeight: '500',
  },
  disclaimerText: {
    fontSize: 11,
    lineHeight: 14,
    opacity: 0.8,
  },
});
