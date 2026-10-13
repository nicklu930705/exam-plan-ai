import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { colors, radius, shadow, spacing } from '../theme';
import type { ISODate } from '../types/models';
import { formatFullDate, formatMinutes } from '../utils/date';
import { AppText } from './AppText';
import { Button } from './Button';

export interface TimeAdjustmentModalProps {
  visible: boolean;
  type: 'estimated' | 'actual';
  currentValue: number;
  taskTitle: string;
  date: ISODate;
  timerMinutes?: number;
  dailyMinutesLimit?: number;
  currentDateEstimatedTotal?: number;
  onSave: (newMinutes: number) => void;
  onClose: () => void;
}

const COMMON_PRESETS = [15, 25, 30, 45, 60, 90, 120];
const STEP_BUTTONS = [-15, -5, 5, 15];

export function TimeAdjustmentModal({
  visible,
  type,
  currentValue,
  taskTitle,
  date,
  timerMinutes = 0,
  dailyMinutesLimit = 120,
  currentDateEstimatedTotal = 0,
  onSave,
  onClose,
}: TimeAdjustmentModalProps) {
  const [textValue, setTextValue] = useState<string>(() => String(currentValue));

  const parsedValue = useMemo(() => {
    const trimmed = textValue.trim();
    if (trimmed === '') return null;
    const num = Number(trimmed);
    return isNaN(num) ? null : Math.floor(num);
  }, [textValue]);

  // 驗證錯誤訊息
  const errorMessage = useMemo(() => {
    if (parsedValue === null) {
      return '請輸入有效的整數分鐘數';
    }
    if (type === 'estimated' && parsedValue < 1) {
      return '預估時間至少需為 1 分鐘';
    }
    if (type === 'actual' && parsedValue < 0) {
      return '實際研讀時間不可為負數';
    }
    if (parsedValue > 720) {
      return '單項任務時間不可超過 720 分鐘 (12 小時)';
    }
    return null;
  }, [parsedValue, type]);

  // 預估時間超出每日上限計算
  const estimatedWarning = useMemo(() => {
    if (type !== 'estimated' || parsedValue === null || errorMessage) return null;
    const projectedTotal = currentDateEstimatedTotal - currentValue + parsedValue;
    if (projectedTotal > dailyMinutesLimit) {
      return {
        projectedTotal,
        exceeded: projectedTotal - dailyMinutesLimit,
      };
    }
    return null;
  }, [type, parsedValue, errorMessage, currentDateEstimatedTotal, currentValue, dailyMinutesLimit]);

  const handleStep = (delta: number) => {
    Keyboard.dismiss();
    const base = parsedValue !== null ? parsedValue : currentValue;
    const minBound = type === 'estimated' ? 1 : 0;
    const next = Math.max(minBound, Math.min(720, base + delta));
    setTextValue(String(next));
  };

  const handlePreset = (preset: number) => {
    Keyboard.dismiss();
    setTextValue(String(preset));
  };

  const handleSave = () => {
    if (parsedValue === null || errorMessage) return;
    onSave(parsedValue);
    onClose();
  };

  const isSaveDisabled = parsedValue === null || errorMessage !== null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.overlay}
      >
        <Pressable style={styles.backdrop} onPress={onClose} />

        <View style={styles.container}>
          {/* 頂部標題 */}
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <AppText variant="headline" style={{ fontWeight: '700' }}>
                {type === 'estimated' ? '自訂預估讀書時間' : '自訂實際研讀時間'}
              </AppText>
              <AppText variant="caption" secondary style={{ marginTop: 2 }} numberOfLines={1}>
                {taskTitle} · {formatFullDate(date)}
              </AppText>
            </View>
            <Pressable
              onPress={onClose}
              hitSlop={10}
              style={styles.closeBtn}
              accessibilityLabel="關閉"
              accessibilityRole="button"
            >
              <Ionicons name="close" size={20} color={colors.textSecondary} />
            </Pressable>
          </View>

          <ScrollView
            bounces={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.scrollContent}
          >
            {/* 說明與計時拆解提示 */}
            {type === 'actual' && timerMinutes > 0 ? (
              <View style={styles.breakdownBox}>
                <View style={styles.breakdownRow}>
                  <Ionicons name="stopwatch-outline" size={15} color={colors.primary} />
                  <AppText variant="footnote" color={colors.primary} style={{ fontWeight: '600' }}>
                    計時器累積：{formatMinutes(timerMinutes)}
                  </AppText>
                </View>
                <AppText variant="caption" secondary style={{ marginTop: 2 }}>
                  您可以在此直接輸入或修正總研讀時間，儲存後進度統計將即時更新。
                </AppText>
              </View>
            ) : (
              <AppText variant="footnote" secondary style={styles.introText}>
                {type === 'estimated'
                  ? '排程規劃基準時間，修改後所有頁面同步更新，不會覆蓋其他任務。'
                  : '真實研讀投入時間，與預估時間分開記錄，可用於檢視讀書效率。'}
              </AppText>
            )}

            {/* 輸入核心區塊 */}
            <View style={styles.inputWrap}>
              <View style={styles.inputBox}>
                <TextInput
                  value={textValue}
                  onChangeText={setTextValue}
                  keyboardType="number-pad"
                  maxLength={4}
                  selectTextOnFocus
                  selectionColor={colors.primary}
                  style={styles.input}
                  placeholder="0"
                  placeholderTextColor={colors.textSecondary}
                  accessibilityLabel={type === 'estimated' ? '預估讀書分鐘數' : '實際讀書分鐘數'}
                />
                <AppText variant="headline" style={styles.unitText}>
                  分鐘
                </AppText>
              </View>

              {/* 即時換算小時與分鐘 */}
              {parsedValue !== null && parsedValue > 0 ? (
                <AppText variant="subhead" color={colors.primary} style={styles.readableText}>
                  ≈ {formatMinutes(parsedValue)}
                </AppText>
              ) : null}
            </View>

            {/* 錯誤訊息 */}
            {errorMessage ? (
              <View style={styles.errorBanner}>
                <Ionicons name="alert-circle" size={16} color={colors.danger} />
                <AppText variant="footnote" color={colors.danger} style={{ flex: 1 }}>
                  {errorMessage}
                </AppText>
              </View>
            ) : null}

            {/* 預估時間超出上限警告 */}
            {estimatedWarning ? (
              <View style={styles.warningBanner}>
                <Ionicons name="warning" size={16} color={colors.warning} />
                <View style={{ flex: 1 }}>
                  <AppText variant="footnote" color={colors.warning} style={{ fontWeight: '600' }}>
                    當日預估時間將達 {estimatedWarning.projectedTotal} 分鐘
                  </AppText>
                  <AppText variant="caption" color={colors.warning} style={{ marginTop: 2 }}>
                    已超過您設定的每日上限 ({dailyMinutesLimit} 分鐘)，同日其他任務仍會保留，建議確認排程安排。
                  </AppText>
                </View>
              </View>
            ) : null}

            {/* 快速加減微調按鈕 */}
            <View style={styles.sectionHeader}>
              <AppText variant="caption" secondary>
                微調按鈕
              </AppText>
            </View>
            <View style={styles.stepGrid}>
              {STEP_BUTTONS.map((step) => (
                <Pressable
                  key={step}
                  onPress={() => handleStep(step)}
                  style={styles.stepBtn}
                  accessibilityRole="button"
                  accessibilityLabel={`調整 ${step > 0 ? `+${step}` : step} 分鐘`}
                >
                  <AppText variant="subhead" color={colors.primary} style={{ fontWeight: '600' }}>
                    {step > 0 ? `+${step} 分` : `${step} 分`}
                  </AppText>
                </Pressable>
              ))}
            </View>

            {/* 常用預設時間快捷選項 */}
            <View style={styles.sectionHeader}>
              <AppText variant="caption" secondary>
                常用時間
              </AppText>
            </View>
            <View style={styles.presetGrid}>
              {COMMON_PRESETS.map((p) => {
                const isSelected = parsedValue === p;
                return (
                  <Pressable
                    key={p}
                    onPress={() => handlePreset(p)}
                    style={[styles.presetChip, isSelected && styles.presetChipActive]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                  >
                    <AppText
                      variant="footnote"
                      color={isSelected ? colors.onPrimary : colors.text}
                      style={isSelected && { fontWeight: '600' }}
                    >
                      {p} 分鐘
                    </AppText>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>

          {/* 底部操作按鈕 */}
          <View style={styles.footer}>
            <View style={{ flex: 1 }}>
              <Button
                title="取消"
                variant="secondary"
                onPress={onClose}
              />
            </View>
            <View style={{ flex: 1.5 }}>
              <Button
                title="儲存變更"
                variant="primary"
                disabled={isSaveDisabled}
                onPress={handleSave}
              />
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
  },
  container: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.md + 4,
    borderTopRightRadius: radius.md + 4,
    paddingTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingBottom: Platform.OS === 'ios' ? spacing.xxl : spacing.lg,
    maxHeight: '85%',
    ...shadow.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  closeBtn: {
    padding: spacing.xs,
    marginLeft: spacing.sm,
  },
  scrollContent: {
    paddingVertical: spacing.md,
  },
  introText: {
    marginBottom: spacing.md,
  },
  breakdownBox: {
    backgroundColor: colors.primarySoft,
    padding: spacing.sm + 2,
    borderRadius: radius.sm,
    marginBottom: spacing.md,
  },
  breakdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  inputWrap: {
    alignItems: 'center',
    marginVertical: spacing.sm,
  },
  inputBox: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.primary,
    minWidth: 160,
  },
  input: {
    fontSize: 40,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
    minWidth: 60,
    padding: 0,
  },
  unitText: {
    color: colors.textSecondary,
    fontWeight: '600',
  },
  readableText: {
    marginTop: spacing.xs,
    fontWeight: '600',
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#FDECE8',
    padding: spacing.sm,
    borderRadius: radius.sm,
    marginTop: spacing.sm,
  },
  warningBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: colors.warningSoft,
    padding: spacing.sm,
    borderRadius: radius.sm,
    marginTop: spacing.sm,
  },
  sectionHeader: {
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  stepGrid: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  stepBtn: {
    flex: 1,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primarySoft,
    borderRadius: radius.sm,
  },
  presetGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs + 2,
  },
  presetChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.pill,
    backgroundColor: colors.background,
  },
  presetChipActive: {
    backgroundColor: colors.primary,
  },
  footer: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
  },
});
