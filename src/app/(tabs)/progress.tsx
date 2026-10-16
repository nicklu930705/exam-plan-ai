import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ActiveTimerBanner } from '../../components/ActiveTimerBanner';
import { AiAdviceCard } from '../../components/AiAdviceCard';
import { AppText } from '../../components/AppText';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Section } from '../../components/List';
import { ProgressBar } from '../../components/ProgressBar';
import { RecommendationCard } from '../../components/RecommendationCard';
import { Screen } from '../../components/Screen';
import { ScreenHeader } from '../../components/ScreenHeader';
import { TaskRow } from '../../components/TaskRow';
import { FAMILIARITY_LABELS } from '../../constants/labels';
import { useStudyTimer } from '../../hooks/useStudyTimer';
import { useToday } from '../../hooks/useToday';
import { generateStudyRecommendations } from '../../scheduler/recommendations';
import {
  logDiagnostic,
  requestAiStudyAdvice,
  type AiAdviceServiceResult,
} from '../../services/aiAdviceService';
import { useAppStore } from '../../store/AppStore';

import {
  computeDashboardStats,
  computeProgress,
  getBehindTasks,
  getExamById,
  getRecentPeriodStats,
  getSubject,
  getUpcomingExam,
  tasksForDate,
  tasksForExam,
} from '../../store/selectors';
import { colors, radius, shadow, spacing } from '../../theme';
import { diffDays, formatMinutes, formatYearMonthDay } from '../../utils/date';

