import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { AppText } from '../components/AppText';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { Row, Section } from '../components/List';
import { Screen } from '../components/Screen';
import { useToday } from '../hooks/useToday';
import { calculateReschedulePlan } from '../scheduler/reschedule';
import { useAppStore } from '../store/AppStore';
import {
  getBehindTasks,
  getExamById,
  getSubject,
  getUpcomingExam,
  tasksForExam,
} from '../store/selectors';
import { canUseSmartReschedule } from '../subscription/entitlements';
import { colors, radius, spacing } from '../theme';
import { formatFullDate, formatMinutes, formatMonthDay, formatYearMonthDay } from '../utils/date';

export default function RescheduleScreen() {
  const { data, applyRescheduledTasks, setSelectedExamId } = useAppStore();
  const today = useToday();
  const params = useLocalSearchParams<{ examId?: string }>();

  // 支援多場考試切換
  const [localExamId, setLocalExamId] = useState<string | undefined>(params.examId);
  // 重新排程起始點選項：false 為今日起，true 為明日起
  const [startFromTomorrow, setStartFromTomorrow] = useState<boolean>(false);

  const examWithTasks = data.exams.find((e) => tasksForExam(data.tasks, e.id).length > 0);
  const activeExamId =
    localExamId ??
    params.examId ??
    data.selectedExamId ??
    examWithTasks?.id ??
    getUpcomingExam(data, today)?.id ??
    data.exams[0]?.id;

  const exam = getExamById(data, activeExamId) ?? examWithTasks ?? data.exams[0];

  const examTasks = useMemo(() => {
    if (!exam) return [];
    return tasksForExam(data.tasks, exam.id);
  }, [data.tasks, exam]);

  // 偵測預定日期已過且未完成（落後）的任務
  const behindTasks = useMemo(() => {
    if (!exam) return [];
    return getBehindTasks(examTasks, today);
  }, [examTasks, today, exam]);

  // 計算重新排程試算與差異預覽（整合個人化智慧優先序與起點選項）
  const plan = useMemo(() => {
    if (!exam) return null;
    return calculateReschedulePlan(examTasks, exam.examDate, data.preferences, today, {
      startFromTomorrow,
      exam,
      allExams: data.exams,
    });
  }, [examTasks, exam, data.preferences, today, startFromTomorrow, data.exams]);

  if (!exam || !plan) {
    return (
      <Screen bottomInset>
        <EmptyState
          title="沒有進行中的考試"
          message="建立考試並產生任務後，才能使用重新排程功能。"
          actionTitle="建立考試"
          onAction={() => router.push('/exam/new')}
        />
      </Screen>
    );
  }

  const hasChanges = plan.changedTasks.length > 0;
  const isNoOverdue = behindTasks.length === 0;
  const smartCheck = canUseSmartReschedule(data.subscription);

  const handleApply = () => {
    if (!smartCheck.allowed) {
      Alert.alert('升級 Pro 解鎖智慧重新排程', smartCheck.reason, [
        { text: '稍後再說', style: 'cancel' },
        { text: '查看會員方案', onPress: () => router.push('/subscription') },
      ]);
      return;
    }

    if (!hasChanges) {
      Alert.alert('目前無須調整', '所有尚未完成的任務日期皆符合當前讀書時間規範，無須變動。', [
        { text: '返回', onPress: () => router.back() },
      ]);
      return;
    }

    const unassignedNotice =
      plan.unassignedTasks.length > 0
        ? `\n\n注意：有 ${plan.unassignedTasks.length} 項任務超出每日時間上限未排入，這些任務已完整保留在計畫中，絕不會被刪除。`
        : '';

    Alert.alert(
      '確認套用新排程？',
      `共調整 ${plan.changedTasks.length} 項任務的新日期。\n所有已完成的任務將完整保留原狀。${unassignedNotice}`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '確認套用',
          onPress: () => {
            applyRescheduledTasks(exam.id, plan.updatedTasks);
            if (router.canDismiss()) {
              router.dismiss();
            } else if (router.canGoBack()) {
              router.back();
            }
            router.navigate({ pathname: '/(tabs)/plan', params: { examId: exam.id } });
          },
        },
      ],
    );
  };

  return (
    <Screen
      bottomInset
      footer={
        <Button
          title={
            hasChanges
              ? `確認套用新排程（調整 ${plan.changedTasks.length} 項）`
              : '目前排程符合規範'
          }
          disabled={!hasChanges}
          onPress={handleApply}
        />
      }
    >
      {/* 考試切換 Tabs（若有多場考試） */}
      {data.exams.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.examTabs}
        >
          {data.exams.map((e) => {
            const isSelected = e.id === exam.id;
            return (
              <Pressable
                key={e.id}
                onPress={() => {
                  setLocalExamId(e.id);
                  setSelectedExamId(e.id);
                }}
                style={[styles.examChip, isSelected && styles.examChipSelected]}
                accessibilityRole="button"
              >
                <AppText
                  variant="footnote"
                  color={isSelected ? colors.onPrimary : colors.text}
                  style={isSelected && { fontWeight: '600' }}
                >
                  {e.name}
                </AppText>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      {!smartCheck.allowed && (
        <View style={styles.proBanner}>
          <View style={styles.proBadge}>
            <AppText style={styles.proBadgeText}>Pro / Lifetime 專屬功能</AppText>
          </View>
          <AppText style={styles.proBannerTitle}>智慧重新排程試算預覽</AppText>
          <AppText secondary style={styles.proBannerDesc}>
            目前為預覽模式。升級至 Pro 方案可一鍵套用智慧排程，自動平衡落後章節並提供研讀負擔分析。
          </AppText>
          <Button
            title="查看會員方案"
            variant="secondary"
            onPress={() => router.push('/subscription')}
            style={{ marginTop: spacing.sm }}
          />
        </View>
      )}

      <AppText secondary style={styles.intro}>
        重新排程只會為「尚未完成」或「落後」的任務計算新日期。所有已完成的紀錄絕對不會被刪除或重複安排。
      </AppText>

      {/* 重新排程起始點選項 */}
      <View style={styles.optionCard}>
        <AppText variant="footnote" secondary>
          重新排程起點
        </AppText>
        <View style={styles.segmentWrap}>
          <Pressable
            onPress={() => setStartFromTomorrow(false)}
            style={[styles.segmentBtn, !startFromTomorrow && styles.segmentBtnActive]}
            accessibilityRole="button"
          >
            <AppText
              variant="subhead"
              color={!startFromTomorrow ? colors.onPrimary : colors.text}
              style={{ fontWeight: '600' }}
            >
              從今日開始安排
            </AppText>
          </Pressable>
          <Pressable
            onPress={() => setStartFromTomorrow(true)}
            style={[styles.segmentBtn, startFromTomorrow && styles.segmentBtnActive]}
            accessibilityRole="button"
          >
            <AppText
              variant="subhead"
              color={startFromTomorrow ? colors.onPrimary : colors.text}
              style={{ fontWeight: '600' }}
            >
              從明日起接續安排
            </AppText>
          </Pressable>
        </View>
        <AppText variant="caption" secondary style={{ marginTop: 4 }}>
          {startFromTomorrow
            ? '今日若已無時間讀書，所有未完成任務將自明日起平攤配置。'
            : '今天仍有可用時間，未完成任務將依優先順序排入今日額度。'}
        </AppText>
      </View>

      {/* 友善提示：無落後任務時顯示 */}
      {isNoOverdue ? (
        <View style={styles.peacefulBox}>
          <AppText variant="headline" color={colors.primary}>
            進度正常，無落後任務
          </AppText>
          <AppText variant="subhead" secondary style={{ marginTop: 4 }}>
            太棒了！這場考試目前沒有任何過去逾期未完成的任務。您可以維持現有節奏，或點選下方按鈕重新均勻分配剩餘天數。
          </AppText>
        </View>
      ) : (
        <View style={[styles.status, { backgroundColor: colors.warningSoft }]}>
          <AppText variant="headline" color={colors.warning}>
            偵測到 {behindTasks.length} 項任務進度落後
          </AppText>
          <AppText variant="subhead" secondary style={{ marginTop: 4 }}>
            已自動為您將這些逾期任務重新分配至今天起到考前一天的可用讀書日。
          </AppText>
        </View>
      )}

      {/* 剩餘可用時間 vs 需求時間 */}
      <Section title="排程容量分析">
        <Row title="考試日期" value={formatYearMonthDay(exam.examDate)} />
        <Row title="考前可用天數" value={`${plan.remainingStudyDays} 天`} />
        <Row title="每日讀書時間上限" value={formatMinutes(plan.dailyLimitMinutes)} />
        <Row title="剩餘可用總時間" value={formatMinutes(plan.remainingAvailableMinutes)} />
        <Row title="未完成任務總需時間" value={formatMinutes(plan.unfinishedRequiredMinutes)} />
        <Row title="安全保留已完成任務" value={`${plan.completedTasks.length} 項`} />
      </Section>

      {/* 容量警示與處理選項 */}
      {!plan.isFeasible ? (
        <View style={[styles.status, { backgroundColor: colors.warningSoft }]}>
          <AppText variant="headline" color={colors.warning}>
            考前剩餘時間不足
          </AppText>
          <AppText variant="subhead" secondary style={{ marginTop: 4 }}>
            {plan.warning}
          </AppText>

          {plan.unassignedTasks.length > 0 ? (
            <View style={styles.unassignedWrap}>
              <AppText variant="footnote" color={colors.warning} style={{ fontWeight: '600' }}>
                超額未排入任務（共 {plan.unassignedTasks.length} 項，保留於清單中）：
              </AppText>
              {plan.unassignedTasks.map((u) => {
                const sub = getSubject(data, u.subjectId);
                return (
                  <AppText key={u.id} variant="footnote" secondary style={{ marginTop: 2 }}>
                    • {u.title} ({sub?.name ?? ''} · {formatMinutes(u.estimatedMinutes)})
                  </AppText>
                );
              })}
            </View>
          ) : null}

          {plan.suggestions && plan.suggestions.length > 0 ? (
            <View style={styles.suggestionBox}>
              <AppText variant="footnote" color={colors.text} style={{ fontWeight: '600' }}>
                建議處理選項：
              </AppText>
              {plan.suggestions.map((s, idx) => (
                <AppText key={idx} variant="footnote" secondary style={{ marginTop: 2 }}>
                  {idx + 1}. {s}
                </AppText>
              ))}
              <View style={{ marginTop: spacing.md }}>
                <Button
                  title="前往設定增加每日讀書時間"
                  variant="secondary"
                  onPress={() => router.push('/(tabs)/settings')}
                />
              </View>
            </View>
          ) : null}
        </View>
      ) : null}

      {/* 每日讀書負荷對比（重新排程前 vs 重新排程後） */}
      {plan.loadComparisons && plan.loadComparisons.length > 0 ? (
        <Section
          title="每日負荷調整對比（前 ➜ 後）"
          footer="顯示每日在調整前後的任務數與總預估時間，所有安排皆不得超過每日上限。"
        >
          {plan.loadComparisons.slice(0, 8).map((comp) => {
            const isToday = comp.date === today;
            const diff = comp.afterMinutes - comp.beforeMinutes;
            const diffTag =
              diff === 0
                ? '持平'
                : diff > 0
                  ? `+${diff}分`
                  : `${diff}分`;

            return (
              <Row
                key={comp.date}
                title={`${formatMonthDay(comp.date)}${isToday ? '（今天）' : ''}`}
                subtitle={`前：${comp.beforeCount}項 (${formatMinutes(comp.beforeMinutes)}) ➜ 後：${comp.afterCount}項 (${formatMinutes(comp.afterMinutes)})`}
                value={diffTag}
              />
            );
          })}
        </Section>
      ) : null}

      {/* 每日排程預覽（每日任務數及預估時間，供核對每日上限） */}
      {plan.dailyStats.filter((d) => d.taskCount > 0).length > 0 ? (
        <Section
          title="每日排程負載預覽"
          footer="每一天安排的任務總時間皆嚴格符合每日上限規範。"
        >
          {plan.dailyStats
            .filter((d) => d.taskCount > 0)
            .map((d) => (
              <Row
                key={d.date}
                title={formatFullDate(d.date)}
                value={`${d.taskCount} 項 · ${formatMinutes(d.totalMinutes)}`}
                subtitle={`每日上限 ${formatMinutes(d.limitMinutes)}`}
              />
            ))}
        </Section>
      ) : null}

      {/* 新舊差異預覽清單 */}
      {hasChanges ? (
        <Section
          title={`任務日期調整預覽（共 ${plan.changedTasks.length} 項）`}
          footer="請核對上方的新排定日期。確認後點選下方按鈕即可套用儲存。"
        >
          {plan.changedTasks.map((change) => {
            const subject = getSubject(data, change.subjectId);
            return (
              <Row
                key={change.taskId}
                title={change.taskTitle}
                subtitle={`${subject?.name ?? ''} · 原訂 ${formatMonthDay(change.oldDate)} · ${formatMinutes(change.estimatedMinutes)}`}
                value={`➜ ${formatMonthDay(change.newDate)}`}
              />
            );
          })}
        </Section>
      ) : (
        <Section title="變更預覽">
          <Row title="所有任務狀態正常" value="無須移動日期" />
        </Section>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { marginBottom: spacing.lg },
  examTabs: {
    gap: spacing.sm,
    paddingBottom: spacing.md,
  },
  examChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.separator,
  },
  examChipSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  peacefulBox: {
    backgroundColor: colors.primarySoft,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.xl,
  },
  status: {
    backgroundColor: colors.primarySoft,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.xl,
  },
  unassignedWrap: {
    marginTop: spacing.md,
    padding: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
  },
  suggestionBox: {
    marginTop: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
  },
  optionCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: colors.separator,
  },
  segmentWrap: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
    marginBottom: 2,
  },
  segmentBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.background,
  },
  segmentBtnActive: {
    backgroundColor: colors.primary,
  },
  proBanner: {
    backgroundColor: '#FAF5EA',
    borderColor: '#EBDCB9',
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  proBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#8C6C38',
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    marginBottom: spacing.xs,
  },
  proBadgeText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  proBannerTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#634A21',
    marginBottom: 4,
  },
  proBannerDesc: {
    fontSize: 12,
    lineHeight: 18,
    color: '#735B32',
  },
});
