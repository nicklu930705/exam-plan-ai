import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import type { AiAdviceStatus, QuotaInfo, StructuredAdvice } from '../services/aiAdviceService';
import type { AiQuotaStatus, PlanTier } from '../subscription/types';
import { colors, radius, shadow, spacing } from '../theme';
import { AppText } from './AppText';

interface Props {
  advice?: StructuredAdvice | null;
  source?: 'openai_ai' | 'gemini_ai' | 'fallback_rule_engine';
  disclaimer?: string;
  note?: string;
  tier?: PlanTier;
  quotaStatus?: AiQuotaStatus;
  quota?: QuotaInfo;
  status?: AiAdviceStatus;
  isLoading?: boolean;
  error?: string | null;
  errorCode?: string;
  examName?: string;
  generatedAt?: string | null;
  isOutdatedProgress?: boolean;
  isQuotaStale?: boolean;
  isHistorical?: boolean;
  isQuotaSyncing?: boolean;
  isQuotaFetchFailed?: boolean;
  onRefresh?: () => void;
  onRetry?: () => void;
  onDismiss?: () => void;
}

export const AiAdviceCard: React.FC<Props> = ({
  advice,
  source = 'openai_ai',
  disclaimer,
  note,
  tier,
  quotaStatus,
  quota,
  status,
  isLoading = false,
  error,
  errorCode,
  examName,
  generatedAt,
  isOutdatedProgress = false,
  isQuotaStale = false,
  isHistorical = false,
  isQuotaSyncing = false,
  isQuotaFetchFailed = false,
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

  const formattedGeneratedTime = React.useMemo(() => {
    if (!generatedAt) return null;
    try {
      const d = new Date(generatedAt);
      if (isNaN(d.getTime())) return null;
      const hours = String(d.getHours()).padStart(2, '0');
      const mins = String(d.getMinutes()).padStart(2, '0');
      const now = new Date();
      const isToday =
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();
      if (isToday) {
        return `今日 ${hours}:${mins}`;
      }
      const month = d.getMonth() + 1;
      const date = d.getDate();
      return `${month}月${date}日 ${hours}:${mins}`;
    } catch {
      return null;
    }
  }, [generatedAt]);

  // ───── 1. 載入中狀態 (Loading State) ─────
  if (isBusy) {
    return (
      <View style={[styles.container, styles.geminiContainer, styles.loadingContainer]}>
        <View style={styles.header}>
          <View style={[styles.badge, styles.geminiBadge]}>
            <Ionicons name="sparkles" size={14} color={colors.primary} style={{ marginRight: 4 }} />
            <AppText variant="caption" color={colors.primary} style={{ fontWeight: '700' }}>
              ✦ AI 讀書教練深度分析中
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
    } else if (
      status === 'quota_exceeded' ||
      errorCode === 'QUOTA_EXCEEDED' ||
      errorCode === 'DAILY_QUOTA_EXCEEDED' ||
      errorCode === 'RATE_LIMIT_EXCEEDED' ||
      errorCode === 'CONCURRENT_REQUEST' ||
      errorCode === 'DAILY_BUDGET_EXCEEDED' ||
      errorCode === 'MONTHLY_BUDGET_EXCEEDED'
    ) {
      if (errorCode === 'CONCURRENT_REQUEST') {
        errorBadgeText = '處理中請稍候';
        errorIcon = 'sync-outline';
        errorTitle = '已有進行中的請求';
      } else if (errorCode === 'RATE_LIMIT_EXCEEDED') {
        errorBadgeText = '頻率限制 (每分3次)';
        errorIcon = 'speedometer-outline';
        errorTitle = '呼叫過於頻繁';
      } else if (errorCode === 'DAILY_BUDGET_EXCEEDED' || errorCode === 'MONTHLY_BUDGET_EXCEEDED') {
        errorBadgeText = '系統額度已滿';
        errorIcon = 'alert-circle-outline';
        errorTitle = '伺服端總預算上限';
      } else {
        errorBadgeText = '今日額度已達上限';
        errorIcon = 'calendar-outline';
        errorTitle = '今日 AI 次數已用完';
      }
    } else if (status === 'timeout' || errorCode === 'TIMEOUT' || errorCode === 'GATEWAY_TIMEOUT') {
      errorBadgeText = '連線回應逾時';
      errorIcon = 'time-outline';
      errorTitle = 'AI 伺服器處理逾時';
    } else if (errorCode === 'SERVICE_UNAVAILABLE' || errorCode === 'STORAGE_UNAVAILABLE') {
      errorBadgeText = '服務暫時維護中';
      errorIcon = 'cloud-offline-outline';
      errorTitle = '資料庫或服務暫停';
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
            {isAi
              ? isHistorical
                ? '✦ 歷史 AI 讀書建議'
                : '✦ AI 讀書教練深度建議'
              : '智慧讀書教練 (本機引擎)'}
          </AppText>
          {formattedGeneratedTime ? (
            <AppText variant="caption" secondary style={styles.generatedTimeBadge}>
              · {isHistorical ? (tier === 'free' ? `前次分析（原始分析時間：${formattedGeneratedTime}）` : `前次分析：${formattedGeneratedTime}`) : formattedGeneratedTime}
            </AppText>
          ) : null}
        </View>

        <View style={styles.headerActions}>
          {onRefresh ? (
            <Pressable
              onPress={onRefresh}
              disabled={isLoading}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="重新取得 AI 建議（將消耗 1 次本日配額）"
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

      {/* 歷史建議或進度已變更提示 */}
      {isHistorical ? (
        <View style={styles.historicalNoticeBox}>
          <Ionicons name="time-outline" size={14} color={colors.primary} />
          <AppText variant="caption" color={colors.primary} style={{ flex: 1, fontWeight: '600', lineHeight: 16 }}>
            {tier === 'free'
              ? isOutdatedProgress
                ? `此為歷史建議（進度已有更新${formattedGeneratedTime ? `，原始分析時間：${formattedGeneratedTime}` : ''}）· 目前會員為免費版，舊內容可免費閱讀，重新產生新分析遵守目前免費版會員權益`
                : `此為歷史 AI 建議${formattedGeneratedTime ? `（原始分析時間：${formattedGeneratedTime}）` : ''} · 目前會員為免費版，舊內容可免費閱讀，重新產生新分析遵守目前免費版會員權益`
              : isOutdatedProgress
                ? '此為前次分析建議（已跨日且進度已有更新）· 可免費閱讀，點擊右上角可消耗 1 次本日配額重新產生今日分析'
                : '此為前次分析建議（已跨日）· 可免費閱讀，若需今日最新分析可點擊右上角重新整理（將消耗 1 次本日配額）'}
          </AppText>
        </View>
      ) : isOutdatedProgress ? (
        <View style={styles.outdatedNoticeBox}>
          <Ionicons name="information-circle-outline" size={14} color={colors.warning} />
          <AppText variant="caption" color={colors.warning} style={{ flex: 1, fontWeight: '600', lineHeight: 16 }}>
            今日進度已有新更新 · 可點擊右上角重新整理以產生最新分析（將消耗 1 次配額）
          </AppText>
        </View>
      ) : null}

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
        {/* 1. 歷史建議免責／免費閱讀提示（當為 Free 且為歷史建議時必定顯示） */}
        {isHistorical && tier === 'free' ? (
          <View style={styles.historicalNoticeBox}>
            <Ionicons name="information-circle-outline" size={12} color={colors.primary} />
            <AppText variant="caption" color={colors.primary} style={styles.quotaHighlightText}>
              免費版 · 舊內容可免費閱讀（新分析遵守目前免費版會員權益）
            </AppText>
          </View>
        ) : null}

        {/* 2. 當前額度狀態行 */}
        {(() => {
          const resolvedTier = tier || (quota?.tier as PlanTier | undefined);
          let tierPrefix = '今日 AI 使用額度 · ';
          if (resolvedTier === 'lifetime') {
            tierPrefix = '✦ 終身版會員 · ';
          } else if (resolvedTier === 'pro') {
            tierPrefix = '✦ Pro 會員 · ';
          } else if (resolvedTier === 'free') {
            tierPrefix = '免費版 · ';
          }

          // A. 查詢中狀態
          if (isQuotaSyncing) {
            return (
              <View style={styles.quotaRow}>
                <Ionicons name="sync-outline" size={12} color={colors.textSecondary} />
                <AppText variant="caption" color={colors.textSecondary} style={styles.quotaHighlightText}>
                  {`${tierPrefix}額度同步中…`}
                </AppText>
              </View>
            );
          }

          // B. 查詢失敗且無有效同日快取
          if (isQuotaFetchFailed) {
            return (
              <View style={styles.quotaRow}>
                <Ionicons name="alert-circle-outline" size={12} color={colors.textSecondary} />
                <AppText variant="caption" color={colors.textSecondary} style={styles.quotaHighlightText}>
                  {`${tierPrefix}目前無法取得額度`}
                </AppText>
              </View>
            );
          }

          // C. 具有額度（查詢成功 或 離線同日快取）
          if (quota || quotaStatus) {
            const usedCount = quota?.usedToday ?? quotaStatus?.used ?? 0;
            const limitCount = quota?.dailyLimit ?? quotaStatus?.limit ?? 0;
            const remainingCount = quota?.remainingToday ?? quotaStatus?.remaining ?? 0;

            if (isQuotaStale) {
              return (
                <View style={styles.quotaRow}>
                  <Ionicons name="cloud-offline-outline" size={12} color={colors.textSecondary} />
                  <AppText variant="caption" color={colors.textSecondary} style={styles.quotaHighlightText}>
                    {`${tierPrefix}上次同步 ${usedCount}/${limitCount} 次（剩餘 ${remainingCount} 次）`}
                  </AppText>
                </View>
              );
            }

            return (
              <View style={styles.quotaRow}>
                <Ionicons name="sparkles" size={12} color={colors.primary} />
                <AppText variant="caption" color={colors.primary} style={styles.quotaHighlightText}>
                  {`${tierPrefix}今日已用 ${usedCount}/${limitCount} 次（剩餘 ${remainingCount} 次 · 每日 00:00 重設）`}
                </AppText>
              </View>
            );
          }

          // D. 本機排程分析引擎（無 quota 物件且非 AI）
          if (!isAi) {
            return (
              <AppText variant="caption" secondary style={styles.quotaText}>
                本機排程分析引擎（不消耗雲端每日 AI 額度）
              </AppText>
            );
          }

          return null;
        })()}

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
  generatedTimeBadge: {
    marginLeft: 4,
    fontWeight: '500',
    fontSize: 11,
  },
  outdatedNoticeBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    backgroundColor: colors.warningSoft,
  },
  historicalNoticeBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    backgroundColor: colors.primarySoft,
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
  quotaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 2,
  },
  quotaHighlightText: {
    fontWeight: '600',
    fontSize: 12,
  },
  disclaimerText: {
    fontSize: 11,
    lineHeight: 14,
    opacity: 0.8,
  },
});