export default function ProgressScreen() {
  const { data, setTaskStatus, setSelectedExamId, recordAiUsage } = useAppStore();
  const today = useToday();
  const { activeTimer, formattedTime, startTimer } = useStudyTimer();

  // 選取的考試過濾：'all' 表示全部考試整合儀表，其餘為指定考試 ID
  const [selectedFilter, setSelectedFilter] = useState<string>(() => data.selectedExamId ?? 'all');
  const [aiAdviceResult, setAiAdviceResult] = useState<AiAdviceServiceResult | null>(null);
  const [isLoadingAi, setIsLoadingAi] = useState<boolean>(false);
  const [showAiCard, setShowAiCard] = useState<boolean>(false);

  const upcomingExam = useMemo(() => getUpcomingExam(data, today), [data, today]);
  const activeExam = useMemo(() => {
    if (selectedFilter === 'all') return null;
    return getExamById(data, selectedFilter) ?? null;
  }, [data, selectedFilter]);

  // 當前儀表板聚焦的任務集合
  const activeTasks = useMemo(() => {
    if (selectedFilter === 'all') {
      return data.tasks;
    }
    return tasksForExam(data.tasks, selectedFilter);
  }, [data.tasks, selectedFilter]);

  // 核心綜合儀表統計數據
  const dashboardStats = useMemo(
    () => computeDashboardStats(activeTasks, today),
    [activeTasks, today],
  );

  // 落後／待補任務（針對當前檢視）
  const behindTasks = useMemo(
    () => getBehindTasks(activeTasks, today),
    [activeTasks, today],
  );

  // 今日打卡進度
  const todayTasks = useMemo(() => tasksForDate(activeTasks, today), [activeTasks, today]);
  const todayProgress = useMemo(() => computeProgress(todayTasks), [todayTasks]);

  // 近 7 天打卡歷程
  const recentStats = useMemo(
    () => getRecentPeriodStats(activeTasks, today, 7),
    [activeTasks, today],
  );

  // 個人化讀書建議
  const recommendations = useMemo(
    () =>
      generateStudyRecommendations({
        exams: data.exams,
        tasks: data.tasks,
        preferences: data.preferences,
        today,
        selectedExamId: activeExam?.id,
      }),
    [data.exams, data.tasks, data.preferences, today, activeExam?.id],
  );

  if (data.exams.length === 0) {
    return (
      <Screen topInset>
        <ScreenHeader title="進度儀表板" />
        <EmptyState
          title="還沒有進度可以查看"
          message="建立考試並開始完成每日讀書任務後，這裡會顯示整體的完成率、實讀時間對比與各科分析。"
          actionTitle="建立第一場考試"
          onAction={() => router.push('/exam/new')}
        />
      </Screen>
    );
  }

  // 倒數天數計算
  const focusedCountdownDays = activeExam
    ? diffDays(today, activeExam.examDate)
    : upcomingExam
      ? diffDays(today, upcomingExam.examDate)
      : null;

  const handleRequestAiAdvice = async () => {
    const targetExam = activeExam ?? upcomingExam ?? data.exams[0];
    logDiagnostic('AI_BUTTON_PRESSED', { examName: targetExam?.name, screen: 'progress' });
    if (!targetExam || isLoadingAi) return;

    setIsLoadingAi(true);
    setShowAiCard(true);
    setAiAdviceResult(null);
    logDiagnostic('AI_LOADING_STARTED', { screen: 'progress' });

    try {
      const targetTasks = tasksForExam(data.tasks, targetExam.id);
      const completedTasks = targetTasks.filter((t) => t.status === 'done');
      const completionRate =
        targetTasks.length > 0
          ? Math.round((completedTasks.length / targetTasks.length) * 100)
          : 0;

      const subjectsInput = targetExam.subjects.map((s) => {
        const sTasks = targetTasks.filter((t) => t.subjectId === s.id);
        const completedChapIds = new Set(
          sTasks.filter((t) => t.status === 'done' && t.chapterId).map((t) => t.chapterId),
        );
        return {
          name: s.name,
          familiarity: s.familiarity,
          totalChapters: s.chapters?.length ?? 0,
          completedChapters: completedChapIds.size,
        };
      });

      const result = await requestAiStudyAdvice({
        request: {
          examName: targetExam.name,
          examDate: targetExam.examDate,
          dailyAvailableMinutes: data.preferences.dailyMinutes,
          intensity: data.preferences.intensity,
          subjects: subjectsInput,
          recentCompletionRate: completionRate,
          behindTasksCount: behindTasks.length,
        },
        forceAi: true,
        strictError: true,
      });

      const isFreshCloudAi =
        result.success &&
        (result.source === 'openai_ai' || result.source === 'gemini_ai') &&
        !result.cached;

      if (isFreshCloudAi) {
        recordAiUsage();
      }

      setAiAdviceResult(result);
    } catch (err: any) {
      logDiagnostic('AI_REQUEST_FAILED', {
        screen: 'progress',
        error: err?.message || '網路連線失敗，請檢查 iPhone 網路連線。',
      });
      setAiAdviceResult({
        success: false,
        status: 'network_error',
        source: 'fallback_rule_engine',
        disclaimer: 'AI 建議僅供學習策略與心理激勵參考。',
        error: err?.message || '網路連線失敗，請檢查 iPhone 網路連線。',
      });
    } finally {
      setIsLoadingAi(false);
      logDiagnostic('AI_LOADING_FINISHED', { screen: 'progress' });
    }
  };


  return (
    <Screen
      topInset
      footer={
        <Button
          title={behindTasks.length > 0 ? '重新安排落後任務' : '重新安排計畫'}
          variant={behindTasks.length > 0 ? 'primary' : 'secondary'}
          onPress={() =>
            router.push({
              pathname: '/reschedule',
              params: activeExam ? { examId: activeExam.id } : undefined,
            })
          }
        />
      }
    >
      <ScreenHeader
        title="進度儀表板"
        subtitle="任務達成率 · 實讀時間對比 · 科目掌握度"
      />

      <ActiveTimerBanner />

      {/* ───── 考試切換 Chips ───── */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.examTabs}
      >
        <Pressable
          onPress={() => setSelectedFilter('all')}
          style={[styles.examChip, selectedFilter === 'all' && styles.examChipSelected]}
          accessibilityRole="button"
          accessibilityState={{ selected: selectedFilter === 'all' }}
        >
          <AppText
            variant="footnote"
            color={selectedFilter === 'all' ? colors.onPrimary : colors.text}
            style={selectedFilter === 'all' && { fontWeight: '600' }}
          >
            全部計畫 ({data.exams.length} 場)
          </AppText>
        </Pressable>

        {data.exams.map((exam) => {
          const isSelected = selectedFilter === exam.id;
          const days = diffDays(today, exam.examDate);
          const badgeText = days > 0 ? `${days}天` : days === 0 ? '今天' : '已結束';

          return (
            <Pressable
              key={exam.id}
              onPress={() => {
                setSelectedFilter(exam.id);
                setSelectedExamId(exam.id);
              }}
              style={[styles.examChip, isSelected && styles.examChipSelected]}
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected }}
            >
              <AppText
                variant="footnote"
                color={isSelected ? colors.onPrimary : colors.text}
                style={isSelected && { fontWeight: '600' }}
              >
                {exam.name} ({badgeText})
              </AppText>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* ───── 1. 考試倒數提醒卡片 ───── */}
      <View style={styles.countdownCard}>
        <View style={styles.countdownLeft}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <AppText variant="footnote" secondary>
              {activeExam ? '選定考試' : '最近一場考試'}
            </AppText>
            {(activeExam ?? upcomingExam) ? (
              <Pressable
                onPress={() =>
                  router.push({
                    pathname: '/exam/edit',
                    params: { id: (activeExam ?? upcomingExam)!.id },
                  })
                }
                hitSlop={8}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}
                accessibilityRole="button"
                accessibilityLabel="編輯考試"
              >
                <Ionicons name="create-outline" size={14} color={colors.primary} />
                <AppText variant="caption" color={colors.primary} style={{ fontWeight: '600' }}>
                  編輯
                </AppText>
              </Pressable>
            ) : null}
          </View>
          <AppText variant="headline" style={{ marginTop: 2 }}>
            {activeExam?.name ?? upcomingExam?.name ?? '尚未設定考試'}
          </AppText>
          <AppText variant="caption" secondary style={{ marginTop: 2 }}>
            {formatYearMonthDay(activeExam?.examDate ?? upcomingExam?.examDate ?? today)}
          </AppText>
        </View>
        <View style={styles.countdownBadgeBox}>
          {focusedCountdownDays !== null ? (
            focusedCountdownDays > 0 ? (
              <View style={styles.countdownCenter}>
                <AppText variant="caption" secondary>
                  倒數
                </AppText>
                <AppText variant="title" style={styles.countdownBigNumber}>
                  {focusedCountdownDays}
                </AppText>
                <AppText variant="caption" secondary>
                  天
                </AppText>
              </View>
            ) : focusedCountdownDays === 0 ? (
              <AppText variant="subhead" color={colors.primary} style={{ fontWeight: '700' }}>
                今天考試
              </AppText>
            ) : (
              <AppText variant="footnote" secondary>
                已結束
              </AppText>
            )
          ) : null}
        </View>
      </View>

      {/* ───── 個人化智慧讀書建議 ───── */}
      {showAiCard ? (
        <AiAdviceCard
          advice={aiAdviceResult?.advice}
          source={aiAdviceResult?.source}
          disclaimer={aiAdviceResult?.disclaimer}
          note={aiAdviceResult?.note}
          status={aiAdviceResult?.status}
          error={aiAdviceResult?.error}
          errorCode={aiAdviceResult?.errorCode}
          examName={activeExam?.name ?? upcomingExam?.name}
          quotaStatus={aiAdviceResult?.quotaStatus}
          isLoading={isLoadingAi}
          onRefresh={handleRequestAiAdvice}
          onRetry={handleRequestAiAdvice}
          onDismiss={() => setShowAiCard(false)}
        />
      ) : recommendations.length > 0 ? (
        <View style={{ marginBottom: spacing.md }}>
          <View style={styles.recommendationHeaderRow}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="sparkles" size={16} color={colors.primary} />
              <AppText variant="subhead" style={{ fontWeight: '600' }}>
                智慧讀書建議
              </AppText>
            </View>
            <Pressable
              onPress={handleRequestAiAdvice}
              disabled={isLoadingAi}
              style={({ pressed }) => [styles.aiHeaderPill, pressed && { opacity: 0.7 }]}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="取得 AI 讀書教練建議"
            >
              <Ionicons name="sparkles" size={12} color={colors.primary} />
              <AppText variant="caption" color={colors.primary} style={{ fontWeight: '700' }}>
                {isLoadingAi ? 'AI 分析中...' : '✦ AI 讀書建議'}
              </AppText>
            </Pressable>
          </View>
          <RecommendationCard
            recommendation={recommendations[0]}
            onAction={() => {
              const rec = recommendations[0];
              if (rec.actionRoute) {
                router.push({
                  pathname: rec.actionRoute as any,
                  params: rec.actionParams,
                });
              }
            }}
          />
        </View>
      ) : null}


      {/* ───── 2. 核心完成率與任務狀態分布 ───── */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View>
            <AppText variant="footnote" secondary>
              {activeExam ? `「${activeExam.name}」達成率` : '全體計畫任務完成率'}
            </AppText>
            <AppText variant="title" style={{ marginTop: 2 }}>
              完成率 {dashboardStats.completionPercentage}%
            </AppText>
          </View>
          <View style={styles.pillBadge}>
            <AppText variant="footnote" color={colors.primary} style={{ fontWeight: '600' }}>
              {dashboardStats.doneCount} / {dashboardStats.totalCount} 項完成
            </AppText>
          </View>
        </View>

        <ProgressBar value={dashboardStats.completionRatio} height={10} />

        {/* 4 宮格任務狀態細分 */}
        <View style={styles.metricsGrid}>
          <View style={styles.metricItem}>
            <View style={styles.metricLabelRow}>
              <Ionicons name="checkmark-circle" size={14} color={colors.primary} />
              <AppText variant="caption" secondary>
                已完成
              </AppText>
            </View>
            <AppText variant="headline" color={colors.primary} style={styles.metricValue}>
              {dashboardStats.doneCount} 項
            </AppText>
          </View>

          <View style={styles.metricItem}>
            <View style={styles.metricLabelRow}>
              <Ionicons name="time-outline" size={14} color={colors.textSecondary} />
              <AppText variant="caption" secondary>
                待完成 (未來)
              </AppText>
            </View>
            <AppText variant="headline" style={styles.metricValue}>
              {dashboardStats.pendingCount} 項
            </AppText>
          </View>

          <View style={styles.metricItem}>
            <View style={styles.metricLabelRow}>
              <Ionicons
                name="alert-circle"
                size={14}
                color={dashboardStats.overdueCount > 0 ? colors.warning : colors.textSecondary}
              />
              <AppText
                variant="caption"
                color={dashboardStats.overdueCount > 0 ? colors.warning : colors.textSecondary}
                style={dashboardStats.overdueCount > 0 && { fontWeight: '600' }}
              >
                逾期未完成
              </AppText>
            </View>
            <AppText
              variant="headline"
              color={dashboardStats.overdueCount > 0 ? colors.warning : colors.text}
              style={styles.metricValue}
            >
              {dashboardStats.overdueCount} 項
            </AppText>
          </View>

          <View style={styles.metricItem}>
            <View style={styles.metricLabelRow}>
              <Ionicons
                name="flag-outline"
                size={14}
                color={dashboardStats.needsRescheduleCount > 0 ? colors.danger : colors.textSecondary}
              />
              <AppText variant="caption" secondary>
                標記待重新安排
              </AppText>
            </View>
            <AppText
              variant="headline"
              color={dashboardStats.needsRescheduleCount > 0 ? colors.danger : colors.text}
              style={styles.metricValue}
            >
              {dashboardStats.needsRescheduleCount} 項
            </AppText>
          </View>
        </View>
      </View>

      {/* ───── 3. 預估研讀時間 vs 實際研讀時間 深度對比儀表 ───── */}
      <View style={styles.card}>
        <View style={styles.timeCardTop}>
          <View>
            <AppText variant="headline" style={{ fontWeight: '700' }}>
              讀書時間投入與效益比較
            </AppText>
            <AppText variant="footnote" secondary style={{ marginTop: 2 }}>
              清晰區分預估排程與真實研讀量，不混用數據
            </AppText>
          </View>
          <View style={styles.timeBadge}>
            <Ionicons name="bar-chart" size={14} color={colors.primary} />
            <AppText variant="caption" color={colors.primary} style={{ fontWeight: '600' }}>
              {Math.round(dashboardStats.timeComparisonRatio * 100)}% 投入比
            </AppText>
          </View>
        </View>

        {/* 雙重時間對比數字 */}
        <View style={styles.timeComparisonRow}>
          <View style={styles.timeBox}>
            <AppText variant="caption" secondary>
              排程預估總時間
            </AppText>
            <AppText variant="headline" style={styles.timeBoxNumber}>
              {formatMinutes(dashboardStats.totalEstimatedMinutes)}
            </AppText>
            <AppText variant="caption" secondary style={{ fontSize: 11, marginTop: 2 }}>
              規劃基準
            </AppText>
          </View>

          <View style={styles.vsBadge}>
            <AppText variant="caption" secondary style={{ fontWeight: '700' }}>
              VS
            </AppText>
          </View>

          <View style={[styles.timeBox, styles.timeBoxHighlight]}>
            <AppText variant="caption" color={colors.primary}>
              實際研讀累計
            </AppText>
            <AppText variant="headline" color={colors.primary} style={styles.timeBoxNumber}>
              {formatMinutes(dashboardStats.totalActualMinutes)}
            </AppText>
            <AppText variant="caption" color={colors.primary} style={{ fontSize: 11, marginTop: 2 }}>
              真實計時與登記
            </AppText>
          </View>
        </View>

        {/* 時間落差與已完成任務效益分析 */}
        <View style={styles.timeAnalysisBox}>
          <View style={styles.analysisRow}>
            <Ionicons name="information-circle-outline" size={15} color={colors.primary} />
            <AppText variant="footnote" color={colors.text} style={{ flex: 1 }}>
              {dashboardStats.totalActualMinutes > 0
                ? dashboardStats.timeVarianceMinutes >= 0
                  ? `目前實際讀書時間已超過預估 ${formatMinutes(dashboardStats.timeVarianceMinutes)}，投入相當扎實！`
                  : `目前距離預估總時長尚差 ${formatMinutes(Math.abs(dashboardStats.timeVarianceMinutes))}，請持續保持進度。`
                : '尚未累積實際研讀時間，可於任務中點選「計時」或自訂登記實際研讀量。'}
            </AppText>
          </View>

          {dashboardStats.doneCount > 0 ? (
            <View style={styles.doneEfficiencyRow}>
              <AppText variant="caption" secondary>
                已完成任務比較：預估 {formatMinutes(dashboardStats.doneEstimatedMinutes)} · 實際投入{' '}
                {formatMinutes(dashboardStats.doneActualMinutes)}
              </AppText>
            </View>
          ) : null}
        </View>
      </View>

      {/* ───── 4. 今日打卡與近 7 天學習歷程 ───── */}
      <Section title="今日與近期學習歷程">
        <View style={styles.todayBox}>
          <View style={styles.todayTop}>
            <View>
              <AppText variant="subhead" style={{ fontWeight: '600' }}>
                今日任務打卡
              </AppText>
              <AppText variant="footnote" secondary style={{ marginTop: 2 }}>
                {todayTasks.length > 0
                  ? `今日完成 ${todayProgress.doneCount} / ${todayProgress.totalCount} 項（${todayProgress.percentage}%）· 預估 ${formatMinutes(todayProgress.doneMinutes)}`
                  : '今天沒有排定任務，享受休閒或自由複習。'}
              </AppText>
            </View>
            {todayTasks.length > 0 && todayProgress.doneCount === todayProgress.totalCount ? (
              <View style={styles.donePill}>
                <Ionicons name="checkmark-done" size={16} color={colors.primary} />
                <AppText variant="caption" color={colors.primary} style={{ fontWeight: '600' }}>
                  今日達標
                </AppText>
              </View>
            ) : null}
          </View>
          {todayTasks.length > 0 ? (
            <ProgressBar value={todayProgress.ratio} height={6} style={{ marginTop: spacing.sm }} />
          ) : null}
        </View>

        {/* 過去 7 天連續打卡 */}
        <View style={styles.streakWrap}>
          <View style={styles.streakHeader}>
            <AppText variant="subhead">過去 7 天學習狀況</AppText>
            <AppText variant="footnote" color={colors.primary} style={{ fontWeight: '600' }}>
              連續打卡 {recentStats.streakDays} 天 · 近週完成 {recentStats.totalDoneCount} 項 (
              {formatMinutes(recentStats.totalDoneMinutes)})
            </AppText>
          </View>

          <View style={styles.weekStrip}>
            {recentStats.days.map((d) => {
              const hasDone = d.doneCount > 0;
              return (
                <View key={d.date} style={styles.dayCol}>
                  <AppText
                    variant="caption"
                    color={d.isToday ? colors.primary : colors.textSecondary}
                    style={d.isToday && { fontWeight: '700' }}
                  >
                    {d.dayLabel}
                  </AppText>
                  <View
                    style={[
                      styles.dot,
                      hasDone ? styles.dotDone : styles.dotPending,
                      d.isToday && styles.dotToday,
                    ]}
                  >
                    <Ionicons
                      name={hasDone ? 'checkmark' : 'remove'}
                      size={14}
                      color={hasDone ? colors.onPrimary : colors.textSecondary}
                    />
                  </View>
                  <AppText variant="caption" secondary style={{ fontSize: 10 }}>
                    {hasDone ? `${d.doneCount}項` : '-'}
                  </AppText>
                </View>
              );
            })}
          </View>
        </View>
      </Section>

      {/* ───── 5. 各科目的任務完成率 ───── */}
      {activeExam ? (
        <Section title={`「${activeExam.name}」各科目完成度`}>
          {activeExam.subjects.map((subject) => {
            const subTasks = activeTasks.filter((t) => t.subjectId === subject.id);
            const p = computeProgress(subTasks);
            const subActual = subTasks.reduce((s, t) => s + (t.actualMinutes ?? 0), 0);

            return (
              <View key={subject.id} style={styles.subjectRow}>
                <View style={styles.subjectTop}>
                  <View style={{ flex: 1 }}>
                    <AppText style={{ fontWeight: '600' }}>{subject.name}</AppText>
                    <AppText variant="caption" secondary style={{ marginTop: 2 }}>
                      熟悉度：{FAMILIARITY_LABELS[subject.familiarity]} · 共 {subject.chapters.length} 章
                    </AppText>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <AppText variant="subhead" color={colors.primary} style={{ fontWeight: '700' }}>
                      {p.percentage}%
                    </AppText>
                    <AppText variant="caption" secondary>
                      {p.doneCount} / {p.totalCount} 項
                    </AppText>
                  </View>
                </View>

                <ProgressBar value={p.ratio} height={6} style={{ marginTop: spacing.xs }} />

                <View style={styles.subjectMeta}>
                  <AppText variant="caption" secondary>
                    實讀 {formatMinutes(subActual)} / 預估 {formatMinutes(p.totalMinutes)}
                  </AppText>
                  <AppText variant="caption" secondary>
                    剩餘 {p.remainingCount} 項
                  </AppText>
                </View>
              </View>
            );
          })}
        </Section>
      ) : (
        /* 全域各考試科目彙整 */
        <Section title="各科完成率一覽">
          {data.exams.flatMap((ex) =>
            ex.subjects.map((sub) => {
              const subTasks = data.tasks.filter((t) => t.subjectId === sub.id);
              const p = computeProgress(subTasks);
              const subActual = subTasks.reduce((s, t) => s + (t.actualMinutes ?? 0), 0);
              return (
                <View key={`${ex.id}-${sub.id}`} style={styles.subjectRow}>
                  <View style={styles.subjectTop}>
                    <View style={{ flex: 1 }}>
                      <AppText style={{ fontWeight: '600' }}>
                        {sub.name} ({ex.name})
                      </AppText>
                      <AppText variant="caption" secondary style={{ marginTop: 2 }}>
                        熟悉度：{FAMILIARITY_LABELS[sub.familiarity]} · 共 {sub.chapters.length} 章
                      </AppText>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <AppText variant="subhead" color={colors.primary} style={{ fontWeight: '700' }}>
                        {p.percentage}%
                      </AppText>
                      <AppText variant="caption" secondary>
                        {p.doneCount} / {p.totalCount} 項
                      </AppText>
                    </View>
                  </View>
                  <ProgressBar value={p.ratio} height={6} style={{ marginTop: spacing.xs }} />
                  <View style={styles.subjectMeta}>
                    <AppText variant="caption" secondary>
                      實讀 {formatMinutes(subActual)} / 預估 {formatMinutes(p.totalMinutes)}
                    </AppText>
                    <AppText variant="caption" secondary>
                      剩餘 {p.remainingCount} 項
                    </AppText>
                  </View>
                </View>
              );
            }),
          )}
        </Section>
      )}

      {/* ───── 6. 距離每個考試的剩餘天數與完成率一覽 ───── */}
      <Section title="所有考試進度與倒數">
        {data.exams.map((examItem) => {
          const itemTasks = tasksForExam(data.tasks, examItem.id);
          const p = computeProgress(itemTasks);
          const itemActual = itemTasks.reduce((s, t) => s + (t.actualMinutes ?? 0), 0);
          const days = diffDays(today, examItem.examDate);
          const when = days > 0 ? `還有 ${days} 天` : days === 0 ? '今天考試' : '已結束';
          const isCurrentActive = selectedFilter === examItem.id;

          return (
            <Pressable
              key={examItem.id}
              onPress={() => {
                setSelectedFilter(examItem.id);
                setSelectedExamId(examItem.id);
              }}
              style={({ pressed }) => [
                styles.examItemRow,
                isCurrentActive && styles.examItemRowActive,
                pressed && { opacity: 0.7 },
              ]}
              accessibilityRole="button"
            >
              <View style={styles.examItemTop}>
                <View style={{ flex: 1 }}>
                  <AppText variant="subhead" style={{ fontWeight: '700' }}>
                    {examItem.name}
                  </AppText>
                  <AppText variant="footnote" secondary style={{ marginTop: 2 }}>
                    {formatYearMonthDay(examItem.examDate)} · {when}
                  </AppText>
                </View>
                <AppText variant="headline" color={colors.primary}>
                  {p.percentage}%
                </AppText>
              </View>

              <ProgressBar value={p.ratio} height={6} style={{ marginTop: spacing.xs }} />

              <View style={styles.examItemMeta}>
                <AppText variant="caption" secondary>
                  已完成 {p.doneCount} / {p.totalCount} 項（剩餘 {p.remainingCount} 項）
                </AppText>
                <AppText variant="caption" secondary>
                  實讀 {formatMinutes(itemActual)} / 預估 {formatMinutes(p.totalMinutes)}
                </AppText>
              </View>
            </Pressable>
          );
        })}
      </Section>

      {/* ───── 7. 逾期與落後任務列表（若有） ───── */}
      {behindTasks.length > 0 ? (
        <Section
          title={`需要補上的任務 (${behindTasks.length} 項)`}
          footer="點選圓圈打勾可立即完成；點選按鈕進入任務可微調時間或重新安排。"
        >
          {behindTasks.map((task) => {
            const taskSub = getSubject(data, task.subjectId);
            const taskChapter = taskSub?.chapters.find((c) => c.id === task.chapterId);
            const isTiming = activeTimer?.taskId === task.id;
            const taskExam = getExamById(data, task.examId);

            return (
              <TaskRow
                key={task.id}
                task={task}
                examName={taskExam?.name}
                overdue
                subjectName={task.subjectName ?? taskSub?.name}
                chapterTitle={taskChapter?.title}
                onToggle={() =>
                  setTaskStatus(task.id, task.status === 'done' ? 'pending' : 'done')
                }
                onPress={() => router.push({ pathname: '/task/[id]', params: { id: task.id } })}
                onStartTimer={() => startTimer(task.id)}
                isTiming={isTiming}
                timingFormatted={formattedTime}
              />
            );
          })}
        </Section>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  examTabs: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
    marginBottom: spacing.md,
  },
  examChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    ...shadow.sm,
  },
  examChipSelected: {
    backgroundColor: colors.primary,
  },
  countdownCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    padding: spacing.md,
    borderRadius: radius.md,
    marginBottom: spacing.md,
    ...shadow.sm,
  },
  countdownLeft: {
    flex: 1,
    marginRight: spacing.sm,
  },
  countdownBadgeBox: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    flexShrink: 0,
  },
  countdownCenter: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 3,
  },
  countdownBigNumber: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '700',
    color: colors.primary,
    fontVariant: ['tabular-nums'],
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    ...shadow.sm,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: spacing.md,
  },
  pillBadge: {
    backgroundColor: colors.primarySoft,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
  },
  metricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
    rowGap: spacing.md,
  },
  metricItem: {
    width: '50%',
  },
  metricLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  metricValue: {
    marginTop: 2,
    fontWeight: '700',
  },
  timeCardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: spacing.md,
  },
  timeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.primarySoft,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  timeComparisonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginVertical: spacing.sm,
    gap: spacing.sm,
  },
  timeBox: {
    flex: 1,
    backgroundColor: colors.background,
    padding: spacing.md,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  timeBoxHighlight: {
    backgroundColor: colors.primarySoft,
  },
  timeBoxNumber: {
    marginTop: 4,
    fontWeight: '700',
  },
  vsBadge: {
    paddingHorizontal: spacing.xs,
  },
  timeAnalysisBox: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
  },
  analysisRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  doneEfficiencyRow: {
    marginTop: spacing.xs + 2,
    paddingLeft: 21,
  },
  todayBox: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  todayTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  donePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.primarySoft,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  streakWrap: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
  },
  streakHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: spacing.sm,
  },
  weekStrip: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.xs,
  },
  dayCol: {
    alignItems: 'center',
    gap: 6,
  },
  dot: {
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotDone: {
    backgroundColor: colors.primary,
  },
  dotPending: {
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.separator,
  },
  dotToday: {
    borderWidth: 2,
    borderColor: colors.primary,
  },
  subjectRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  subjectTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  subjectMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
  },
  examItemRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  examItemRowActive: {
    backgroundColor: colors.primarySoft,
  },
  examItemTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  examItemMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
  },
  recommendationHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
    paddingHorizontal: 2,
  },
  aiHeaderPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.primarySoft,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
});

