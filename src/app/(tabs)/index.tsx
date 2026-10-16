import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ActiveTimerBanner } from '../../components/ActiveTimerBanner';
import { AiAdviceCard } from '../../components/AiAdviceCard';
import { AppText } from '../../components/AppText';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Row, Section } from '../../components/List';
import { ProgressBar } from '../../components/ProgressBar';
import { RecommendationCard } from '../../components/RecommendationCard';
import { Screen } from '../../components/Screen';
import { ScreenHeader } from '../../components/ScreenHeader';
import { TaskRow } from '../../components/TaskRow';
import { useStudyTimer } from '../../hooks/useStudyTimer';
import { useToday } from '../../hooks/useToday';
import { prioritizeTasks, TaskPriorityResult } from '../../scheduler/priority';
import { generateStudyRecommendations } from '../../scheduler/recommendations';
import {
  logDiagnostic,
  requestAiStudyAdvice,
  type AiAdviceServiceResult,
} from '../../services/aiAdviceService';
import { useAppStore } from '../../store/AppStore';

import {
  computeProgress,
  getBehindTasks,
  getExamById,
  getSubject,
  getUpcomingExam,
  tasksForDate,
  tasksForExam,
} from '../../store/selectors';
import { colors, radius, shadow, spacing } from '../../theme';
import {
  diffDays,
  formatFullDate,
  formatMinutes,
  formatYearMonthDay,
  weekdayOf,
} from '../../utils/date';

