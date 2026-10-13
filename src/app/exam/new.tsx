import DateTimePicker from '@react-native-community/datetimepicker';
import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

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
import { scheduleExamPlan } from '../../scheduler';
import { loadAppDataFromStorage } from '../../storage';
import { createId, useAppStore } from '../../store/AppStore';
import { countStudyDays } from '../../store/selectors';
import { canCreateExam } from '../../subscription/entitlements';
import { colors, radius, spacing } from '../../theme';
import type { Exam, Familiarity, Intensity, StudyPreferences, StudyTask, Weekday } from '../../types/models';
import {
  addDays,
  diffDays,
  formatMinutes,
  parseISODate,
  toISODate,
} from '../../utils/date';
import {
  hasErrors,
  LIMITS,
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

export default function NewExamScreen() {
  const { data, createExamWithTasks, setSelectedExamId } = useAppStore();
  const today = useToday();

  const [step, setStep] = useState(0);

  // 步驟一：考試資訊
  const [name, setName] = useState('');
  const [examDate, setExamDate] = useState(() => addDays(today, 30));
  const [infoErrors, setInfoErrors] = useState<ExamInfoErrors>({});

  // 步驟二：科目
  const [subjects, setSubjects] = useState<SubjectDraft[]>([]);
  const [editor, setEditor] = useState<SubjectDraft | null>(null);
  const [editorIsNew, setEditorIsNew] = useState(false);
  const [editorErrors, setEditorErrors] = useState<SubjectErrors>({});
  const [subjectsError, setSubjectsError] = useState<string>();

  // 步驟三：讀書時間（沿用設定中的偏好）
  const [prefs, setPrefs] = useState<StudyPreferences>(() => ({ ...data.preferences }));
  const [studyError, setStudyError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const examCheck = canCreateExam(data);
  if (!examCheck.allowed) {
    return (
      <Screen topInset bottomInset>
        <Stack.Screen options={{ title: '達到方案上限' }} />
        <EmptyState
          title="已達免費版考試計畫上限"
          message={`免費版目前支援 ${examCheck.maxAllowed} 場進行中的考試計畫。\n\n升級至 Pro 方案即可建立無限場考試，或將現有已結束的考試「封存」後再建立新目標。`}
          actionTitle="查看會員方案"
          onAction={() => router.push('/subscription')}
        />
        <View style={{ paddingHorizontal: spacing.lg, gap: spacing.md, marginTop: spacing.md }}>
          <Button
            title="管理現有考試（封存舊目標）"
            variant="secondary"
            onPress={() => router.replace('/exams')}
          />
          <Button
            title="返回上一頁"
            variant="plain"
            onPress={() => router.back()}
          />
        </View>
      </Screen>
    );
  }

  const dirty = name.trim().length > 0 || subjects.length > 0 || editor !== null;

  // ───── 取消（有輸入內容時先確認） ─────
  const cancel = () => {
    if (!dirty) {
      router.back();
      return;
    }
    Alert.alert('放棄建立考試？', '目前輸入的內容不會被保存。', [
      { text: '繼續編輯', style: 'cancel' },
      { text: '放棄', style: 'destructive', onPress: () => router.back() },
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

  // ───── 下一步／完成 ─────
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

    // 步驟二完成，進入排程檢查
    const error = validateStudyTime(prefs, today, examDate);
    setStudyError(error);
    if (error) {
      Alert.alert('讀書時間設定有誤', error);
      return;
    }
    submit();
  };

  const finalizePlan = async (exam: Exam, planTasks: StudyTask[]) => {
    try {
      console.log('[建立考試] 成功產生讀書計畫，開始保存資料：', {
        examId: exam.id,
        examName: exam.name,
        examDate: exam.examDate,
        tasksCount: planTasks.length,
      });

      // 1. 等候非同步儲存至本機資料庫完畢
      await createExamWithTasks(exam, planTasks, prefs);
      setSelectedExamId(exam.id);

      // 2. 重新讀取並確認資料（確保 AsyncStorage 真正已寫入並可重新讀取）
      const reloaded = await loadAppDataFromStorage();
      const verifiedExam = reloaded?.exams.find((e) => e.id === exam.id);
      const verifiedTasks = reloaded?.tasks.filter((t) => t.examId === exam.id);
      console.log('[建立考試] 本機儲存讀取確認：', {
        examFound: !!verifiedExam,
        tasksCount: verifiedTasks?.length ?? 0,
      });

      // 3. 儲存成功後關閉彈窗，並導航至該考試的計畫頁面
      if (router.canDismiss()) {
        router.dismiss();
      } else if (router.canGoBack()) {
        router.back();
      }

      setTimeout(() => {
        router.navigate({ pathname: '/(tabs)/plan', params: { examId: exam.id } });
      }, 150);
    } catch (err) {
      console.error('[建立考試] 保存考試計畫失敗：', err);
      Alert.alert('保存失敗', '無法保存考試資料至本機儲存，請再試一次。');
    } finally {
      setIsSubmitting(false);
    }
  };

  const submit = () => {
    setIsSubmitting(true);
    setStudyError(undefined);

    // 稍微延遲讓 UI 渲染按鈕載入動畫 (ActivityIndicator)
    setTimeout(async () => {
      try {
        const exam: Exam = {
          id: createId('exam'),
          name: name.trim(),
          examDate,
          createdAt: new Date().toISOString(),
          subjects: subjects.map((s) => ({
            id: s.id,
            name: s.name.trim(),
            familiarity: s.familiarity,
            chapters: parseChapters(s.chaptersText).map((title) => ({
              id: createId('chapter'),
              title,
            })),
          })),
        };

        const schedule = scheduleExamPlan(exam, prefs, today, createId);

        if (schedule.tasks.length === 0) {
          setIsSubmitting(false);
          const errorMsg =
            schedule.warning ??
            '考試日前沒有可安排的讀書日，請確認考試日期是否大於今天，或減少每週休息天數。';
          setStudyError(errorMsg);
          Alert.alert('無法產生排程', errorMsg);
          return;
        }

        if (!schedule.isFeasible) {
          setIsSubmitting(false);
          Alert.alert(
            '讀書時間較為吃緊',
            `${schedule.warning ?? '可用時間小於完整任務所需時間。'}\n\n系統已優先為您安排高優先度科目與核心章節共 ${schedule.tasks.length} 項任務。您是否要以此排程建立考試？`,
            [
              { text: '回上一步調整', style: 'cancel' },
              {
                text: '確認建立',
                onPress: async () => {
                  setIsSubmitting(true);
                  await finalizePlan(exam, schedule.tasks);
                },
              },
            ],
          );
          return;
        }

        await finalizePlan(exam, schedule.tasks);
      } catch (err) {
        console.error('產生讀書計畫失敗：', err);
        setIsSubmitting(false);
        const errorMsg = err instanceof Error ? err.message : '發生未預期的排程錯誤';
        setStudyError(errorMsg);
        Alert.alert('排程失敗', `產生讀書計畫時發生錯誤：\n${errorMsg}`);
      }
    }, 60);
  };

  const daysUntil = diffDays(today, examDate);
  const studyDays = countStudyDays(today, examDate, prefs.restDays);

  return (
    <>
      <Stack.Screen
        options={{
          // 有輸入內容時關閉下滑關閉手勢，避免不小心遺失資料
          gestureEnabled: !dirty,
          headerLeft: () => (
            <Pressable onPress={cancel} hitSlop={8} accessibilityRole="button">
              <AppText color={colors.primary}>取消</AppText>
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
              title={step === 2 ? '產生讀書計畫' : '下一步'}
              loading={step === 2 && isSubmitting}
              disabled={isSubmitting}
              onPress={next}
              style={{ flex: 2 }}
            />
          </View>
        }
      >
        {/* 步驟指示 */}
        <View style={styles.stepHeader}>
          <AppText variant="footnote" secondary>
            步驟 {step + 1} / {STEPS.length}
          </AppText>
          <AppText variant="title" style={{ marginTop: 2, marginBottom: spacing.md }}>
            {STEPS[step]}
          </AppText>
          <ProgressBar value={(step + 1) / STEPS.length} height={4} />
        </View>

        {/* ───── 步驟一：考試資訊 ───── */}
        {step === 0 ? (
          <>
            <TextField
              label="考試名稱"
              placeholder="例如：多益、會計師、期中考"
              value={name}
              onChangeText={setName}
              maxLength={LIMITS.examNameMax + 10}
              returnKeyType="done"
              error={infoErrors.name}
            />
            <AppText variant="footnote" secondary style={styles.label}>
              考試日期
            </AppText>
            <View style={styles.dateRow}>
              <AppText>考試當天</AppText>
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
                    setInfoErrors((e) => ({ ...e, examDate: undefined }));
                  }
                }}
              />
            </View>
            <AppText
              variant="footnote"
              color={infoErrors.examDate ? colors.danger : colors.textSecondary}
              style={styles.note}
            >
              {infoErrors.examDate ??
                (daysUntil === 0 ? '考試就在今天，可安排的時間非常有限。' : `距離今天 ${daysUntil} 天`)}
            </AppText>
          </>
        ) : null}

        {/* ───── 步驟二：科目與範圍 ───── */}
        {step === 1 ? (
          <>
            {subjects.length > 0 ? (
              <Section title="已新增的科目" footer="點選科目可以修改或刪除。">
                {subjects.map((s) => (
                  <Row
                    key={s.id}
                    title={s.name}
                    subtitle={`${parseChapters(s.chaptersText).length} 個章節 · ${FAMILIARITY_LABELS[s.familiarity]}`}
                    showChevron
                    onPress={() => startEditSubject(s)}
                  />
                ))}
              </Section>
            ) : !editor ? (
              <AppText secondary style={styles.note}>
                還沒有科目。新增科目並輸入考試範圍，之後會依範圍拆成每天的小任務。
              </AppText>
            ) : null}

            {editor ? (
              <View style={styles.editor}>
                <AppText variant="headline" style={{ marginBottom: spacing.lg }}>
                  {editorIsNew ? '新增科目' : '修改科目'}
                </AppText>
                <TextField
                  label="科目名稱"
                  placeholder="例如：閱讀、會計學、微積分"
                  value={editor.name}
                  onChangeText={(t) => setEditor({ ...editor, name: t })}
                  returnKeyType="done"
                  error={editorErrors.name}
                />
                <TextField
                  label="考試範圍或章節"
                  placeholder={'每行一個章節，例如：\n第 1 章 導論\n第 2 章 基本概念'}
                  value={editor.chaptersText}
                  onChangeText={(t) => setEditor({ ...editor, chaptersText: t })}
                  multiline
                  error={editorErrors.chapters}
                  hint={`目前 ${parseChapters(editor.chaptersText).length} 個章節`}
                />
                <AppText variant="footnote" secondary style={styles.label}>
                  目前熟悉程度
                </AppText>
                <Segmented
                  options={FAMILIARITY_OPTIONS}
                  value={editor.familiarity}
                  onChange={(familiarity) => setEditor({ ...editor, familiarity })}
                />
                <View style={styles.editorActions}>
                  <Button title="儲存科目" variant="secondary" onPress={saveSubject} />
                  <Button title="取消" variant="plain" onPress={() => setEditor(null)} />
                  {!editorIsNew ? (
                    <Button title="刪除科目" variant="destructive" onPress={deleteSubject} />
                  ) : null}
                </View>
              </View>
            ) : subjects.length < LIMITS.subjectsMax ? (
              <Button title="＋ 新增科目" variant="secondary" onPress={startNewSubject} />
            ) : (
              <AppText variant="footnote" secondary>
                最多可以新增 {LIMITS.subjectsMax} 個科目。
              </AppText>
            )}

            {subjectsError ? (
              <AppText variant="footnote" color={colors.danger} style={styles.note}>
                {subjectsError}
              </AppText>
            ) : null}
          </>
        ) : null}

        {/* ───── 步驟三：讀書時間 ───── */}
        {step === 2 ? (
          <>
            <Section footer="這些設定會一併更新到「設定」頁，之後也可以修改。">
              <Row
                title="每天可讀書時間"
                right={
                  <Stepper
                    label="每天可讀書時間"
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
                <AppText style={{ marginBottom: spacing.md }}>每週休息日</AppText>
                <WeekdayPicker
                  selected={prefs.restDays}
                  onChange={(restDays: Weekday[]) => {
                    setPrefs({ ...prefs, restDays });
                    setStudyError(undefined);
                  }}
                />
              </View>
              <View style={styles.block}>
                <AppText style={{ marginBottom: spacing.md }}>讀書強度</AppText>
                <Segmented
                  options={INTENSITY_OPTIONS}
                  value={prefs.intensity}
                  onChange={(intensity) => setPrefs({ ...prefs, intensity })}
                />
                <AppText variant="footnote" secondary style={{ marginTop: spacing.sm }}>
                  {INTENSITY_DESCRIPTIONS[prefs.intensity]}
                </AppText>
              </View>
            </Section>

            <AppText secondary>
              從今天到考試前一天，共有 {studyDays} 個讀書日，最多約{' '}
              {formatMinutes(studyDays * prefs.dailyMinutes)} 可以安排。
            </AppText>
            {studyError ? (
              <AppText variant="footnote" color={colors.danger} style={styles.note}>
                {studyError}
              </AppText>
            ) : null}
          </>
        ) : null}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  stepHeader: { marginBottom: spacing.xl },
  label: { marginBottom: spacing.sm, marginLeft: spacing.xs },
  note: { marginTop: spacing.sm, marginLeft: spacing.xs, marginBottom: spacing.lg },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    minHeight: 52,
  },
  editor: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  editorActions: { marginTop: spacing.xl, gap: spacing.xs },
  block: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  footerRow: { flexDirection: 'row', gap: spacing.md },
});
