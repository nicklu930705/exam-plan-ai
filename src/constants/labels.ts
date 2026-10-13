import type { Familiarity, Intensity, TaskKind, TaskStatus } from '../types/models';

/** 介面文字對照表（台灣繁體中文） */

export const FAMILIARITY_LABELS: Record<Familiarity, string> = {
  1: '不熟',
  2: '普通',
  3: '熟悉',
};

export const INTENSITY_LABELS: Record<Intensity, string> = {
  light: '輕鬆',
  normal: '標準',
  intense: '衝刺',
};

export const INTENSITY_DESCRIPTIONS: Record<Intensity, string> = {
  light: '保留較多彈性，每天約用掉可讀時間的七成',
  normal: '大致用滿每天的可讀時間',
  intense: '用滿可讀時間，並增加練習與複習比例',
};

export const TASK_KIND_LABELS: Record<TaskKind, string> = {
  study: '讀書',
  practice: '練習',
  review: '複習',
};

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  pending: '未完成',
  done: '已完成',
  needsReschedule: '待重新安排',
};