export default function HomeScreen() {
  const { data, setTaskStatus, setSelectedExamId, loadDemo, recordAiUsage } = useAppStore();
  const today = useToday();
  const { activeTimer, formattedTime, startTimer } = useStudyTimer();

  // 支援切換「全部考試」或特定考試
  const [filterExamId, setFilterExamId] = useState<string>('all');
  // 任務排序模式：true 為依個人化智慧優先序，false 為依原預定日期
  const [sortByPriority, setSortByPriority] = useState<boolean>(true);
  // 使用者手動忽略的建議 ID
  const [dismissedRecIds, setDismissedRecIds] = useState<string[]>([]);
  // AI 讀書教練建議狀態
  const [aiAdviceResult, setAiAdviceResult] = useState<AiAdviceServiceResult | null>(null);
  const [isLoadingAi, setIsLoadingAi] = useState<boolean>(false);
  const [showAiCard, setShowAiCard] = useState<boolean>(false);

  const examWithTasks = data.exams.find((e) => tasksForExam(data.tasks, e.id).length > 0);
  const exam =
    getExamById(data, data.selectedExamId) ??
    examWithTasks ??
    getUpcomingExam(data, today) ??
    data.exams[0];

  // 依選取的考試過濾（若選擇 'all' 則包含今日所有考試的任務）
  const relevantTasks = useMemo(() => {
    if (filterExamId === 'all') return data.tasks;
    return tasksForExam(data.tasks, filterExamId);
  }, [data.tasks, filterExamId]);

  const todayTasks = useMemo(() => tasksForDate(relevantTasks, today), [relevantTasks, today]);
  const progress = useMemo(() => computeProgress(todayTasks), [todayTasks]);

  // 個人化任務優先度計算
  const priorities = useMemo(
    () => prioritizeTasks(relevantTasks, data.exams, data.preferences, today),
    [relevantTasks, data.exams, data.preferences, today],
  );

  const priorityMap = useMemo(() => {
    const map = new Map<string, TaskPriorityResult>();
    for (const p of priorities) {
      map.set(p.task.id, p);
    }
    return map;
  }, [priorities]);

  // 今日任務清單（依設定之排序規則呈現）
  const displayTodayTasks = useMemo(() => {
    if (!sortByPriority) return todayTasks;
    return [...todayTasks].sort((a, b) => {
      // 已完成任務統一排在下方
      if (a.status === 'done' && b.status !== 'done') return 1;
      if (a.status !== 'done' && b.status === 'done') return -1;
      const scoreA = priorityMap.get(a.id)?.score ?? 0;
      const scoreB = priorityMap.get(b.id)?.score ?? 0;
      if (scoreB !== scoreA) return scoreB - scoreA;
      return a.title.localeCompare(b.title);
    });
  }, [todayTasks, sortByPriority, priorityMap]);

  // 個人化讀書建議計算
  const allRecommendations = useMemo(
    () =>
      generateStudyRecommendations({
        exams: data.exams,
        tasks: data.tasks,
        preferences: data.preferences,
        today,
        selectedExamId: exam?.id,
      }),
    [data.exams, data.tasks, data.preferences, today, exam?.id],
  );

  const activeRecommendations = useMemo(
    () => allRecommendations.filter((r) => !dismissedRecIds.includes(r.id)),
    [allRecommendations, dismissedRecIds],
  );

  // 今日累積實際讀書時間（分鐘）
  const todayActualMinutes = useMemo(() => {
    return todayTasks.reduce((sum, t) => sum + (t.actualMinutes ?? 0), 0);
  }, [todayTasks]);

  const behind = useMemo(() => {
    const targetTasks = exam ? tasksForExam(data.tasks, exam.id) : data.tasks;
    return getBehindTasks(targetTasks, today);
  }, [data.tasks, exam, today]);

  const nextTask = todayTasks.find((t) => t.status !== 'done');
  const isRestDay = data.preferences.restDays.includes(weekdayOf(today));

  const handleRequestAiAdvice = async () => {
    logDiagnostic('AI_BUTTON_PRESSED', { examName: exam?.name, screen: 'index' });
    if (!exam || isLoadingAi) return;

    setIsLoadingAi(true);
    setShowAiCard(true);
    setAiAdviceResult(null);
    logDiagnostic('AI_LOADING_STARTED', { screen: 'index' });

    try {
      const examTasks = tasksForExam(data.tasks, exam.id);
      const completedTasks = examTasks.filter((t) => t.status === 'done');
      const completionRate =
        examTasks.length > 0
          ? Math.round((completedTasks.length / examTasks.length) * 100)
          : 0;

      const subjectsInput = exam.subjects.map((s) => {
        const sTasks = examTasks.filter((t) => t.subjectId === s.id);
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
          examName: exam.name,
          examDate: exam.examDate,
          dailyAvailableMinutes: data.preferences.dailyMinutes,
          intensity: data.preferences.intensity,
          subjects: subjectsInput,
          recentCompletionRate: completionRate,
          behindTasksCount: behind.length,
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
        screen: 'index',
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
      logDiagnostic('AI_LOADING_FINISHED', { screen: 'index' });
    }
  };

  const createButton = (

    <Pressable
      onPress={() => router.push('/exam/new')}
      accessibilityRole="button"
      accessibilityLabel="建立新考試"
      hitSlop={8}
      style={({ pressed }) => [styles.headerAction, pressed && { opacity: 0.6 }]}
    >
      <AppText variant="subhead" color={colors.primary} style={{ fontWeight: '600' }}>
        ＋ 新考試
      </AppText>
    </Pressable>
  );

  // ───── 沒有任何考試：空白狀態 ─────
  if (!exam) {
    return (
      <Screen topInset>
        <ScreenHeader title="今天" subtitle={formatFullDate(today)} />
        <EmptyState
          title="尚未建立考試"
          message="建立第一場考試，輸入科目與範圍後，App 會幫你把範圍拆成每天可以完成的小任務。"
          actionTitle="建立第一場考試"
          onAction={() => router.push('/exam/new')}
        />
        <View style={{ alignItems: 'center', marginTop: spacing.md }}>
          <Button title="體驗多益示範資料" variant="plain" onPress={loadDemo} />
        </View>
      </Screen>
    );
  }

  const daysLeft = diffDays(today, exam.examDate);

  // 取得下一個即將到來的讀書日任務（當今天無任務時供預覽）
  const futureTasks = data.tasks
    .filter((t) => (exam ? t.examId === exam.id : true) && t.date > today && t.status !== 'done')
    .sort((a, b) => a.date.localeCompare(b.date));
  const nextStudyDate = futureTasks[0]?.date;
  const nextDayTasks = nextStudyDate ? futureTasks.filter((t) => t.date === nextStudyDate) : [];

  // 主要操作：開始讀書／進入計時／查看計畫
  const primary = nextTask ? (
    <Button
      title={activeTimer?.taskId === nextTask.id ? '前往計時中任務' : `開始讀書：${nextTask.title}`}
      accessibilityHint={`開啟「${nextTask.title}」並專注研讀`}
      onPress={() => router.push({ pathname: '/task/[id]', params: { id: nextTask.id } })}
    />
  ) : (
    <Button
      title="查看讀書計畫"
      onPress={() => router.push({ pathname: '/(tabs)/plan', params: { examId: exam.id } })}
    />
  );

  return (
    <Screen topInset footer={primary}>
      <ScreenHeader title="今天" subtitle={formatFullDate(today)} right={createButton} />

      {/* 常駐全域計時 Banner（若有任務正在計時中） */}
      <ActiveTimerBanner />

      {data.isDemo ? (
        <AppText variant="footnote" secondary style={styles.demoNote}>
          目前顯示的是示範資料，可以到「設定」清除後建立自己的考試。
        </AppText>
      ) : null}

      {/* 考試快速切換標籤列（若有多場考試） */}
      {data.exams.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.examTabs}
        >
          <Pressable
            onPress={() => setFilterExamId('all')}
            style={[styles.examChip, filterExamId === 'all' && styles.examChipSelected]}
            accessibilityRole="button"
          >
            <AppText
              variant="footnote"
              color={filterExamId === 'all' ? colors.onPrimary : colors.text}
              style={filterExamId === 'all' && { fontWeight: '600' }}
            >
              全部考試
            </AppText>
          </Pressable>

          {data.exams.map((e) => {
            const isSelected = e.id === filterExamId || (filterExamId !== 'all' && e.id === exam.id);
            return (
              <Pressable
                key={e.id}
                onPress={() => {
                  setFilterExamId(e.id);
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

      {/* 最近一場考試倒數卡片 */}
      <Pressable
        onPress={() => router.push({ pathname: '/(tabs)/plan', params: { examId: exam.id } })}
        accessibilityRole="button"
        accessibilityHint="查看該場考試讀書計畫"
        style={({ pressed }) => [styles.exam, pressed && { opacity: 0.7 }]}
      >
        <View style={{ flex: 1 }}>
          <AppText variant="footnote" secondary>
            最近一場考試
          </AppText>
          <AppText variant="headline" style={{ marginTop: 2 }}>
            {exam.name}
          </AppText>
          <AppText variant="footnote" secondary style={{ marginTop: 2 }}>
            {formatYearMonthDay(exam.examDate)}
          </AppText>
        </View>
        <View style={styles.countdown}>
          {daysLeft === 0 ? (
            <AppText variant="title" color={colors.primary}>
              今天考試
            </AppText>
          ) : (
            <>
              <AppText variant="footnote" secondary>
                還有
              </AppText>
              <AppText style={styles.countdownNumber}>{daysLeft}</AppText>
              <AppText variant="footnote" secondary>
                天
              </AppText>
            </>
          )}
        </View>
      </Pressable>

      {/* ───── 今日智慧讀書建議區塊 ───── */}
      {showAiCard ? (
        <View style={styles.recommendationSection}>
          <AiAdviceCard
            advice={aiAdviceResult?.advice}
            source={aiAdviceResult?.source}
            disclaimer={aiAdviceResult?.disclaimer}
            note={aiAdviceResult?.note}
            status={aiAdviceResult?.status}
            error={aiAdviceResult?.error}
            errorCode={aiAdviceResult?.errorCode}
            examName={exam?.name}
            quotaStatus={aiAdviceResult?.quotaStatus}
            quota={aiAdviceResult?.quota}
            isLoading={isLoadingAi}
            onRefresh={handleRequestAiAdvice}
            onRetry={handleRequestAiAdvice}
            onDismiss={() => setShowAiCard(false)}
          />
        </View>
      ) : activeRecommendations.length > 0 ? (
        <View style={styles.recommendationSection}>
          <View style={styles.recommendationSectionHeader}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="sparkles" size={16} color={colors.primary} />
              <AppText variant="subhead" style={{ fontWeight: '600' }}>
                今日智慧讀書建議
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
            recommendation={activeRecommendations[0]}
            onAction={() => {
              const rec = activeRecommendations[0];
              if (rec.actionRoute) {
                router.push({
                  pathname: rec.actionRoute as any,
                  params: rec.actionParams,
                });
              }
            }}
            onDismiss={() => {
              setDismissedRecIds((prev) => [...prev, activeRecommendations[0].id]);
            }}
          />
        </View>
      ) : (
        <View style={styles.recommendationSection}>
          <Pressable
            onPress={handleRequestAiAdvice}
            disabled={isLoadingAi}
            style={({ pressed }) => [styles.aiStandaloneBtn, pressed && { opacity: 0.8 }]}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="取得 AI 讀書教練建議"
          >
            <Ionicons name="sparkles" size={15} color={colors.primary} />
            <AppText variant="subhead" color={colors.primary} style={{ fontWeight: '600' }}>
              {isLoadingAi ? 'AI 分析中...' : '✦ 取得 AI 讀書建議'}
            </AppText>
          </Pressable>
        </View>
      )}


      {/* 今日任務區塊標頭 */}
      <View style={styles.todayHeader}>
        <View>
          <AppText variant="title">今日任務</AppText>
          <AppText variant="caption" secondary style={{ marginTop: 2 }}>
            {formatFullDate(today)}
          </AppText>
        </View>

        <View style={styles.todayHeaderRight}>
          {todayTasks.length > 1 ? (
            <Pressable
              onPress={() => setSortByPriority((prev) => !prev)}
              style={[styles.sortPill, sortByPriority && styles.sortPillActive]}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={sortByPriority ? '切換為依原排定時間排序' : '切換為依智慧優先序推薦'}
            >
              <Ionicons
                name="sparkles"
                size={12}
                color={sortByPriority ? colors.onPrimary : colors.textSecondary}
              />
              <AppText
                variant="caption"
                color={sortByPriority ? colors.onPrimary : colors.textSecondary}
                style={{ fontWeight: '600' }}
              >
                {sortByPriority ? '智慧排序' : '時間排序'}
              </AppText>
            </Pressable>
          ) : null}

          {todayTasks.length > 0 ? (
            <AppText variant="subhead" secondary>
              預估 {formatMinutes(progress.totalMinutes)}
            </AppText>
          ) : null}
        </View>
      </View>

      {todayTasks.length > 0 ? (
        <>
          {/* 今日進度統計指示條 */}
          <View style={styles.progressWrap}>
            <ProgressBar value={progress.ratio} height={8} />
            <View style={styles.progressMeta}>
              <View style={styles.statsPills}>
                <AppText variant="footnote" secondary>
                  共 {progress.totalCount} 項 · 已完成 {progress.doneCount} 項 · 剩餘{' '}
                  {progress.remainingCount} 項
                </AppText>
                {todayActualMinutes > 0 ? (
                  <AppText variant="caption" color={colors.primary} style={{ marginTop: 2 }}>
                    今日累計實讀：{formatMinutes(todayActualMinutes)}
                  </AppText>
                ) : null}
              </View>
              <AppText variant="headline" color={colors.primary} style={{ fontWeight: '700' }}>
                {progress.percentage}%
              </AppText>
            </View>
          </View>

          {/* 今日任務清單 */}
          <Section>
            {displayTodayTasks.map((task) => {
              const taskExam = getExamById(data, task.examId);
              const taskSub = getSubject(data, task.subjectId);
              const taskChapter = taskSub?.chapters.find((c) => c.id === task.chapterId);
              const isTiming = activeTimer?.taskId === task.id;
              const prio = priorityMap.get(task.id);

              const priorityLabel =
                prio?.urgencyLevel === 'high'
                  ? '衝刺推薦'
                  : prio && prio.familiarity === 1
                    ? '弱項加強'
                    : undefined;

              return (
                <TaskRow
                  key={task.id}
                  task={task}
                  examName={filterExamId === 'all' && data.exams.length > 1 ? taskExam?.name : undefined}
                  subjectName={task.subjectName ?? taskSub?.name}
                  chapterTitle={taskChapter?.title}
                  priorityLabel={priorityLabel}
                  priorityReason={prio?.summaryReason}
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

          {!nextTask ? (
            <View style={styles.allDoneBox}>
              <Ionicons name="checkmark-done-circle" size={32} color={colors.primary} />
              <AppText style={{ fontWeight: '600', marginTop: spacing.xs }}>
                今天的任務都順利完成了！
              </AppText>
              <AppText variant="footnote" secondary style={{ marginTop: 2 }}>
                辛苦了，好好休息或前往「讀書計畫」預覽後續安排。
              </AppText>
            </View>
          ) : null}
        </>
      ) : (
        /* ───── 今天沒有任務：有設計感的空白狀態 ───── */
        <View style={styles.emptyTodayWrap}>
          <View style={styles.emptyCard}>
            <View style={styles.emptyIconCircle}>
              <Ionicons
                name={isRestDay ? 'cafe-outline' : 'calendar-outline'}
                size={36}
                color={colors.primary}
              />
            </View>
            <AppText variant="headline" style={{ marginTop: spacing.sm, fontWeight: '600' }}>
              {isRestDay ? '今天是每週休息日' : '今天沒有排定讀書任務'}
            </AppText>
            <AppText secondary align="center" style={styles.emptyDesc}>
              {isRestDay
                ? '適度放鬆是長跑備考的關鍵！今天好好充電，為下一個讀書日蓄積充沛能量。'
                : '太棒了！目前的任務皆已如期排定。您可以查看讀書計畫、或提前研讀下一個讀書日的章節。'}
            </AppText>
            <View style={styles.emptyActions}>
              <Button
                title="查看讀書計畫"
                variant="secondary"
                onPress={() => router.push({ pathname: '/(tabs)/plan', params: { examId: exam.id } })}
              />
            </View>
          </View>

          {/* 若後續有安排任務，提供下個讀書日預覽（可提前研讀） */}
          {nextDayTasks.length > 0 && nextStudyDate ? (
            <View style={styles.nextDayWrap}>
              <View style={styles.nextDayHeader}>
                <AppText variant="subhead" style={{ fontWeight: '600' }}>
                  下個讀書日任務預覽（{formatFullDate(nextStudyDate)}）
                </AppText>
                <AppText variant="caption" color={colors.primary}>
                  可提前研讀
                </AppText>
              </View>
              <Section>
                {nextDayTasks.map((task) => {
                  const taskExam = getExamById(data, task.examId);
                  const taskSub = getSubject(data, task.subjectId);
                  const taskChapter = taskSub?.chapters.find((c) => c.id === task.chapterId);
                  const isTiming = activeTimer?.taskId === task.id;

                  return (
                    <TaskRow
                      key={task.id}
                      task={task}
                      examName={taskExam?.name}
                      subjectName={task.subjectName ?? taskSub?.name}
                      chapterTitle={taskChapter?.title}
                      onToggle={() =>
                        setTaskStatus(task.id, task.status === 'done' ? 'pending' : 'done')
                      }
                      onPress={() =>
                        router.push({ pathname: '/task/[id]', params: { id: task.id } })
                      }
                      onStartTimer={() => startTimer(task.id)}
                      isTiming={isTiming}
                      timingFormatted={formattedTime}
                    />
                  );
                })}
              </Section>
            </View>
          ) : null}
        </View>
      )}

      {/* 落後提醒 */}
      {behind.length > 0 ? (
        <Section>
          <Row
            title={`有 ${behind.length} 項任務需要補上`}
            subtitle="到「進度」查看並重新安排到之後的讀書日"
            showChevron
            onPress={() => router.navigate('/progress')}
          />
        </Section>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerAction: { paddingVertical: spacing.sm, paddingLeft: spacing.sm, marginBottom: 6 },
  demoNote: { marginTop: -spacing.md, marginBottom: spacing.lg },
  exam: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    ...shadow.sm,
  },
  countdown: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.xs },
  countdownNumber: { fontSize: 34, fontWeight: '700', color: colors.primary, lineHeight: 40 },
  todayHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  todayHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  sortPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.separator,
  },
  sortPillActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  recommendationSection: {
    marginBottom: spacing.lg,
  },
  recommendationSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
  aiStandaloneBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.primarySoft,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primary,
  },

  progressWrap: { marginBottom: spacing.lg },
  progressMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  statsPills: {
    flex: 1,
  },
  allDoneBox: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.xl,
    marginBottom: spacing.xl,
  },
  emptyTodayWrap: {
    marginBottom: spacing.xl,
  },
  emptyCard: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.xl,
    marginBottom: spacing.lg,
    ...shadow.sm,
  },
  emptyIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  emptyDesc: {
    marginTop: spacing.xs,
    marginBottom: spacing.lg,
    paddingHorizontal: spacing.md,
    lineHeight: 20,
  },
  emptyActions: {
    width: '100%',
  },
  nextDayWrap: {
    marginTop: spacing.sm,
  },
  nextDayHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
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
});
