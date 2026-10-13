import DateTimePicker from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

import { AppText } from '../../components/AppText';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Segmented, Stepper, TextField, WeekdayPicker } from '../../components/FormControls';
import { Row, Section } from '../../components/List';
import { ProgressBar } from '../../components/ProgressBar';
import { Screen } from '../../components/Screen';
import {
  FAMILIARITY_LABELS,
  INTENSITY_DESCRIPTIONS,
  INTENSITY_LABELS,
} from '../../constants/labels';
import { useToday } from '../../hooks/useToday';
import {
  calculateExamEditReschedule,
  type ExamEditRescheduleResult,
} from '../../scheduler/reschedule';
import { createId, useAppStore } from '../../store/AppStore';
import { countStudyDays, getExamById, tasksForExam } from '../../store/selectors';
import { colors, radius, shadow, spacing } from '../../theme';
import type {
  Exam,
  Familiarity,
  Intensity,
  StudyPreferences,
} from '../../types/models';
import { diffDays, formatMinutes, formatMonthDay, formatYearMonthDay, parseISODate, toISODate } from '../../utils/date';
import {
  hasErrors,
  parseChapters,
  validateExamInfo,
  validateStudyTime,
  validateSubject,
  type ExamInfoErrors,
  type SubjectDraft,
  type SubjectErrors,
} from '../../validation/examForm';

const STEPS = ['考試資訊', '科目與範圍', '讀書時間'] as const;

const FAMILIARITY_OPTIONS = ([1, 2, 3] as Familiarity[]).map((value) => ({
  value,
  label: FAMILIARITY_LABELS[value],
}));

const INTENSITY_OPTIONS = (['light', 'normal', 'intense'] as Intensity[]).map((value) => ({
  value,
  label: INTENSITY_LABELS[value],
}));

