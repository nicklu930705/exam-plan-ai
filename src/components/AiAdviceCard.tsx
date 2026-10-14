import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import type { AiAdviceStatus, StructuredAdvice } from '../services/aiAdviceService';
import type { AiQuotaStatus } from '../subscription/types';
import { colors, radius, shadow, spacing } from '../theme';
import { AppText } from './AppText';

interface Props {
  advice?: StructuredAdvice | null;
  source?: 'openai_ai' | 'gemini_ai' | 'fallback_rule_engine';
  disclaimer?: string;
  note?: string;
  quotaStatus?: AiQuotaStatus;
  status?: AiAdviceStatus;
  isLoading?: boolean;
  error?: string | null;
  errorCode?: string;
  examName?: string;
  onRefresh?: () => void;
  onRetry?: () => void;
  onDismiss?: () => void;
}

export const AiAdviceCard: React.FC<Props> = ({
  advice,
  source = 'openai_ai',
  disclaimer,
  note,
  quotaStatus,
  status,
  isLoading = false,
  error,
  errorCode,
  examName,
  onRefresh,
  onRetry,
  onDismiss,
}) => {
  const isAi = source === 'gemini_ai' || source === 'openai_ai';
  const isGemini = isAi;
  // 嚴格載入判定：以外部 isLoading 為主；若已結束載入，絕不因 status 殘留而持續轉圈
  const isBusy = Boolean(isLoading);
  const isErrorState =
    !isBusy &&
    (Boolean(error) ||
      (status !== undefined && status !== 'idle' && status !== 'loading' && status !== 'success') ||
      (!advice && Boolean(status) && status !== 'idle'));

  // ───── 1. 載入中狀態 (Loading State) ─────
  if (isBusy) {
    return (
      <View style={[styles.container, styles.geminiContainer, styles.loadingContainer]}>
        <View style={styles.header}>
          <View style={[styles.badge, styles.geminiBadge]}>
            <Ionicons name="sparkles" size={14} color={colors.primary} style={{ marginRight: 4 }} />
            <AppText variant="caption" color={colors.primary} style={{ fontWeight: '700' }}>
              {source === 'openai_ai' ? '✦ OpenAI GPT 深度分析中' : '✦ AI 智慧教練深度分析中'}
            </AppText>
          </View>
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

        <View style={styles.loadingBody}>
          <ActivityIndicator size="large" color={colors.primary} style={{ marginBottom: spacing.md }} />
          <AppText variant="headline" style={styles.loadingTitle}>
            正在為您分析{examName ? `「${examName}」` : '備考'}策略...
          </AppText>
          <AppText variant="footnote" secondary style={styles.loadingSubtext}>
            依據您的各科目掌握度、落後章節與每日可用時間，由 AI 官方模型即時生成突破重點與讀書建言。
          </AppText>
        </View>
      </View>
    );
  }

  // ───── 2. 失敗 / 錯誤 / 網路中斷狀態 (Error State) ─────
  if (isErrorState) {
    let errorBadgeText = 'AI 建議生成未完成';
    let errorIcon: keyof typeof Ionicons.glyphMap = 'alert-circle-outline';
    let errorTitle = '暫時無法取得 AI 建議';

    if (status === 'network_error' || errorCode === 'NETWORK_ERROR') {
      errorBadgeText = '網路連線異常';
      errorIcon = 'cloud-offline-outline';
      errorTitle = '無法連線至 AI 伺服器';
    } else if (status === 'quota_exceeded' || errorCode === 'QUOTA_EXCEEDED' || errorCode === 'RATE_LIMIT_EXCEEDED') {
      errorBadgeText = '請求頻率上限';
      errorIcon = 'speedometer-outline';
      errorTitle = 'API 呼叫過於頻繁';
    } else if (status === 'timeout' || errorCode === 'TIMEOUT' || errorCode === 'GATEWAY_TIMEOUT') {
      errorBadgeText = '連線回應逾時';
      errorIcon = 'time-outline';
      errorTitle = 'AI 伺服器處理逾時';
    } else if (errorCode === 'SERVICE_UNAVAILABLE') {
      errorBadgeText = '伺服器繁忙';
      errorIcon = 'cloud-offline-outline';
      errorTitle = 'AI 模型忙碌中';
    }

    return (
      <View style={[styles.container, styles.errorContainer]}>
        <View style={styles.header}>
          <View style={[styles.badge, styles.errorBadge]}>
            <Ionicons name={errorIcon} size={14} color={colors.danger} style={{ marginRight: 4 }} />
            <AppText variant="caption" color={colors.danger} style={{ fontWeight: '700' }}>
              {errorBadgeText}
            </AppText>
          </View>
          {onDismiss ? (
            <Pressable
              onPress={onDismiss}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="收合錯誤提示"
              style={({ pressed }) => [styles.actionIconBtn, pressed && { opacity: 0.6 }]}
            >
              <Ionicons name="close" size={16} color={colors.textSecondary} />
            </Pressable>
          ) : null}
        </View>

        <AppText variant="headline" style={styles.errorTitle}>
          {errorTitle}
        </AppText>
        <AppText variant="subhead" secondary style={styles.errorText}>
          {error || '伺服器未能在時限內回應，請確認網路環境或稍後重新嘗試。'}
        </AppText>

        <View style={styles.errorActionsRow}>
          {onRetry || onRefresh ? (
            <Pressable
              onPress={onRetry || onRefresh}
              accessibilityRole="button"
              accessibilityLabel="重新嘗試呼叫 AI"
              style={({ pressed }) => [styles.retryBtn, pressed && { opacity: 0.8 }]}
            >
              <Ionicons name="refresh" size={14} color={colors.onPrimary} />
              <AppText variant="footnote" color={colors.onPrimary} style={{ fontWeight: '600' }}>
                重新嘗試
              </AppText>
            </Pressable>
          ) : null}

          {onDismiss ? (
            <Pressable
              onPress={onDismiss}
              accessibilityRole="button"
              accessibilityLabel="稍後再試"
              style={({ pressed }) => [styles.dismissBtn, pressed && { opacity: 0.6 }]}
            >
              <AppText variant="footnote" secondary style={{ fontWeight: '500' }}>
                稍後再試
              </AppText>
            </Pressable>
          ) : null}
        </View>

        {disclaimer ? (
          <View style={styles.footer}>
            <AppText variant="caption" secondary style={styles.disclaimerText}>
              {disclaimer}
            </AppText>
          </View>
        ) : null}
      </View>
    );
  }

  // ───── 3. 正常成功顯示狀態 (Success State) ─────
  if (!advice) {
    return null;
  }

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
            {source === 'openai_ai'
              ? '✦ OpenAI GPT 深度建議'
              : source === 'gemini_ai'
                ? '✦ Google Gemini AI 深度建議'
                : '智慧讀書教練 (本機引擎)'}
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
              <Ionicons name="refresh" size={16} color={colors.primary} />
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
  loadingContainer: {
    paddingVertical: spacing.lg,
  },
  loadingBody: {
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
  },
  loadingTitle: {
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 6,
  },
  loadingSubtext: {
    textAlign: 'center',
    lineHeight: 18,
  },
  errorContainer: {
    borderColor: '#E8C5C0',
    backgroundColor: '#FCF8F8',
  },
  errorBadge: {
    backgroundColor: '#F7E7E5',
  },
  errorTitle: {
    marginTop: 6,
    marginBottom: 4,
    color: colors.text,
    fontWeight: '700',
  },
  errorText: {
    lineHeight: 20,
    marginBottom: spacing.md,
    color: colors.textSecondary,
  },
  errorActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
  dismissBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
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
