import { useEffect, useMemo, useState } from 'react';

import { useAppStore } from '../store/AppStore';

/** 將秒數格式化為 MM:SS 或 HH:MM:SS */
export function formatSecondsToTimer(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hrs = Math.floor(safeSeconds / 3600);
  const mins = Math.floor((safeSeconds % 3600) / 60);
  const secs = safeSeconds % 60;

  const mm = mins.toString().padStart(2, '0');
  const ss = secs.toString().padStart(2, '0');

  if (hrs > 0) {
    const hh = hrs.toString().padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

/**
 * 讀書計時器專屬 Hook
 * 透過集中在 AppStore 的狀態管理，切換頁面、背景切換皆不會遺失計時進度。
 */
export function useStudyTimer() {
  const { data, startTimer, pauseTimer, resumeTimer, stopTimer, discardTimer } = useAppStore();
  const activeTimer = data.activeTimer;

  // 用於每秒觸發組件重新計算時間，僅在計時中 (isRunning === true) 時計時
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!activeTimer?.isRunning) return;

    // 啟動 1 秒定期心跳
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => clearInterval(timer);
  }, [activeTimer?.isRunning]);

  // 精確計算目前累計秒數（之前暫停片段 + 本次開始至今）
  const elapsedSeconds = useMemo(() => {
    if (!activeTimer) return 0;
    const currentSegment = activeTimer.isRunning
      ? Math.max(0, Math.floor((now - activeTimer.startedAt) / 1000))
      : 0;
    return activeTimer.accumulatedSeconds + currentSegment;
  }, [activeTimer, now]);

  const formattedTime = useMemo(() => formatSecondsToTimer(elapsedSeconds), [elapsedSeconds]);

  const isTimingTask = (taskId: string) => {
    return activeTimer?.taskId === taskId;
  };

  return {
    activeTimer,
    elapsedSeconds,
    formattedTime,
    isRunning: activeTimer?.isRunning ?? false,
    startTimer,
    pauseTimer,
    resumeTimer,
    stopTimer,
    discardTimer,
    isTimingTask,
  };
}
