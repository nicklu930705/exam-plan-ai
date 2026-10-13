import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import type { ISODate } from '../types/models';
import { todayISO } from '../utils/date';

/**
 * 取得今天的日期，並在 App 從背景回到前景時重新確認，
 * 避免 App 開著跨過午夜後還顯示昨天的任務。
 */
export function useToday(): ISODate {
  const [today, setToday] = useState<ISODate>(() => todayISO());

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') setToday(todayISO());
    });
    return () => sub.remove();
  }, []);

  return today;
}
