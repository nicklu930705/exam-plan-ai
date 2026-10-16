import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '../components/AppText';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { Segmented } from '../components/FormControls';
import { Row, Section } from '../components/List';
import { Screen } from '../components/Screen';
import { useToday } from '../hooks/useToday';
import { useAppStore } from '../store/AppStore';
import { computeProgress, tasksForExam } from '../store/selectors';
import { canCreateExam, canUnarchiveExam } from '../subscription/entitlements';
import { colors, spacing } from '../theme';
import type { Exam } from '../types/models';
import { diffDays, formatYearMonthDay } from '../utils/date';

/** 考試與計畫管理列表 */
export default function ExamsScreen() {
  const { data, setSelectedExamId, deleteExam, toggleArchiveExam } = useAppStore();
  const today = useToday();

  const [tab, setTab] = useState<'active' | 'archived'>('active');

  const activeExams = useMemo(
    () =>
      data.exams
        .filter((e) => !e.archived)
        .sort((a, b) => a.examDate.localeCompare(b.examDate)),
    [data.exams],
  );

  const archivedExams = useMemo(
    () =>
      data.exams
        .filter((e) => e.archived)
        .sort((a, b) => a.examDate.localeCompare(b.examDate)),
    [data.exams],
  );

  const currentList = tab === 'active' ? activeExams : archivedExams;

  const viewExamPlan = (exam: Exam) => {
    setSelectedExamId(exam.id);
    router.push({ pathname: '/(tabs)/plan', params: { examId: exam.id } });
  };

  const editExam = (exam: Exam) => {
    router.push({ pathname: '/exam/edit', params: { id: exam.id } });
  };

  const handleToggleArchive = (exam: Exam) => {
    if (exam.archived) {
      const check = canUnarchiveExam(data);
      if (!check.allowed) {
        Alert.alert('已達方案上限', check.reason, [
          { text: '稍後再說', style: 'cancel' },
          { text: '查看會員方案', onPress: () => router.push('/subscription') },
        ]);
        return;
      }
      toggleArchiveExam(exam.id);
      Alert.alert('已解除封存', `「${exam.name}」已成功恢復為進行中考試。`);
    } else {
      toggleArchiveExam(exam.id);
      Alert.alert(
        '已封存考試',
        `「${exam.name}」已移至封存，歷史紀錄仍完整保留，但不會出現在今日讀書計畫中。`,
      );
    }
  };

  const confirmDelete = (exam: Exam) => {
    const tasks = tasksForExam(data.tasks, exam.id);
    const completedTasks = tasks.filter((t) => t.status === 'done');

    Alert.alert(
      `確定刪除「${exam.name}」？`,
      `刪除後將會：\n• 移除該場考試所有資料\n• 刪除全部 ${tasks.length} 項讀書任務（包含 ${completedTasks.length} 項已完成打卡）\n• 清除相關研讀累計時間與統計\n\n此動作無法復原，是否確定刪除？`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: exam.archived ? '解除封存' : '改為封存考試',
          onPress: () => {
            handleToggleArchive(exam);
          },
        },
        {
          text: '確認刪除',
          style: 'destructive',
          onPress: () => deleteExam(exam.id),
        },
      ],
    );
  };

  const handleCreateExam = () => {
    const check = canCreateExam(data);
    if (!check.allowed) {
      Alert.alert('已達免費版上限', check.reason, [
        { text: '稍後再說', style: 'cancel' },
        { text: '查看會員方案', onPress: () => router.push('/subscription') },
      ]);
      return;
    }
    router.push('/exam/new');
  };

  const footer = <Button title="建立新考試" onPress={handleCreateExam} />;

  if (data.exams.length === 0) {
    return (
      <Screen bottomInset footer={footer}>
        <EmptyState
          title="目前沒有考試計畫"
          message="建立考試並輸入科目後，可在這裡管理、編輯與查看每場考試的每日讀書計畫。"
          actionTitle="建立第一場考試"
          onAction={handleCreateExam}
        />
      </Screen>
    );
  }

  return (
    <Screen bottomInset footer={footer}>
      {/* 標籤切換（若有封存考試時顯示） */}
      {archivedExams.length > 0 ? (
        <View style={styles.segmentWrap}>
          <Segmented
            options={[
              { value: 'active', label: `進行中 (${activeExams.length})` },
              { value: 'archived', label: `已封存 (${archivedExams.length})` },
            ]}
            value={tab}
            onChange={setTab}
          />
        </View>
      ) : null}

      <Section
        title={tab === 'active' ? `進行中考試 (${activeExams.length} 場)` : `已封存考試 (${archivedExams.length} 場)`}
        footer="點選進入每日計畫；鉛筆編輯；資料夾封存／復原；垃圾桶刪除。"
      >
        {currentList.length === 0 ? (
          <View style={styles.emptyWrap}>
            <AppText secondary>目前沒有{tab === 'active' ? '進行中' : '已封存'}的考試計畫。</AppText>
          </View>
        ) : (
          currentList.map((exam) => {
            const days = diffDays(today, exam.examDate);
            const tasks = tasksForExam(data.tasks, exam.id);
            const p = computeProgress(tasks);
            const when = days > 0 ? `還有 ${days} 天` : days === 0 ? '今天考試' : '已結束';

            const actionButtons = (
              <View style={styles.actionRow}>
                <Pressable
                  hitSlop={8}
                  onPress={() => editExam(exam)}
                  style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}
                  accessibilityRole="button"
                  accessibilityLabel={`編輯${exam.name}`}
                >
                  <Ionicons name="create-outline" size={20} color={colors.primary} />
                </Pressable>

                <Pressable
                  hitSlop={8}
                  onPress={() => handleToggleArchive(exam)}
                  style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}
                  accessibilityRole="button"
                  accessibilityLabel={exam.archived ? `解除封存${exam.name}` : `封存${exam.name}`}
                >
                  <Ionicons
                    name={exam.archived ? 'arrow-undo-outline' : 'archive-outline'}
                    size={20}
                    color={exam.archived ? colors.primary : colors.textSecondary}
                  />
                </Pressable>

                <Pressable
                  hitSlop={8}
                  onPress={() => confirmDelete(exam)}
                  style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}
                  accessibilityRole="button"
                  accessibilityLabel={`刪除${exam.name}`}
                >
                  <Ionicons name="trash-outline" size={20} color={colors.textSecondary} />
                </Pressable>
              </View>
            );

            return (
              <Row
                key={exam.id}
                title={exam.name}
                subtitle={`${formatYearMonthDay(exam.examDate)} · ${exam.subjects.length} 科 · ${tasks.length} 項任務 (${p.doneCount}/${p.totalCount} 完成)`}
                value={when}
                showChevron
                right={actionButtons}
                onPress={() => viewExamPlan(exam)}
              />
            );
          })
        )}
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({
  segmentWrap: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  emptyWrap: {
    padding: spacing.lg,
    alignItems: 'center',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginLeft: spacing.sm,
  },
  iconBtn: {
    padding: spacing.xs,
  },
});
