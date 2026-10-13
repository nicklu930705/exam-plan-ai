import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ActiveTimerBanner } from '../../components/ActiveTimerBanner';
import { AppText } from '../../components/AppText';
import { EmptyState } from '../../components/EmptyState';
import { Segmented } from '../../components/FormControls';
import { Section } from '../../components/List';
import { Screen } from '../../components/Screen';
import { ScreenHeader } from '../../components/ScreenHeader';
import { TaskRow } from '../../components/TaskRow';
import { useStudyTimer } from '../../hooks/useStudyTimer';
import { useToday } from '../../hooks/useToday';
import { useAppStore } from '../../store/AppStore';
import {
  computeProgress,
  getExamById,
  getSubject,
  getUpcomingExam,
  groupByDate,
  sumMinutes,
  tasksForDate,
  tasksForExam,
} from '../../store/selectors';
import { colors, MIN_TOUCH, radius, spacing } from '../../theme';
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
  const { data, setTaskStatus, setSelectedExamId } = useAppStore();
  const today = useToday();
  const { activeTimer, formattedTime, startTimer } = useStudyTimer();
  const thisWeek = startOfWeek(today);

  const params = useLocalSearchParams<{ examId?: string }>();

  // 使用者手動選取的考試與自訂週（無手動指定時以全域選定或路由參數作為預設）
  const [userSelectedExamId, setUserSelectedExamId] = useState<string | undefined>();
  const [viewMode, setViewMode] = useState<'week' | 'all'>('week');
  const [customWeekStart, setCustomWeekStart] = useState<string | null>(null);

  // 優先選取邏輯：
  // 1. 使用者手動在 Chips 選擇的考試 (userSelectedExamId)
  // 2. 路由參數 params.examId (建立考試或連結跳轉)
  // 3. 全域 store.selectedExamId (剛剛建立或切換的考試)
  // 4. 真正有排程任務的考試 (避免預設落入無任務的舊考試)
  // 5. 即將到來的考試 (getUpcomingExam)
  // 6. 第一場考試 (data.exams[0])
  const examWithTasks = data.exams.find((e) => tasksForExam(data.tasks, e.id).length > 0);
  const fallbackExamId =
    data.selectedExamId ??
    examWithTasks?.id ??
    getUpcomingExam(data, today)?.id ??
    data.exams[0]?.id;
  const activeExamId = userSelectedExamId ?? params.examId ?? fallbackExamId;
  const selectedExam = getExamById(data, activeExamId) ?? examWithTasks ?? data.exams[0];
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

  if (data.exams.length === 0) {
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

      {/* 考試選擇器（若有多場考試時顯示供快速切換） */}
      {data.exams.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.examTabs}
        >
          {data.exams.map((e) => {
            const isSelected = e.id === activeExamId;
            return (
              <Pressable
                key={e.id}
                onPress={() => {
                  setUserSelectedExamId(e.id);
                  setSelectedExamId(e.id);
                  setCustomWeekStart(null);
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
});
