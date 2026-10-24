import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ActiveTimerBanner } from '../../components/ActiveTimerBanner';
import { AiAdviceCard } from '../../components/AiAdviceCard';
import { AppText } from '../../components/AppText';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Segmented } from '../../components/FormControls';
import { Section } from '../../components/List';
import { Screen } from '../../components/Screen';
import { ScreenHeader } from '../../components/ScreenHeader';
import { TaskRow } from '../../components/TaskRow';
import { useStudyTimer } from '../../hooks/useStudyTimer';
import { useToday } from '../../hooks/useToday';
import {
  logDiagnostic,
  requestAiStudyAdvice,
  type AiAdviceServiceResult,
} from '../../services/aiAdviceService';
import { useAppStore } from '../../store/AppStore';
import {
  computeProgress,
  getActiveExamById,
  getBehindTasks,
  getSubject,
  getUpcomingExam,
  groupByDate,
  sumMinutes,
  tasksForDate,
  tasksForExam,
} from '../../store/selectors';
import { colors, MIN_TOUCH, radius, shadow, spacing } from '../../theme';
import {
  addDays,
  formatFullDate,
  formatMinutes,
  formatMonthDay,
  formatYearMonthDay,
  startOfWeek,
  weekdayOf,
} from '../../utils/date';

export default function PlanScreen() {
  const { data, setTaskStatus, setSelectedExamId, recordAiUsage } = useAppStore();
  const today = useToday();
  const { activeTimer, formattedTime, startTimer } = useStudyTimer();
  const thisWeek = startOfWeek(today);

  const params = useLocalSearchParams<{ examId?: string }>();

  // 使用者手動選取的考試與自訂週（無手動指定時以全域選定或路由參數作為預設）
  const [userSelectedExamId, setUserSelectedExamId] = useState<string | undefined>();
  const [viewMode, setViewMode] = useState<'week' | 'all'>('week');
  const [customWeekStart, setCustomWeekStart] = useState<string | null>(null);

  // AI 讀書教練建議狀態
  const [aiAdviceResult, setAiAdviceResult] = useState<AiAdviceServiceResult | null>(null);
  const [isLoadingAi, setIsLoadingAi] = useState<boolean>(false);
  const [showAiSection, setShowAiSection] = useState<boolean>(false);

  const activeExams = useMemo(() => data.exams.filter((e) => !e.archived), [data.exams]);
  const activeExamIds = useMemo(() => new Set(activeExams.map((e) => e.id)), [activeExams]);
  const hasArchivedExams = useMemo(() => data.exams.some((e) => e.archived), [data.exams]);

  // 優先選取邏輯：
  // 1. 使用者手動在 Chips 選擇的考試 (userSelectedExamId，須為進行中)
  // 2. 路由參數 params.examId (建立考試或連結跳轉，須為進行中)
  // 3. 全域 store.selectedExamId (剛建立或切換之考試，須為進行中)
  // 4. 真正有排程任務的進行中考試
  // 5. 即將到來的進行中考試 (getUpcomingExam)
  // 6. 第一場進行中考試 (activeExams[0])
  const examWithTasks = activeExams.find((e) => tasksForExam(data.tasks, e.id).length > 0);
  const fallbackExamId =
    getActiveExamById(data, data.selectedExamId)?.id ??
    examWithTasks?.id ??
    getUpcomingExam(data, today)?.id ??
    activeExams[0]?.id;
  const candidateId = userSelectedExamId ?? params.examId;
  const activeExamId = candidateId && activeExamIds.has(candidateId) ? candidateId : fallbackExamId;
  const selectedExam = getActiveExamById(data, activeExamId) ?? examWithTasks ?? activeExams[0];
  const relevantTasks = useMemo(
    () => (selectedExam ? tasksForExam(data.tasks, selectedExam.id) : []),
    [selectedExam, data.tasks],
  );

  // 確保任務依日期嚴格排序
  const sortedTasks = useMemo(
    () => [...relevantTasks].sort((a, b) => a.date.localeCompare(b.date)),
    [relevantTasks],
  );

  // 計算預設聚焦週：優先鎖定包含今天或最早未來任務的週
  const firstFutureTask = sortedTasks.find((t) => t.date >= today) ?? sortedTasks[0];
  const defaultWeek = firstFutureTask ? startOfWeek(firstFutureTask.date) : thisWeek;
  const weekStart = customWeekStart ?? defaultWeek;

  // 避免極速連擊重複請求與非同步切換競態
  const isRequestingAiRef = useRef<boolean>(false);
  const activeRequestIdRef = useRef<number>(0);
  const currentExamIdRef = useRef<string | undefined>(selectedExam?.id);
  useEffect(() => {
    currentExamIdRef.current = selectedExam?.id;
  }, [selectedExam?.id]);

  const handleFetchAiAdvice = async () => {
    logDiagnostic('AI_BUTTON_PRESSED', { examName: selectedExam?.name, screen: 'plan' });
    if (!selectedExam || isRequestingAiRef.current || isLoadingAi) return;

    isRequestingAiRef.current = true;
    const requestedExamId = selectedExam.id;
    const requestId = ++activeRequestIdRef.current;
    setIsLoadingAi(true);
    setShowAiSection(true);
    setAiAdviceResult(null);
    logDiagnostic('AI_LOADING_STARTED', { screen: 'plan' });

    try {
      const examTasks = tasksForExam(data.tasks, selectedExam.id);
      const completedTasks = examTasks.filter((t) => t.status === 'done');
      const behindTasks = getBehindTasks(examTasks, today);

      const completionRate =
        examTasks.length > 0
          ? Math.round((completedTasks.length / examTasks.length) * 100)
          : 0;

      const subjectsInput = selectedExam.subjects.map((s) => {
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
          examName: selectedExam.name,
          examDate: selectedExam.examDate,
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

      // 檢查非同步回應競態：避免使用者切換考試時舊回應覆蓋畫面
      if (activeRequestIdRef.current === requestId && currentExamIdRef.current === requestedExamId) {
        setAiAdviceResult(result);
      }
    } catch (err: any) {
      logDiagnostic('AI_REQUEST_FAILED', {
        screen: 'plan',
        error: err?.message || '網路連線失敗，請檢查 iPhone 網路連線。',
      });
      if (activeRequestIdRef.current === requestId && currentExamIdRef.current === requestedExamId) {
        setAiAdviceResult({
          success: false,
          status: 'network_error',
          source: 'fallback_rule_engine',
          disclaimer: 'AI 建議僅供學習策略與心理激勵參考。',
          error: err?.message || '網路連線失敗，請檢查 iPhone 網路連線。',
        });
      }
    } finally {
      // 確保在成功、失敗、逾時所有情況下均同步釋放鎖；舊請求完成不得錯誤解除新請求之鎖
      if (activeRequestIdRef.current === requestId) {
        isRequestingAiRef.current = false;
        setIsLoadingAi(false);
        logDiagnostic('AI_LOADING_FINISHED', { screen: 'plan' });
      }
    }
  };

  if (activeExams.length === 0) {
    if (hasArchivedExams) {
      return (
        <Screen topInset>
          <ScreenHeader title="讀書計畫" />
          <EmptyState
            title="所有考試皆已封存"
            message="目前沒有進行中的讀書計畫。你可以建立新考試，或至「管理考試」解除封存舊目標。"
            actionTitle="建立新考試"
            onAction={() => router.push('/exam/new')}
          />
          <View style={{ alignItems: 'center', marginTop: spacing.md }}>
            <Button
              title="前往管理已封存考試"
              variant="plain"
              onPress={() => router.push('/exams')}
            />
          </View>
        </Screen>
      );
    }

    return (
      <Screen topInset>
        <ScreenHeader title="讀書計畫" />
        <EmptyState
          title="還沒有讀書計畫"
          message="建立考試後，每天的讀書任務會依日期列在這裡。"
          actionTitle="建立考試"
          onAction={() => router.push('/exam/new')}
        />
      </Screen>
    );
  }

  console.log('[讀書計畫頁] 載入計畫狀態：', {
    selectedExamId: activeExamId,
    selectedExamName: selectedExam?.name,
    totalTasksCount: relevantTasks.length,
    firstTaskId: relevantTasks[0]?.id,
    viewMode,
  });

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const weekEnd = days[6];
  const isThisWeek = weekStart === thisWeek;

  // 全部日程群組列表
  const allDateGroups = groupByDate(sortedTasks);

  return (
    <Screen topInset>
      <ScreenHeader
        title="讀書計畫"
        subtitle={selectedExam ? `${selectedExam.name} (${formatYearMonthDay(selectedExam.examDate)})` : undefined}
        subtitlePosition="below"
        right={
          selectedExam ? (
            <Pressable
              onPress={() =>
                router.push({ pathname: '/exam/edit', params: { id: selectedExam.id } })
              }
              hitSlop={8}
              style={styles.editExamBtn}
              accessibilityRole="button"
              accessibilityLabel={`編輯${selectedExam.name}`}
            >
              <Ionicons name="create-outline" size={16} color={colors.primary} />
              <AppText variant="footnote" color={colors.primary} style={{ fontWeight: '600' }}>
                編輯考試
              </AppText>
            </Pressable>
          ) : null
        }
      />

      <ActiveTimerBanner />

      {/* 考試選擇器（若有多場進行中考試時顯示供快速切換） */}
      {activeExams.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.examTabs}
        >
          {activeExams.map((e) => {
            const isSelected = e.id === activeExamId;
            return (
              <Pressable
                key={e.id}
                onPress={() => {
                  setUserSelectedExamId(e.id);
                  setSelectedExamId(e.id);
                  setCustomWeekStart(null);
                  setAiAdviceResult(null);
                  setIsLoadingAi(false);
                  setShowAiSection(false);
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

      {/* ───── AI 讀書建議區塊 ───── */}
      {selectedExam ? (
        <View style={styles.aiSectionContainer}>
          {showAiSection ? (
            <AiAdviceCard
              advice={aiAdviceResult?.advice}
              source={aiAdviceResult?.source ?? 'openai_ai'}
              status={aiAdviceResult?.status}
              isLoading={isLoadingAi}
              error={aiAdviceResult?.error}
              errorCode={aiAdviceResult?.errorCode}
              examName={selectedExam.name}
              disclaimer={aiAdviceResult?.disclaimer}
              quotaStatus={aiAdviceResult?.quotaStatus}
              quota={aiAdviceResult?.quota}
              note={aiAdviceResult?.note}
              onRefresh={handleFetchAiAdvice}
              onRetry={handleFetchAiAdvice}
              onDismiss={() => setShowAiSection(false)}
            />
          ) : (
            <Pressable
              onPress={handleFetchAiAdvice}
              disabled={isLoadingAi}
              style={({ pressed }) => [styles.aiBannerPill, pressed && { opacity: 0.8 }]}
              accessibilityRole="button"
              accessibilityLabel={`取得${selectedExam.name}的 AI 讀書建議`}
            >
              <View style={styles.aiBannerLeft}>
                <View style={styles.aiSparkleIconWrap}>
                  <Ionicons name="sparkles" size={16} color={colors.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <AppText variant="subhead" style={{ fontWeight: '600' }}>
                      AI 讀書教練建議
                    </AppText>
                    <View style={styles.aiTagBadge}>
                      <AppText variant="caption" color={colors.primary} style={{ fontWeight: '700' }}>
                        ✦ AI 建議
                      </AppText>
                    </View>
                  </View>
                  <AppText variant="footnote" secondary style={{ marginTop: 2 }}>
                    結合各科掌握度、{relevantTasks.length} 項任務與考期倒數，生成衝刺策略
                  </AppText>
                </View>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.primary} />
            </Pressable>
          )}
        </View>
      ) : null}

      {/* 檢視模式切換：週檢視 vs 全部日程 */}
      <View style={styles.viewModeWrap}>
        <Segmented
          options={[
            { value: 'week', label: '週檢視' },
            { value: 'all', label: `全部日程 (${relevantTasks.length} 項)` },
          ]}
          value={viewMode}
          onChange={setViewMode}
        />
      </View>

      {/* ───── 週檢視模式 ───── */}
      {viewMode === 'week' ? (
        <>
          {/* 週切換導覽 */}
          <View style={styles.weekNav}>
            <Pressable
              onPress={() => setCustomWeekStart(addDays(weekStart, -7))}
              accessibilityRole="button"
              accessibilityLabel="上一週"
              style={styles.navBtn}
            >
              <Ionicons name="chevron-back" size={22} color={colors.primary} />
            </Pressable>
            <View style={styles.weekLabel}>
              <AppText variant="headline">
                {formatMonthDay(weekStart)} – {formatMonthDay(weekEnd)}
              </AppText>
              <Pressable
                onPress={() => setCustomWeekStart(thisWeek)}
                disabled={isThisWeek}
                accessibilityRole="button"
                hitSlop={8}
              >
                <AppText variant="footnote" color={isThisWeek ? colors.textSecondary : colors.primary}>
                  {isThisWeek ? '本週' : '回到本週'}
                </AppText>
              </Pressable>
            </View>
            <Pressable
              onPress={() => setCustomWeekStart(addDays(weekStart, 7))}
              accessibilityRole="button"
              accessibilityLabel="下一週"
              style={styles.navBtn}
            >
              <Ionicons name="chevron-forward" size={22} color={colors.primary} />
            </Pressable>
          </View>

          {/* 依日期分組的任務列表 */}
          {days.map((date) => {
            const dayTasks = tasksForDate(relevantTasks, date);
            const examToday = selectedExam?.examDate === date;
            const isRest = data.preferences.restDays.includes(weekdayOf(date));
            const isToday = date === today;

            return (
              <View key={date} style={styles.day}>
                <View style={styles.dayHeader}>
                  <View style={styles.dayTitle}>
                    <AppText variant="headline">{formatFullDate(date)}</AppText>
                    {isToday ? (
                      <View style={styles.todayTag}>
                        <AppText variant="caption" color={colors.primary}>
                          今天
                        </AppText>
                      </View>
                    ) : null}
                  </View>
                  {dayTasks.length > 0 ? (
                    <AppText variant="footnote" secondary>
                      {computeProgress(dayTasks).doneCount > 0
                        ? `${computeProgress(dayTasks).doneCount}/${dayTasks.length} 完成 · `
                        : ''}
                      {formatMinutes(sumMinutes(dayTasks))}
                    </AppText>
                  ) : null}
                </View>

                {examToday ? (
                  <AppText variant="subhead" color={colors.primary} style={styles.dayNote}>
                    考試日：{selectedExam.name}
                  </AppText>
                ) : null}

                {dayTasks.length > 0 ? (
                  <Section>
                    {dayTasks.map((task) => {
                      const taskSub = getSubject(data, task.subjectId);
                      const taskChapter = taskSub?.chapters.find((c) => c.id === task.chapterId);
                      const isTiming = activeTimer?.taskId === task.id;

                      return (
                        <TaskRow
                          key={task.id}
                          task={task}
                          examName={selectedExam?.name}
                          overdue={task.date < today}
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
                ) : !examToday ? (
                  <AppText variant="subhead" secondary style={styles.dayNote}>
                    {isRest ? '休息日' : '沒有安排任務'}
                  </AppText>
                ) : null}
              </View>
            );
          })}
        </>
      ) : (
        /* ───── 全部日程模式 ───── */
        <View style={styles.allViewWrap}>
          {allDateGroups.length > 0 ? (
            allDateGroups.map(({ date, tasks: dayTasks }) => {
              const isToday = date === today;
              const isPast = date < today;
              return (
                <View key={date} style={styles.day}>
                  <View style={styles.dayHeader}>
                    <View style={styles.dayTitle}>
                      <AppText variant="headline">{formatFullDate(date)}</AppText>
                      {isToday ? (
                        <View style={styles.todayTag}>
                          <AppText variant="caption" color={colors.primary}>
                            今天
                          </AppText>
                        </View>
                      ) : null}
                    </View>
                    <AppText variant="footnote" secondary>
                      {computeProgress(dayTasks).doneCount > 0
                        ? `${computeProgress(dayTasks).doneCount}/${dayTasks.length} 完成 · `
                        : ''}
                      {formatMinutes(sumMinutes(dayTasks))}
                    </AppText>
                  </View>
                  <Section>
                    {dayTasks.map((task) => {
                      const taskSub = getSubject(data, task.subjectId);
                      const taskChapter = taskSub?.chapters.find((c) => c.id === task.chapterId);
                      const isTiming = activeTimer?.taskId === task.id;

                      return (
                        <TaskRow
                          key={task.id}
                          task={task}
                          examName={selectedExam?.name}
                          overdue={isPast}
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
              );
            })
          ) : (
            <EmptyState
              title="尚未產生任務"
              message="這場考試目前沒有安排的任務，請點擊重新安排計畫。"
              actionTitle="重新安排計畫"
              onAction={() => router.push('/reschedule')}
            />
          )}
        </View>
      )}
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
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  examChipSelected: {
    backgroundColor: colors.primary,
  },
  viewModeWrap: {
    marginBottom: spacing.lg,
  },
  weekNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xl,
  },
  navBtn: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: colors.primarySoft,
  },
  weekLabel: { alignItems: 'center', gap: 2 },
  day: { marginBottom: spacing.md },
  dayHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  dayTitle: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  todayTag: {
    backgroundColor: colors.primarySoft,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  dayNote: { marginBottom: spacing.lg, paddingHorizontal: spacing.xs },
  allViewWrap: {
    marginBottom: spacing.xl,
  },
  editExamBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.primarySoft,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.pill,
  },
  aiSectionContainer: {
    marginBottom: spacing.md,
  },
  aiBannerPill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.primarySoft,
    ...shadow.sm,
  },
  aiBannerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    flex: 1,
    paddingRight: spacing.sm,
  },
  aiSparkleIconWrap: {
    width: 38,
    height: 38,
    borderRadius: radius.pill,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  aiTagBadge: {
    backgroundColor: colors.primarySoft,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
});