export default function EditExamScreen() {
  const { data, updateExam, deleteExam, toggleArchiveExam } = useAppStore();
  const today = useToday();
  const params = useLocalSearchParams<{ id?: string; examId?: string }>();

  const targetId = params.id ?? params.examId ?? data.selectedExamId ?? data.exams[0]?.id;
  const originalExam = useMemo(() => {
    if (!targetId) return undefined;
    return getExamById(data, targetId);
  }, [data, targetId]);

  const existingTasks = useMemo(() => {
    if (!originalExam) return [];
    return tasksForExam(data.tasks, originalExam.id);
  }, [data.tasks, originalExam]);

  // 步驟狀態
  const [step, setStep] = useState(0);

  // 步驟一：考試資訊
  const [name, setName] = useState(() => originalExam?.name ?? '');
  const [examDate, setExamDate] = useState(() => originalExam?.examDate ?? today);
  const [infoErrors, setInfoErrors] = useState<ExamInfoErrors>({});

  // 步驟二：科目
  const [subjects, setSubjects] = useState<SubjectDraft[]>(() => {
    if (!originalExam) return [];
    return originalExam.subjects.map((s) => ({
      id: s.id,
      name: s.name,
      familiarity: s.familiarity,
      chaptersText: s.chapters.map((c) => c.title).join('\n'),
    }));
  });
  const [editor, setEditor] = useState<SubjectDraft | null>(null);
  const [editorIsNew, setEditorIsNew] = useState(false);
  const [editorErrors, setEditorErrors] = useState<SubjectErrors>({});
  const [subjectsError, setSubjectsError] = useState<string>();

  // 步驟三：讀書時間
  const [prefs, setPrefs] = useState<StudyPreferences>(() => ({
    dailyMinutes: data.preferences.dailyMinutes,
    restDays: data.preferences.restDays,
    intensity: data.preferences.intensity,
  }));
  const [studyError, setStudyError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  // 重新排程預覽彈窗狀態
  const [previewPlan, setPreviewPlan] = useState<{
    updatedExam: Exam;
    rescheduleResult: ExamEditRescheduleResult;
  } | null>(null);

  // 判斷是否有變更（用於取消確認，確保所有 hook 在提早返回之前宣告）
  const isDirty = useMemo(() => {
    if (!originalExam) return false;
    if (name.trim() !== originalExam.name) return true;
    if (examDate !== originalExam.examDate) return true;
    if (prefs.dailyMinutes !== data.preferences.dailyMinutes) return true;
    if (prefs.intensity !== data.preferences.intensity) return true;
    if (
      JSON.stringify([...prefs.restDays].sort()) !==
      JSON.stringify([...data.preferences.restDays].sort())
    )
      return true;

    if (subjects.length !== originalExam.subjects.length) return true;
    for (const sub of subjects) {
      const orig = originalExam.subjects.find((s) => s.id === sub.id);
      if (!orig) return true;
      if (orig.name !== sub.name.trim()) return true;
      if (orig.familiarity !== sub.familiarity) return true;
      const parsedCh = parseChapters(sub.chaptersText);
      if (parsedCh.length !== orig.chapters.length) return true;
      for (let i = 0; i < parsedCh.length; i++) {
        if (parsedCh[i] !== orig.chapters[i]?.title) return true;
      }
    }
    return false;
  }, [name, examDate, subjects, prefs, originalExam, data.preferences]);

  if (!originalExam) {
    return (
      <Screen topInset>
        <EmptyState
          title="找不到此場考試"
          message="這場考試可能已被刪除或不存在。"
          actionTitle="返回"
          onAction={() => router.back()}
        />
      </Screen>
    );
  }

  // 取消操作
  const cancel = () => {
    if (!isDirty) {
      router.back();
      return;
    }
    Alert.alert('放棄變更？', '您修改的內容尚未儲存，確定要放棄這些變更嗎？', [
      { text: '繼續編輯', style: 'cancel' },
      { text: '放棄變更', style: 'destructive', onPress: () => router.back() },
    ]);
  };

  // ───── 科目編輯 ─────
  const startNewSubject = () => {
    setEditor({ id: createId('subject'), name: '', familiarity: 2, chaptersText: '' });
    setEditorIsNew(true);
    setEditorErrors({});
    setSubjectsError(undefined);
  };

  const startEditSubject = (s: SubjectDraft) => {
    setEditor({ ...s });
    setEditorIsNew(false);
    setEditorErrors({});
  };

  const saveSubject = () => {
    if (!editor) return;
    const errors = validateSubject(editor, subjects);
    setEditorErrors(errors);
    if (hasErrors(errors)) return;
    const cleaned = { ...editor, name: editor.name.trim() };
    setSubjects((list) =>
      editorIsNew ? [...list, cleaned] : list.map((s) => (s.id === cleaned.id ? cleaned : s)),
    );
    setEditor(null);
  };

  const deleteSubject = () => {
    if (!editor) return;
    Alert.alert(`刪除「${editor.name || '這個科目'}」？`, undefined, [
      { text: '取消', style: 'cancel' },
      {
        text: '刪除',
        style: 'destructive',
        onPress: () => {
          setSubjects((list) => list.filter((s) => s.id !== editor.id));
          setEditor(null);
        },
      },
    ]);
  };

  // ───── 刪除與封存考試 ─────
  const confirmDeleteExam = () => {
    const completedCount = existingTasks.filter((t) => t.status === 'done').length;
    Alert.alert(
      `刪除「${originalExam.name}」？`,
      `刪除後將會：\n• 移除「${originalExam.name}」的全部考試與科目設定\n• 刪除全部 ${existingTasks.length} 項讀書任務（包含 ${completedCount} 項已完成紀錄）\n• 清除相關統計數據與計時\n\n此動作無法復原，是否確定刪除？`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: originalExam.archived ? '取消封存' : '改為封存考試',
          onPress: () => {
            toggleArchiveExam(originalExam.id);
            Alert.alert(
              originalExam.archived ? '已解除封存' : '已封存考試',
              originalExam.archived
                ? '此場考試已恢復至進行中。'
                : '此場考試已移至封存，歷史紀錄仍保留，但不會顯示在首頁的待讀清單中。',
              [{ text: '好', onPress: () => router.back() }],
            );
          },
        },
        {
          text: '確認刪除',
          style: 'destructive',
          onPress: () => {
            deleteExam(originalExam.id);
            router.back();
          },
        },
      ],
    );
  };

  // ───── 下一步與儲存流程 ─────
  const next = () => {
    if (step === 0) {
      const errors = validateExamInfo(name, examDate, today);
      setInfoErrors(errors);
      if (!hasErrors(errors)) setStep(1);
      return;
    }
    if (step === 1) {
      if (editor) {
        Alert.alert('還有科目正在編輯', '請先儲存或取消正在編輯的科目。');
        return;
      }
      if (subjects.length === 0) {
        setSubjectsError('請至少新增一個科目');
        return;
      }
      setStep(2);
      return;
    }

    // 步驟二完成，驗證讀書時間
    const error = validateStudyTime(prefs, today, examDate);
    setStudyError(error);
    if (error) {
      Alert.alert('讀書時間設定有誤', error);
      return;
    }

    handleSave();
  };

  const buildUpdatedExam = (): Exam => {
    return {
      ...originalExam,
      name: name.trim(),
      examDate,
      subjects: subjects.map((s) => ({
        id: s.id,
        name: s.name.trim(),
        familiarity: s.familiarity,
        chapters: parseChapters(s.chaptersText).map((title) => {
          const existing = originalExam.subjects
            .find((origSub) => origSub.id === s.id)
            ?.chapters.find((c) => c.title === title);
          return existing ?? { id: createId('chapter'), title };
        }),
      })),
    };
  };

  const handleSave = () => {
    const updatedExam = buildUpdatedExam();

    // 運算排程影響與重新排程
    const rescheduleResult = calculateExamEditReschedule(
      originalExam,
      updatedExam,
      existingTasks,
      data.preferences,
      prefs,
      today,
      createId,
    );

    // 若未涉及排程欄位（例如僅修改考試名稱或科目名稱）
    if (!rescheduleResult.isScheduleAffecting) {
      setIsSubmitting(true);
      updateExam(updatedExam, undefined, prefs).then(() => {
        setIsSubmitting(false);
        Alert.alert('已儲存變更', '考試名稱與基本資訊已同步更新。', [
          { text: '好', onPress: () => router.back() },
        ]);
      });
      return;
    }

    // 若影響排程，開啟重新排程預覽彈窗供使用者確認
    setPreviewPlan({
      updatedExam,
      rescheduleResult,
    });
  };

  // 套用重新排程
  const applyRescheduleAndSave = async () => {
    if (!previewPlan) return;
    setIsSubmitting(true);
    try {
      await updateExam(
        previewPlan.updatedExam,
        previewPlan.rescheduleResult.updatedTasks,
        prefs,
      );
      setPreviewPlan(null);
      Alert.alert(
        '已更新並重新排程',
        `考試設定與每日任務已重新安排完畢。\n已完成的 ${previewPlan.rescheduleResult.completedCount} 項任務與研讀紀錄皆完整保留。`,
        [
          {
            text: '查看讀書計畫',
            onPress: () => {
              if (router.canDismiss()) router.dismiss();
              else router.back();
              router.navigate({
                pathname: '/(tabs)/plan',
                params: { examId: previewPlan.updatedExam.id },
              });
            },
          },
        ],
      );
    } catch (err) {
      console.error('[編輯考試] 儲存失敗：', err);
      Alert.alert('儲存失敗', '無法儲存排程，請再試一次。');
    } finally {
      setIsSubmitting(false);
    }
  };

  // 僅儲存考試資訊，保留現有排程不更動任務
  const saveWithoutReschedule = async () => {
    if (!previewPlan) return;
    setIsSubmitting(true);
    try {
      await updateExam(previewPlan.updatedExam, undefined, prefs);
      setPreviewPlan(null);
      Alert.alert('已儲存考試資訊', '考試基本設定已更新，既有每日讀書任務日期維持不變。', [
        { text: '好', onPress: () => router.back() },
      ]);
    } catch (err) {
      console.error('[編輯考試] 儲存失敗：', err);
      Alert.alert('儲存失敗', '無法儲存考試設定，請再試一次。');
    } finally {
      setIsSubmitting(false);
    }
  };

  const daysUntil = diffDays(today, examDate);
  const studyDays = countStudyDays(today, examDate, prefs.restDays);

  return (
    <>
      <Stack.Screen
        options={{
          title: '編輯考試',
          gestureEnabled: !isDirty,
          headerLeft: () => (
            <Pressable onPress={cancel} hitSlop={8} accessibilityRole="button">
              <AppText color={colors.primary}>取消</AppText>
            </Pressable>
          ),
          headerRight: () => (
            <Pressable onPress={confirmDeleteExam} hitSlop={8} accessibilityRole="button">
              <Ionicons name="trash-outline" size={20} color={colors.danger} />
            </Pressable>
          ),
        }}
      />

      <Screen
        bottomInset
        footer={
          <View style={styles.footerRow}>
            {step > 0 ? (
              <Button
                title="上一步"
                variant="plain"
                disabled={isSubmitting}
                onPress={() => setStep(step - 1)}
                style={{ flex: 1 }}
              />
            ) : null}
            <Button
              title={step === 2 ? '儲存變更' : '下一步'}
              loading={step === 2 && isSubmitting}
              onPress={next}
              style={{ flex: 1 }}
            />
          </View>
        }
      >
        {/* 進度條 */}
        <View style={styles.stepHeader}>
          <AppText variant="footnote" secondary>
            步驟 {step + 1} / {STEPS.length}：{STEPS[step]}
          </AppText>
          <ProgressBar value={(step + 1) / STEPS.length} height={4} style={{ marginTop: 6 }} />
        </View>

        {/* ───── 步驟一：考試資訊 ───── */}
        {step === 0 && (
          <>
            <Section title="基本資料">
              <TextField
                label="考試名稱"
                value={name}
                onChangeText={(text) => {
                  setName(text);
                  if (infoErrors.name) setInfoErrors((e) => ({ ...e, name: undefined }));
                }}
                placeholder="例如：多益英語測驗、期末微積分"
                error={infoErrors.name}
              />
            </Section>

            <View style={styles.sectionWrap}>
              <AppText variant="footnote" secondary style={styles.label}>
                考試日期
              </AppText>
              <View style={styles.dateRow}>
                <View style={{ flex: 1, marginRight: spacing.sm }}>
                  <AppText style={{ fontWeight: '600' }}>考試當天</AppText>
                  <AppText variant="caption" secondary style={{ marginTop: 2 }}>
                    {formatYearMonthDay(examDate)} ·{' '}
                    {daysUntil > 0
                      ? `還有 ${daysUntil} 天（約 ${studyDays} 個讀書日）`
                      : daysUntil === 0
                        ? '就是今天！'
                        : '已過期'}
                  </AppText>
                </View>
                <DateTimePicker
                  value={parseISODate(examDate)}
                  mode="date"
                  display="compact"
                  locale="zh-TW"
                  accentColor={colors.primary}
                  themeVariant="light"
                  minimumDate={parseISODate(today)}
                  onChange={(_, date) => {
                    if (date) {
                      setExamDate(toISODate(date));
                      if (infoErrors.examDate)
                        setInfoErrors((e) => ({ ...e, examDate: undefined }));
                    }
                  }}
                />
              </View>
              {infoErrors.examDate ? (
                <AppText variant="caption" color={colors.danger} style={styles.inlineError}>
                  {infoErrors.examDate}
                </AppText>
              ) : null}
            </View>

            <View style={styles.dangerZoneBox}>
              <Button
                title="刪除這場考試"
                variant="destructive"
                onPress={confirmDeleteExam}
              />
            </View>
          </>
        )}

        {/* ───── 步驟二：科目與範圍 ───── */}
        {step === 1 && (
          <>
            {editor ? (
              <Section
                title={editorIsNew ? '新增科目' : `編輯「${editor.name || '科目'}」`}
                footer="章節請每行輸入一個，如果不確定具體章節可以留空，系統會為該科目安排合適的待讀任務。"
              >
                <TextField
                  label="科目名稱"
                  value={editor.name}
                  onChangeText={(text) => setEditor({ ...editor, name: text })}
                  placeholder="例如：聽力、閱讀、單字"
                  error={editorErrors.name}
                />
                <View style={styles.block}>
                  <AppText style={styles.blockTitle}>目前熟悉程度</AppText>
                  <Segmented
                    options={FAMILIARITY_OPTIONS}
                    value={editor.familiarity}
                    onChange={(familiarity) => setEditor({ ...editor, familiarity })}
                  />
                  <AppText variant="footnote" secondary style={styles.blockNote}>
                    {editor.familiarity === 1
                      ? '不熟：系統會安排較多觀念釐清與反覆複習時間。'
                      : editor.familiarity === 2
                        ? '普通：標準學習進度與章節練習配比。'
                        : '熟悉：以重點掃讀與實戰題目練習為主。'}
                  </AppText>
                </View>
                <TextField
                  label="章節或考試範圍（選填，每行一個）"
                  value={editor.chaptersText}
                  onChangeText={(text) => setEditor({ ...editor, chaptersText: text })}
                  placeholder={'第 1 章：極限定理\n第 2 章：導函數應用\n第 3 章：不定積分'}
                  multiline
                  numberOfLines={4}
                  error={editorErrors.chapters}
                />
                <View style={styles.editorActions}>
                  <Button
                    title="儲存科目"
                    onPress={saveSubject}
                    style={{ flex: 1, marginRight: spacing.sm }}
                  />
                  {!editorIsNew ? (
                    <Button
                      title="刪除"
                      variant="destructive"
                      onPress={deleteSubject}
                      style={{ marginRight: spacing.sm }}
                    />
                  ) : null}
                  <Button title="取消" variant="plain" onPress={() => setEditor(null)} />
                </View>
              </Section>
            ) : (
              <Section
                title={`科目清單（共 ${subjects.length} 科）`}
                footer="點選科目可修改熟悉度或章節名稱；若新增或刪除章節，儲存時會自動為您重整排程。"
              >
                {subjects.map((s) => {
                  const chCount = parseChapters(s.chaptersText).length;
                  return (
                    <Row
                      key={s.id}
                      title={s.name}
                      subtitle={`熟悉度：${FAMILIARITY_LABELS[s.familiarity]} · ${
                        chCount > 0 ? `${chCount} 個章節` : '未指定章節（由系統平均配置）'
                      }`}
                      showChevron
                      onPress={() => startEditSubject(s)}
                    />
                  );
                })}
                <Row
                  title="＋ 新增科目"
                  onPress={startNewSubject}
                  value=""
                />
              </Section>
            )}
            {subjectsError ? (
              <AppText variant="caption" color={colors.danger} style={styles.inlineError}>
                {subjectsError}
              </AppText>
            ) : null}
          </>
        )}

        {/* ───── 步驟三：讀書時間 ───── */}
        {step === 2 && (
          <Section
            title="讀書時間規劃"
            footer="若修改每日讀書時間或每週休息日，儲存時會重新計算任務分配，已完成打卡的任務將不受影響。"
          >
            <Row
              title="每天可讀書時間"
              right={
                <Stepper
                  label="每日可讀書時間"
                  value={prefs.dailyMinutes}
                  min={30}
                  max={720}
                  step={15}
                  format={formatMinutes}
                  onChange={(dailyMinutes) => setPrefs({ ...prefs, dailyMinutes })}
                />
              }
            />
            <View style={styles.block}>
              <AppText style={styles.blockTitle}>每週休息日</AppText>
              <WeekdayPicker
                selected={prefs.restDays}
                onChange={(restDays) => {
                  if (restDays.length >= 7) {
                    Alert.alert('至少保留一天讀書日', '七天都設為休息日將無法安排排程。');
                    return;
                  }
                  setPrefs({ ...prefs, restDays });
                }}
              />
              <AppText variant="footnote" secondary style={styles.blockNote}>
                選取的日子預設不排定新任務。
              </AppText>
            </View>
            <View style={styles.block}>
              <AppText style={styles.blockTitle}>讀書強度</AppText>
              <Segmented
                options={INTENSITY_OPTIONS}
                value={prefs.intensity}
                onChange={(intensity) => setPrefs({ ...prefs, intensity })}
              />
              <AppText variant="footnote" secondary style={styles.blockNote}>
                {INTENSITY_DESCRIPTIONS[prefs.intensity]}
              </AppText>
            </View>

            {studyError ? (
              <AppText variant="caption" color={colors.danger} style={styles.inlineError}>
                {studyError}
              </AppText>
            ) : null}
          </Section>
        )}
      </Screen>

      {/* ───── 重新排程確認與預覽彈窗 ───── */}
      {previewPlan && (
        <Modal
          visible
          animationType="slide"
          transparent
          onRequestClose={() => setPreviewPlan(null)}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <View style={styles.modalHeader}>
                <View>
                  <AppText variant="title">重新排程預覽</AppText>
                  <AppText variant="footnote" secondary style={{ marginTop: 2 }}>
                    檢測到考試日期或排程設定變更
                  </AppText>
                </View>
                <Pressable
                  onPress={() => setPreviewPlan(null)}
                  hitSlop={8}
                  style={styles.closeBtn}
                  accessibilityRole="button"
                >
                  <Ionicons name="close" size={22} color={colors.textSecondary} />
                </Pressable>
              </View>

              <ScrollView style={styles.modalScroll} contentContainerStyle={{ paddingBottom: spacing.lg }}>
                {/* 日期變更提示 */}
                <View style={styles.summaryCard}>
                  <View style={styles.summaryRow}>
                    <Ionicons name="calendar-outline" size={18} color={colors.primary} />
                    <AppText style={{ fontWeight: '600', flex: 1, marginLeft: 6 }}>
                      新考試日期：{formatYearMonthDay(previewPlan.updatedExam.examDate)}
                    </AppText>
                    <AppText variant="caption" color={colors.primary}>
                      考前剩餘 {previewPlan.rescheduleResult.remainingStudyDays} 個讀書日
                    </AppText>
                  </View>
                </View>

                {/* 任務變更統計 4 格卡 */}
                <View style={styles.statsGrid}>
                  <View style={styles.statBox}>
                    <View style={styles.statBoxLabel}>
                      <Ionicons name="checkmark-done-circle" size={16} color={colors.primary} />
                      <AppText variant="caption" secondary>
                        已完成任務
                      </AppText>
                    </View>
                    <AppText variant="headline" color={colors.primary} style={{ marginTop: 4 }}>
                      {previewPlan.rescheduleResult.completedCount} 項
                    </AppText>
                    <AppText variant="caption" secondary style={{ fontSize: 11, marginTop: 2 }}>
                      100% 完整保留
                    </AppText>
                  </View>

                  <View style={styles.statBox}>
                    <View style={styles.statBoxLabel}>
                      <Ionicons name="swap-horizontal" size={16} color={colors.text} />
                      <AppText variant="caption" secondary>
                        重新移動日期
                      </AppText>
                    </View>
                    <AppText variant="headline" style={{ marginTop: 4 }}>
                      {previewPlan.rescheduleResult.movedTasks.length} 項
                    </AppText>
                    <AppText variant="caption" secondary style={{ fontSize: 11, marginTop: 2 }}>
                      {previewPlan.rescheduleResult.unchangedCount} 項維持原日
                    </AppText>
                  </View>

                  <View style={styles.statBox}>
                    <View style={styles.statBoxLabel}>
                      <Ionicons name="add-circle-outline" size={16} color={colors.primary} />
                      <AppText variant="caption" secondary>
                        新增章節任務
                      </AppText>
                    </View>
                    <AppText variant="headline" style={{ marginTop: 4 }}>
                      {previewPlan.rescheduleResult.newTasksCount} 項
                    </AppText>
                    <AppText variant="caption" secondary style={{ fontSize: 11, marginTop: 2 }}>
                      納入後續排程
                    </AppText>
                  </View>

                  <View style={styles.statBox}>
                    <View style={styles.statBoxLabel}>
                      <Ionicons
                        name="alert-circle-outline"
                        size={16}
                        color={
                          previewPlan.rescheduleResult.unassignedTasks.length > 0
                            ? colors.warning
                            : colors.textSecondary
                        }
                      />
                      <AppText
                        variant="caption"
                        color={
                          previewPlan.rescheduleResult.unassignedTasks.length > 0
                            ? colors.warning
                            : colors.textSecondary
                        }
                      >
                        超出上限任務
                      </AppText>
                    </View>
                    <AppText
                      variant="headline"
                      color={
                        previewPlan.rescheduleResult.unassignedTasks.length > 0
                          ? colors.warning
                          : colors.text
                      }
                      style={{ marginTop: 4 }}
                    >
                      {previewPlan.rescheduleResult.unassignedTasks.length} 項
                    </AppText>
                    <AppText variant="caption" secondary style={{ fontSize: 11, marginTop: 2 }}>
                      {previewPlan.rescheduleResult.unassignedTasks.length > 0
                        ? '需手動調整'
                        : '全部順利排入'}
                    </AppText>
                  </View>
                </View>

                {/* 警告說明 */}
                {previewPlan.rescheduleResult.warning ? (
                  <View style={styles.warningCard}>
                    <Ionicons name="warning-outline" size={20} color={colors.warning} />
                    <View style={{ flex: 1, marginLeft: 8 }}>
                      <AppText variant="footnote" color={colors.warning} style={{ fontWeight: '600' }}>
                        讀書時間較為緊湊
                      </AppText>
                      <AppText variant="caption" secondary style={{ marginTop: 2 }}>
                        {previewPlan.rescheduleResult.warning}
                      </AppText>
                    </View>
                  </View>
                ) : null}

                {/* 移動任務細項預覽（最多顯示 5 筆） */}
                {previewPlan.rescheduleResult.movedTasks.length > 0 ? (
                  <View style={styles.movedListCard}>
                    <AppText variant="subhead" style={{ fontWeight: '600', marginBottom: 8 }}>
                      任務日期調整範例（前 {Math.min(5, previewPlan.rescheduleResult.movedTasks.length)} 筆）
                    </AppText>
                    {previewPlan.rescheduleResult.movedTasks.slice(0, 5).map((change) => (
                      <View key={change.taskId} style={styles.movedItemRow}>
                        <AppText variant="footnote" style={{ flex: 1 }} numberOfLines={1}>
                          {change.taskTitle}
                        </AppText>
                        <View style={styles.dateBadgeWrap}>
                          <AppText variant="caption" secondary style={{ textDecorationLine: 'line-through' }}>
                            {formatMonthDay(change.oldDate)}
                          </AppText>
                          <Ionicons name="arrow-forward" size={12} color={colors.primary} />
                          <AppText variant="caption" color={colors.primary} style={{ fontWeight: '600' }}>
                            {formatMonthDay(change.newDate)}
                          </AppText>
                        </View>
                      </View>
                    ))}
                  </View>
                ) : null}

                {/* 操作按鈕群 */}
                <View style={styles.modalActionButtons}>
                  <Button
                    title="確認重新排程並儲存"
                    loading={isSubmitting}
                    onPress={applyRescheduleAndSave}
                    style={{ marginBottom: spacing.sm }}
                  />
                  <Button
                    title="僅更新考試設定，保留現有日程"
                    variant="secondary"
                    disabled={isSubmitting}
                    onPress={saveWithoutReschedule}
                    style={{ marginBottom: spacing.sm }}
                  />
                  <Button
                    title="取消，返回編輯"
                    variant="plain"
                    disabled={isSubmitting}
                    onPress={() => setPreviewPlan(null)}
                  />
                </View>
              </ScrollView>
            </View>
          </View>
        </Modal>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  stepHeader: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  footerRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  inlineError: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
  },
  block: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  blockTitle: {
    marginBottom: spacing.sm,
    fontWeight: '500',
  },
  blockNote: {
    marginTop: spacing.xs,
  },
  editorActions: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  sectionWrap: {
    paddingHorizontal: spacing.lg,
    marginTop: spacing.md,
  },
  label: {
    marginBottom: spacing.xs,
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    ...shadow.sm,
  },
  dangerZoneBox: {
    marginTop: spacing.xl,
    paddingHorizontal: spacing.lg,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: colors.background,
    borderTopLeftRadius: radius.md * 2,
    borderTopRightRadius: radius.md * 2,
    maxHeight: '85%',
    paddingTop: spacing.lg,
    ...shadow.md,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  closeBtn: {
    padding: spacing.xs,
  },
  modalScroll: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  summaryCard: {
    backgroundColor: colors.surface,
    padding: spacing.md,
    borderRadius: radius.md,
    marginBottom: spacing.md,
    ...shadow.sm,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  statBox: {
    width: '48%',
    backgroundColor: colors.surface,
    padding: spacing.md,
    borderRadius: radius.sm,
    ...shadow.sm,
  },
  statBoxLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  warningCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: colors.warningSoft,
    padding: spacing.md,
    borderRadius: radius.md,
    marginBottom: spacing.md,
  },
  movedListCard: {
    backgroundColor: colors.surface,
    padding: spacing.md,
    borderRadius: radius.md,
    marginBottom: spacing.md,
    ...shadow.sm,
  },
  movedItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  dateBadgeWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: spacing.sm,
  },
  modalActionButtons: {
    marginTop: spacing.sm,
  },
});
