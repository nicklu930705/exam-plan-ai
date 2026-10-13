/**
 * 設計規範（Design tokens）
 * 所有畫面的顏色、間距、字級、圓角都從這裡取用，確保整個 App 一致。
 */

export const colors = {
  background: '#F7F6F1', // 背景暖米白
  surface: '#FFFFFF', // 列表區塊底色
  primary: '#788B73', // 品牌主色鼠尾草綠
  primarySoft: '#E9EEE5', // 淺綠輔色
  text: '#30332F', // 主要文字深灰
  textSecondary: '#858780', // 次要文字
  separator: '#E8E7E0', // 分隔線
  danger: '#B5594B', // 刪除等破壞性操作（低飽和紅，與整體色調協調）
  warning: '#A8803A', // 落後提醒（低飽和琥珀色）
  warningSoft: '#F3EEE2', // 落後提醒的底色
  onPrimary: '#FFFFFF',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  pill: 999,
} as const;

/** 字級參考 iOS Dynamic Type 預設值 */
export const typography = {
  largeTitle: { fontSize: 32, fontWeight: '700' as const, lineHeight: 40 },
  title: { fontSize: 22, fontWeight: '600' as const, lineHeight: 28 },
  headline: { fontSize: 17, fontWeight: '600' as const, lineHeight: 22 },
  body: { fontSize: 17, fontWeight: '400' as const, lineHeight: 22 },
  subhead: { fontSize: 15, fontWeight: '400' as const, lineHeight: 20 },
  footnote: { fontSize: 13, fontWeight: '400' as const, lineHeight: 18 },
  caption: { fontSize: 12, fontWeight: '400' as const, lineHeight: 16 },
} as const;

/** 可點擊元素的最小觸控尺寸（Apple HIG 建議 44pt） */
export const MIN_TOUCH = 44;

export const shadow = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
} as const;
