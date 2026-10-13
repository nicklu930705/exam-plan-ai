import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, TextInput, View, type TextInputProps } from 'react-native';

import { colors, MIN_TOUCH, radius, spacing, typography } from '../theme';
import type { Weekday } from '../types/models';
import { weekdayLabel } from '../utils/date';
import { AppText } from './AppText';

/** 表單相關的小元件 */

// ───────── 分段選擇器 ─────────

interface SegmentedProps<T extends string | number> {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
}: SegmentedProps<T>) {
  return (
    <View style={styles.segmented} accessibilityRole="radiogroup">
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <Pressable
            key={String(opt.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            onPress={() => onChange(opt.value)}
            style={[styles.segment, selected && styles.segmentSelected]}
          >
            <AppText
              variant="subhead"
              color={selected ? colors.onPrimary : colors.text}
              style={selected && { fontWeight: '600' }}
            >
              {opt.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

// ───────── 星期選擇 ─────────

const WEEK_ORDER: Weekday[] = [1, 2, 3, 4, 5, 6, 0];

interface WeekdayPickerProps {
  selected: Weekday[];
  onChange: (days: Weekday[]) => void;
}

export function WeekdayPicker({ selected, onChange }: WeekdayPickerProps) {
  const toggle = (day: Weekday) => {
    onChange(
      selected.includes(day)
        ? selected.filter((d) => d !== day)
        : [...selected, day].sort((a, b) => a - b),
    );
  };
  return (
    <View style={styles.weekRow}>
      {WEEK_ORDER.map((day) => {
        const on = selected.includes(day);
        return (
          <Pressable
            key={day}
            onPress={() => toggle(day)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on }}
            accessibilityLabel={`星期${weekdayLabel(day)}${on ? '，休息日' : ''}`}
            style={[styles.dayChip, on && styles.dayChipOn]}
          >
            <AppText variant="subhead" color={on ? colors.onPrimary : colors.text}>
              {weekdayLabel(day)}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

// ───────── 數值加減 ─────────

interface StepperProps {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  label: string;
}

export function Stepper({ value, onChange, min, max, step, format, label }: StepperProps) {
  return (
    <View style={styles.stepper}>
      <Pressable
        onPress={() => onChange(Math.max(min, value - step))}
        disabled={value <= min}
        accessibilityRole="button"
        accessibilityLabel={`減少${label}`}
        style={[styles.stepBtn, value <= min && { opacity: 0.35 }]}
      >
        <Ionicons name="remove" size={20} color={colors.primary} />
      </Pressable>
      <AppText variant="headline" style={styles.stepValue} accessibilityLiveRegion="polite">
        {format(value)}
      </AppText>
      <Pressable
        onPress={() => onChange(Math.min(max, value + step))}
        disabled={value >= max}
        accessibilityRole="button"
        accessibilityLabel={`增加${label}`}
        style={[styles.stepBtn, value >= max && { opacity: 0.35 }]}
      >
        <Ionicons name="add" size={20} color={colors.primary} />
      </Pressable>
    </View>
  );
}

// ───────── 文字輸入 ─────────

interface FieldProps extends TextInputProps {
  label: string;
  error?: string;
  hint?: string;
}

export function TextField({ label, error, hint, style, multiline, ...rest }: FieldProps) {
  return (
    <View style={styles.field}>
      <AppText variant="footnote" secondary style={styles.fieldLabel}>
        {label}
      </AppText>
      <TextInput
        {...rest}
        multiline={multiline}
        accessibilityLabel={label}
        placeholderTextColor={colors.textSecondary}
        selectionColor={colors.primary}
        style={[
          styles.input,
          multiline && styles.inputMultiline,
          !!error && { borderColor: colors.danger },
          style,
        ]}
      />
      {error ? (
        <AppText variant="footnote" color={colors.danger} style={styles.fieldNote}>
          {error}
        </AppText>
      ) : hint ? (
        <AppText variant="footnote" secondary style={styles.fieldNote}>
          {hint}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  segmented: {
    flexDirection: 'row',
    backgroundColor: colors.primarySoft,
    borderRadius: radius.sm + 2,
    padding: 3,
  },
  segment: {
    flex: 1,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  segmentSelected: { backgroundColor: colors.primary },
  weekRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.xs },
  dayChip: {
    flex: 1,
    height: MIN_TOUCH,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
  },
  dayChipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  stepBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepValue: { minWidth: 96, textAlign: 'center' },
  field: { marginBottom: spacing.lg },
  fieldLabel: { marginBottom: spacing.sm, marginLeft: spacing.xs },
  fieldNote: { marginTop: spacing.xs, marginLeft: spacing.xs },
  input: {
    ...typography.body,
    color: colors.text,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: 48,
  },
  inputMultiline: { minHeight: 120, textAlignVertical: 'top', paddingTop: spacing.md },
});
