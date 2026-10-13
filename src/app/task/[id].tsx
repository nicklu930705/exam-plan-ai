import DateTimePicker from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '../../components/AppText';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Row, Section } from '../../components/List';
import { Screen } from '../../components/Screen';
import { TimeAdjustmentModal } from '../../components/TimeAdjustmentModal';
import { TASK_KIND_LABELS, TASK_STATUS_LABELS } from '../../constants/labels';
import { useStudyTimer } from '../../hooks/useStudyTimer';
import { useToday } from '../../hooks/useToday';
import { useAppStore } from '../../store/AppStore';
import { getExamById, getSubject } from '../../store/selectors';
import { colors, radius, spacing } from '../../theme';
import { formatMinutes, parseISODate, toISODate } from '../../utils/date';

export default function TaskDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const {
    data,
    setTaskStatus,
    setTaskMinutes,
    setTaskActualMinutes,
    setTaskDate,
    deleteTask,
  } = useAppStore();
  const today = useToday();

  const {
    activeTimer,
    formattedTime,
    isRunning,
    startTimer,
    pauseTimer,
    resumeTimer,
    stopTimer,
    discardTimer,
  } = useStudyTimer();

  const task = data.tasks.find((t) => t.id === id);
  const taskDate = task?.date;

  const [modalType, setModalType] = useState<'estimated' | 'actual' | null>(null);

  const currentDateEstimatedTotal = taskDate
    ? data.tasks
        .filter((t) => t.date === taskDate)
        .reduce((sum, t) => sum + t.estimatedMinutes, 0)
    : 0;

  if (!task) {
    return (
      <Screen bottomInset>
        <EmptyState
          title="找不到這項任務"
          message="這項任務可能已經被刪除。"
          actionTitle="返回"
          onAction={() => router.back()}
        />
      </Screen>
    );
  }

  const subject = getSubject(data, task.subjectId);
  const exam = getExamById(data, task.examId);
  const chapter = subject?.chapters.find((c) => c.id === task.chapterId);
  const done = task.status === 'done';
  const flagged = task.status === 'needsReschedule';
  const overdue = !done && task.date < today;

  const isTimingThisTask = activeTimer?.taskId === task.id;

  const onDateChange = (_: unknown, selectedDate?: Date) => {
    if (!selectedDate) return;
    const iso = toISODate(selectedDate);
    if (exam && iso > exam.examDate) {
      Alert.alert('日期限制', '任務預定日期不得晚於考試日期。');
      return;
    }
    setTaskDate(task.id, iso);
  };

  const confirmDelete = () => {
    Alert.alert(`刪除「${task.title}」？`, '此任務將被移除且無法復原。', [
      { text: '取消', style: 'cancel' },
      {
        text: '刪除',
        style: 'destructive',
        onPress: () => {
          if (isTimingThisTask) {
            discardTimer();
          }
          deleteTask(task.id);
          if (router.canGoBack()) {
            router.back();
          } else {
            router.replace('/(tabs)/plan');
          }
        },
      },
    ]);
  };

  const handleStopTimer = (markAsDone: boolean = false) => {
    Alert.alert(
      '結束計時並儲存時間？',
      `本次研讀時間：${formattedTime}\n${markAsDone ? '並將此任務標記為完成。' : '將時間累計至實際讀書時間中。'}`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '確定結束',
          onPress: () => stopTimer(task.id, markAsDone),
        },
      ],
    );
  };

  return (
    <Screen
      bottomInset
      footer={
        <Button
          title={done ? '恢復為未完成' : '標記完成'}
          variant={done ? 'secondary' : 'primary'}
          onPress={() => setTaskStatus(task.id, done ? 'pending' : 'done')}
        />
      }
    >
      <View style={styles.head}>
        <AppText variant="footnote" secondary>
          {[exam?.name, subject?.name, chapter?.title, TASK_KIND_LABELS[task.kind]]
            .filter(Boolean)
            .join(' · ')}
        </AppText>
        <AppText variant="title" style={{ marginTop: spacing.xs }}>
          {task.title}
        </AppText>
        {overdue || flagged ? (
          <AppText variant="subhead" color={colors.warning} style={{ marginTop: spacing.sm }}>
            {flagged ? '已標記需要重新安排' : '這項任務已經超過預定日期'}
          </AppText>
        ) : null}
      </View>

      {/* ───── 讀書專注計時器 ───── */}
      <Section title="讀書專注計時">
        <View style={styles.timerCard}>
          <View style={styles.timerHeader}>
            <View style={styles.timerBadge}>
              <Ionicons
                name={isTimingThisTask ? (isRunning ? 'time' : 'pause') : 'stopwatch-outline'}
                size={16}
                color={isTimingThisTask ? colors.primary : colors.textSecondary}
              />
              <AppText
                variant="footnote"
                color={isTimingThisTask ? colors.primary : colors.textSecondary}
                style={{ fontWeight: '600' }}
              >
                {isTimingThisTask
                  ? isRunning
                    ? '專注研讀中'
                    : '計時已暫停'
                  : '專注計時鐘'}
              </AppText>
            </View>
            {task.actualMinutes && task.actualMinutes > 0 ? (
              <AppText variant="footnote" secondary>
                累計實讀：{formatMinutes(task.actualMinutes)}
              </AppText>
            ) : null}
          </View>

          {/* 計時數字 */}
          <View style={styles.timerBody}>
            <AppText style={styles.timerDigits}>
              {isTimingThisTask ? formattedTime : '00:00'}
            </AppText>
            <AppText variant="footnote" secondary style={{ marginTop: 2 }}>
              預估 {formatMinutes(task.estimatedMinutes)} · 實際與預估分開保存
            </AppText>
          </View>

          {/* 計時控制按鈕 */}
          <View style={styles.timerActions}>
            {!isTimingThisTask ? (
              <Button
                title={done ? '重新計時讀書' : '開始專注讀書計時'}
                variant="primary"
                onPress={() => startTimer(task.id)}
              />
            ) : (
              <View style={{ gap: spacing.sm }}>
                <View style={styles.buttonRow}>
                  <View style={{ flex: 1 }}>
                    <Button
                      title={isRunning ? '暫停計時' : '繼續計時'}
                      variant="secondary"
                      onPress={isRunning ? pauseTimer : resumeTimer}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Button
                      title="結束並儲存時間"
                      variant="primary"
                      onPress={() => handleStopTimer(false)}
                    />
                  </View>
                </View>
                {!done ? (
                  <Button
                    title="結束計時並標記完成"
                    variant="plain"
                    onPress={() => handleStopTimer(true)}
                  />
                ) : null}
              </View>
            )}
          </View>
        </View>
      </Section>

      <Section title="基本資訊">
        <Row
          title="所屬考試"
          value={exam?.name ?? '未指定'}
        />
        <Row
          title="科目與章節"
          value={[subject?.name, chapter?.title].filter(Boolean).join(' · ')}
        />
        <Row
          title="預定日期"
          right={
            <DateTimePicker
              value={parseISODate(task.date)}
              mode="date"
              display="compact"
              locale="zh-TW"
              accentColor={colors.primary}
              themeVariant="light"
              maximumDate={exam ? parseISODate(exam.examDate) : undefined}
              onChange={onDateChange}
            />
          }
        />
        <Row title="狀態" value={TASK_STATUS_LABELS[task.status]} />
        {task.completedAt ? (
          <Row title="完成時間" value={new Date(task.completedAt).toLocaleString('zh-TW', { hour12: false })} />
        ) : null}
      </Section>

      <Section
        title="讀書時間設定"
        footer="預估時間為排程規劃依據；實際時間為真實研讀量。點選「自訂」可輸入任意分鐘數或選取常用時間。"
      >
        <Row
          title="預估時間"
          subtitle="排程基準，點擊可自訂分鐘數"
          right={
            <View style={styles.timeControlRow}>
              <Pressable
                onPress={() => setTaskMinutes(task.id, Math.max(1, task.estimatedMinutes - 5))}
                disabled={task.estimatedMinutes <= 1}
                hitSlop={8}
                style={[styles.miniStepBtn, task.estimatedMinutes <= 1 && { opacity: 0.3 }]}
                accessibilityLabel="減少預估5分鐘"
              >
                <Ionicons name="remove" size={16} color={colors.primary} />
              </Pressable>
              <AppText variant="headline" style={styles.timeValueText}>
                {formatMinutes(task.estimatedMinutes)}
              </AppText>
              <Pressable
                onPress={() => setTaskMinutes(task.id, Math.min(720, task.estimatedMinutes + 5))}
                hitSlop={8}
                style={styles.miniStepBtn}
                accessibilityLabel="增加預估5分鐘"
              >
                <Ionicons name="add" size={16} color={colors.primary} />
              </Pressable>
              <Pressable
                onPress={() => setModalType('estimated')}
                style={styles.customPill}
                accessibilityRole="button"
                accessibilityLabel="自訂預估時間"
              >
                <AppText variant="caption" color={colors.onPrimary} style={{ fontWeight: '600' }}>
                  自訂
                </AppText>
              </Pressable>
            </View>
          }
        />
        <Row
          title="實際研讀時間"
          subtitle={
            task.timerMinutes && task.timerMinutes > 0
              ? `含計時 ${formatMinutes(task.timerMinutes)}，點擊自訂修正`
              : '真實研讀紀錄，點擊可自訂分鐘數'
          }
          right={
            <View style={styles.timeControlRow}>
              <Pressable
                onPress={() =>
                  setTaskActualMinutes(task.id, Math.max(0, (task.actualMinutes ?? 0) - 5))
                }
                disabled={(task.actualMinutes ?? 0) <= 0}
                hitSlop={8}
                style={[styles.miniStepBtn, (task.actualMinutes ?? 0) <= 0 && { opacity: 0.3 }]}
                accessibilityLabel="減少實讀5分鐘"
              >
                <Ionicons name="remove" size={16} color={colors.primary} />
              </Pressable>
              <AppText variant="headline" style={styles.timeValueText}>
                {formatMinutes(task.actualMinutes ?? 0)}
              </AppText>
              <Pressable
                onPress={() =>
                  setTaskActualMinutes(task.id, Math.min(720, (task.actualMinutes ?? 0) + 5))
                }
                hitSlop={8}
                style={styles.miniStepBtn}
                accessibilityLabel="增加實讀5分鐘"
              >
                <Ionicons name="add" size={16} color={colors.primary} />
              </Pressable>
              <Pressable
                onPress={() => setModalType('actual')}
                style={styles.customPill}
                accessibilityRole="button"
                accessibilityLabel="自訂實際時間"
              >
                <AppText variant="caption" color={colors.onPrimary} style={{ fontWeight: '600' }}>
                  自訂
                </AppText>
              </Pressable>
            </View>
          }
        />
      </Section>

      <Section
        title="計畫操作"
        footer="標記後，這項任務會出現在「進度」頁的待補清單，之後可以點選重新安排一起調整。"
      >
        {!done ? (
          <Row
            title={flagged ? '取消重新安排標記' : '標記為需要重新安排'}
            onPress={() => setTaskStatus(task.id, flagged ? 'pending' : 'needsReschedule')}
          />
        ) : null}
        <Row title="刪除此任務" destructive onPress={confirmDelete} />
      </Section>

      {/* 自訂時間彈窗 */}
      {modalType !== null ? (
        <TimeAdjustmentModal
          key={`${modalType}-${modalType === 'estimated' ? task.estimatedMinutes : (task.actualMinutes ?? 0)}`}
          visible={modalType !== null}
          type={modalType}
          currentValue={
            modalType === 'estimated' ? task.estimatedMinutes : (task.actualMinutes ?? 0)
          }
          timerMinutes={task.timerMinutes ?? 0}
          taskTitle={task.title}
          date={task.date}
          dailyMinutesLimit={data.preferences.dailyMinutes}
          currentDateEstimatedTotal={currentDateEstimatedTotal}
          onSave={(newMinutes) => {
            if (modalType === 'estimated') {
              setTaskMinutes(task.id, newMinutes);
            } else {
              setTaskActualMinutes(task.id, newMinutes);
            }
          }}
          onClose={() => setModalType(null)}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { marginBottom: spacing.xl },
  timerCard: {
    backgroundColor: colors.surface,
    padding: spacing.lg,
    borderRadius: radius.md,
  },
  timerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  timerBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.primarySoft,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  timerBody: {
    alignItems: 'center',
    paddingVertical: spacing.md,
  },
  timerDigits: {
    fontSize: 48,
    lineHeight: 56,
    fontWeight: '700',
    color: colors.primary,
    fontVariant: ['tabular-nums'],
    letterSpacing: 1,
  },
  timerActions: {
    marginTop: spacing.md,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  timeControlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  miniStepBtn: {
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timeValueText: {
    minWidth: 55,
    textAlign: 'center',
    fontSize: 15,
  },
  customPill: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 5,
    borderRadius: radius.pill,
    marginLeft: 2,
  },
});
