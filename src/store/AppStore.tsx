import React, { createContext, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';

import { createDemoData } from '../data/demo';
import { clearAppDataFromStorage, loadAppDataFromStorage, safeRestoreAppDataToStorage, saveAppDataToStorage } from '../storage';
import { getEffectiveTier, getPlanEntitlements, normalizeSubscriptionOnLoad } from '../subscription/entitlements';
import type { BackupStudyData } from '../types/backup';
import type { AiUsageRecord, UserSubscription } from '../subscription/types';
import type { AppData, Exam, ISODate, StudyPreferences, StudyTask, TaskStatus } from '../types/models';

/**
 * App 狀態管理模組（具備本機資料保存與排程整合）
 */

export type Action =
  | { type: 'setData'; data: AppData }
  | { type: 'setSelectedExam'; examId: string }
  | { type: 'setTaskStatus'; taskId: string; status: TaskStatus }
  | { type: 'setTaskMinutes'; taskId: string; minutes: number }
  | { type: 'setTaskActualMinutes'; taskId: string; minutes: number }
  | { type: 'setTaskDate'; taskId: string; date: ISODate }
  | { type: 'deleteTask'; taskId: string }
  | { type: 'startTimer'; taskId: string; now?: number }
  | { type: 'pauseTimer'; now?: number }
  | { type: 'resumeTimer'; now?: number }
  | { type: 'stopTimer'; taskId?: string; markAsDone?: boolean; now?: number }
  | { type: 'discardTimer' }
  | { type: 'createExamWithTasks'; exam: Exam; tasks: StudyTask[]; preferences?: StudyPreferences }
  | { type: 'updateExam'; exam: Exam; updatedTasks?: StudyTask[]; preferencesPatch?: Partial<StudyPreferences> }
  | { type: 'toggleArchiveExam'; examId: string }
  | { type: 'applyRescheduledTasks'; examId: string; updatedTasks: StudyTask[] }
  | { type: 'deleteExam'; examId: string }
  | { type: 'updatePreferences'; patch: Partial<StudyPreferences> }
  | { type: 'setSubscription'; subscription: UserSubscription }
  | { type: 'recordAiUsage'; increment?: number }
  | { type: 'restoreStudyData'; payload: BackupStudyData }
  | { type: 'loadDemo' }
  | { type: 'clearAll' };

export const DEFAULT_PREFERENCES: StudyPreferences = {
  dailyMinutes: 120,
  restDays: [0],
  intensity: 'normal',
};

export const DEFAULT_SUBSCRIPTION: UserSubscription = {
  plan: 'free',
  billingCycle: 'none',
  status: 'none',
  isDevPreview: true,
};

export const DEFAULT_AI_USAGE: AiUsageRecord = {
  monthlyCalls: 0,
  lastResetMonth: new Date().toISOString().slice(0, 7),
};

export const INITIAL_EMPTY_DATA: AppData = {
  exams: [],
  tasks: [],
  preferences: DEFAULT_PREFERENCES,
  selectedExamId: undefined,
  isDemo: false,
  activeTimer: null,
  subscription: DEFAULT_SUBSCRIPTION,
  aiUsage: DEFAULT_AI_USAGE,
};

export function reducer(state: AppData, action: Action): AppData {
  switch (action.type) {
    case 'setData':
      return action.data;

    case 'setSelectedExam':
      return { ...state, selectedExamId: action.examId };

    case 'setTaskStatus':
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.id === action.taskId
            ? {
                ...t,
                status: action.status,
                completedAt: action.status === 'done' ? new Date().toISOString() : undefined,
              }
            : t,
        ),
      };

    case 'setTaskMinutes': {
      const minutes = Math.max(1, Math.min(720, Math.round(action.minutes) || 1));
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.id === action.taskId ? { ...t, estimatedMinutes: minutes } : t,
        ),
      };
    }

    case 'setTaskDate':
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.id === action.taskId ? { ...t, date: action.date } : t,
        ),
      };

    case 'deleteTask':
      return {
        ...state,
        tasks: state.tasks.filter((t) => t.id !== action.taskId),
      };

    case 'setTaskActualMinutes': {
      const raw = action.minutes ?? (action as { actualMinutes?: number }).actualMinutes ?? 0;
      const min = Math.max(0, Math.min(720, isNaN(raw) ? 0 : Math.round(raw)));
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.id === action.taskId ? { ...t, actualMinutes: min } : t,
        ),
      };
    }

    case 'startTimer': {
      const task = state.tasks.find((t) => t.id === action.taskId);
      if (!task) return state;

      const now = action.now ?? Date.now();
      let tasks = state.tasks;

      // 若已有其他任務在計時中，先自動結算前一個任務的累計時間
      if (
        state.activeTimer &&
        state.activeTimer.isRunning &&
        state.activeTimer.taskId !== action.taskId
      ) {
        const seg = Math.max(0, Math.floor((now - state.activeTimer.startedAt) / 1000));
        const totalSec = state.activeTimer.accumulatedSeconds + seg;
        const addMin = Math.min(
          720,
          totalSec < 30 ? (totalSec > 0 ? 1 : 0) : Math.round(totalSec / 60),
        );
        if (addMin > 0) {
          tasks = tasks.map((t) =>
            t.id === state.activeTimer!.taskId
              ? {
                  ...t,
                  actualMinutes: (t.actualMinutes ?? 0) + addMin,
                  timerMinutes: (t.timerMinutes ?? 0) + addMin,
                }
              : t,
          );
        }
      }

      // 若目前任務已在計時中且正在跑，維持不變；若為暫停狀態，則繼續
      if (state.activeTimer && state.activeTimer.taskId === action.taskId) {
        if (state.activeTimer.isRunning) return state;
        return {
          ...state,
          activeTimer: {
            ...state.activeTimer,
            startedAt: now,
            isRunning: true,
          },
        };
      }

      return {
        ...state,
        tasks,
        activeTimer: {
          taskId: task.id,
          taskTitle: task.title,
          subjectName: task.subjectName,
          examId: task.examId,
          startedAt: now,
          accumulatedSeconds: 0,
          isRunning: true,
        },
      };
    }

    case 'pauseTimer': {
      if (!state.activeTimer || !state.activeTimer.isRunning) return state;
      const now = action.now ?? Date.now();
      const seg = Math.max(0, Math.floor((now - state.activeTimer.startedAt) / 1000));
      return {
        ...state,
        activeTimer: {
          ...state.activeTimer,
          accumulatedSeconds: state.activeTimer.accumulatedSeconds + seg,
          isRunning: false,
        },
      };
    }

    case 'resumeTimer': {
      if (!state.activeTimer || state.activeTimer.isRunning) return state;
      const now = action.now ?? Date.now();
      return {
        ...state,
        activeTimer: {
          ...state.activeTimer,
          startedAt: now,
          isRunning: true,
        },
      };
    }

    case 'stopTimer': {
      if (!state.activeTimer) return state;
      const now = action.now ?? Date.now();
      const targetTaskId = action.taskId ?? state.activeTimer.taskId;
      const seg = state.activeTimer.isRunning
        ? Math.max(0, Math.floor((now - state.activeTimer.startedAt) / 1000))
        : 0;
      const totalSec = state.activeTimer.accumulatedSeconds + seg;
      const addMin = Math.min(
        720,
        totalSec < 30 ? (totalSec > 0 ? 1 : 0) : Math.round(totalSec / 60),
      );
      const markAsDone = action.markAsDone ?? false;

      const tasks = state.tasks.map((t) => {
        if (t.id === targetTaskId) {
          return {
            ...t,
            actualMinutes: (t.actualMinutes ?? 0) + addMin,
            timerMinutes: (t.timerMinutes ?? 0) + addMin,
            ...(markAsDone
              ? { status: 'done' as const, completedAt: new Date(now).toISOString() }
              : {}),
          };
        }
        return t;
      });

      return {
        ...state,
        tasks,
        activeTimer: null,
      };
    }

    case 'discardTimer': {
      return {
        ...state,
        activeTimer: null,
      };
    }

    case 'createExamWithTasks': {
      // 若目前為示範資料狀態，或僅有 demo-toeic 示範考試，建立新考試時乾淨替換示範資料
      const isOnlyDemo =
        state.isDemo ||
        (state.exams.length === 1 && state.exams[0].id === 'demo-toeic');
      const exams = isOnlyDemo ? [action.exam] : [...state.exams, action.exam];
      const otherTasks = isOnlyDemo
        ? []
        : state.tasks.filter((t) => t.examId !== 'demo-toeic' || !state.isDemo);
      const tasks = [...otherTasks, ...action.tasks];
      return {
        ...state,
        exams,
        tasks,
        selectedExamId: action.exam.id,
        preferences: action.preferences ?? state.preferences,
        isDemo: false,
      };
    }

    case 'updateExam': {
      const exams = state.exams.map((e) => (e.id === action.exam.id ? action.exam : e));
      let tasks = state.tasks;
      if (action.updatedTasks) {
        // 替換該考試之所有任務（已完成任務會完整保留原狀）
        const otherTasks = state.tasks.filter((t) => t.examId !== action.exam.id);
        tasks = [...otherTasks, ...action.updatedTasks];
      } else {
        // 若未提供 updatedTasks（非排程變更），同步更新該考試所有任務之 subjectName
        tasks = state.tasks.map((t) => {
          if (t.examId !== action.exam.id) return t;
          const sub = action.exam.subjects.find((s) => s.id === t.subjectId);
          return {
            ...t,
            subjectName: sub?.name ?? t.subjectName,
          };
        });
      }
      const preferences = action.preferencesPatch
        ? { ...state.preferences, ...action.preferencesPatch }
        : state.preferences;

      return {
        ...state,
        exams,
        tasks,
        preferences,
      };
    }

    case 'toggleArchiveExam': {
      const targetExam = state.exams.find((e) => e.id === action.examId);
      if (!targetExam) return state;
      const willBeArchived = !targetExam.archived;

      // 資料層安全防護：Free 會員不得同時存在兩場以上進行中考試
      if (!willBeArchived) {
        const tier = getEffectiveTier(state.subscription);
        const entitlements = getPlanEntitlements(tier);
        const isOnlyDemo =
          state.isDemo || (state.exams.length === 1 && state.exams[0].id === 'demo-toeic');
        const realExams = isOnlyDemo ? [] : state.exams;
        const currentActiveCount = realExams.filter(
          (e) => !e.archived && e.id !== action.examId,
        ).length;
        if (currentActiveCount >= entitlements.maxActiveExams) {
          console.warn('[資料層安全防護] 解除封存被拒絕：已達會員方案進行中考試上限。');
          return state;
        }
      }

      const exams = state.exams.map((e) =>
        e.id === action.examId ? { ...e, archived: willBeArchived } : e,
      );
      const activeExams = exams.filter((e) => !e.archived);

      let selectedExamId = state.selectedExamId;
      if (willBeArchived) {
        // 封存此考試：若目前選取的正是此考試，自動切換至第一場其他進行中考試
        if (state.selectedExamId === action.examId) {
          selectedExamId = activeExams[0]?.id ?? undefined;
        }
      } else {
        // 解除封存：若目前沒有有效選取之進行中考試，自動選取剛解除封存的考試
        if (!selectedExamId || !activeExams.some((e) => e.id === selectedExamId)) {
          selectedExamId = action.examId;
        }
      }

      // 若正在進行計時且該計時屬於被封存的考試，安全清除計時
      const activeTimer =
        willBeArchived && state.activeTimer && state.activeTimer.examId === action.examId
          ? null
          : state.activeTimer;

      return {
        ...state,
        exams,
        selectedExamId,
        activeTimer,
      };
    }

    case 'applyRescheduledTasks': {
      // 替換該場考試的所有任務（其中已完成任務會完整保留原狀）
      const otherTasks = state.tasks.filter((t) => t.examId !== action.examId);
      return {
        ...state,
        tasks: [...otherTasks, ...action.updatedTasks],
      };
    }

    case 'deleteExam': {
      const exams = state.exams.filter((e) => e.id !== action.examId);
      const tasks = state.tasks.filter((t) => t.examId !== action.examId);
      const activeExams = exams.filter((e) => !e.archived);
      const selectedExamId =
        state.selectedExamId === action.examId ? (activeExams[0]?.id ?? undefined) : state.selectedExamId;
      const activeTimer =
        state.activeTimer && state.activeTimer.examId === action.examId ? null : state.activeTimer;
      return {
        ...state,
        exams,
        tasks,
        selectedExamId,
        activeTimer,
      };
    }

    case 'setSubscription':
      return {
        ...state,
        subscription: action.subscription,
      };

    case 'recordAiUsage': {
      const currentMonth = new Date().toISOString().slice(0, 7);
      const prevUsage = state.aiUsage ?? DEFAULT_AI_USAGE;
      const isNewMonth = prevUsage.lastResetMonth !== currentMonth;
      const baseCalls = isNewMonth ? 0 : prevUsage.monthlyCalls;
      const increment = action.increment ?? 1;
      return {
        ...state,
        aiUsage: {
          monthlyCalls: baseCalls + increment,
          lastResetMonth: currentMonth,
        },
      };
    }

    case 'updatePreferences':
      return { ...state, preferences: { ...state.preferences, ...action.patch } };

    case 'restoreStudyData': {
      const { exams, tasks, preferences, selectedExamId } = action.payload;
      const tier = getEffectiveTier(state.subscription);
      const entitlements = getPlanEntitlements(tier);

      // 1. 處理備份中的考試清單（支援舊版備份缺少 archived 屬性之向下相容）
      const incomingRawExams = exams.map((e) => ({
        id: e.id,
        name: e.name,
        examDate: e.examDate,
        subjects: (e.subjects || []).map((s) => ({
          id: s.id,
          name: s.name,
          familiarity: s.familiarity,
          chapters: (s.chapters || []).map((c) => ({
            id: c.id,
            title: c.title,
          })),
        })),
        createdAt: e.createdAt,
        archived: Boolean(e.archived),
      }));

      // 2. 決定保留為進行中的首選考試（若備份中有指定且為進行中，或第一場進行中考試）
      let primaryActiveExamId: string | undefined = incomingRawExams.find(
        (e) => !e.archived && e.id === selectedExamId,
      )?.id;
      if (!primaryActiveExamId) {
        primaryActiveExamId = incomingRawExams.find((e) => !e.archived)?.id;
      }

      let activeAllowedCount = 0;
      const normalizedExams = incomingRawExams.map((e) => {
        if (e.archived) {
          return e;
        }
        // 若符合進行中考試配額：
        // 優先讓首選考試保持進行中
        if (e.id === primaryActiveExamId && activeAllowedCount < entitlements.maxActiveExams) {
          activeAllowedCount++;
          return e;
        }
        if (activeAllowedCount < entitlements.maxActiveExams) {
          activeAllowedCount++;
          return e;
        }
        // 若超過目前會員方案上限（例如 Free 會員只允許 1 場進行中）：
        // 自動轉為「已封存」，完整保留所有科目、章節、任務與進度，絕不刪除資料！
        return {
          ...e,
          archived: true,
        };
      });

      const validSelectedId = normalizedExams.some((e) => e.id === selectedExamId && !e.archived)
        ? selectedExamId
        : normalizedExams.find((e) => !e.archived)?.id ?? normalizedExams[0]?.id;

      return {
        ...state,
        exams: normalizedExams,
        tasks: tasks.map((t) => ({
          id: t.id,
          examId: t.examId,
          subjectId: t.subjectId,
          subjectName: t.subjectName,
          chapterId: t.chapterId,
          title: t.title,
          kind: t.kind,
          date: t.date,
          estimatedMinutes: t.estimatedMinutes,
          actualMinutes: t.actualMinutes ?? 0,
          timerMinutes: t.timerMinutes ?? 0,
          status: t.status,
          completedAt: t.completedAt,
        })),
        preferences: {
          dailyMinutes: preferences.dailyMinutes,
          restDays: [...preferences.restDays],
          intensity: preferences.intensity,
        },
        selectedExamId: validSelectedId,
        isDemo: false,
        activeTimer: null, // 嚴格不恢復進行中的計時器
        subscription: state.subscription, // 嚴格保留原會員狀態，防偽造
        aiUsage: state.aiUsage, // 嚴格保留原 AI 額度與用量
      };
    }

    case 'loadDemo':
      return createDemoData();

    case 'clearAll':
      return INITIAL_EMPTY_DATA;

    default:
      return state;
  }
}

interface AppStore {
  data: AppData;
  isLoaded: boolean;
  selectedExamId?: string;
  setSelectedExamId: (examId: string) => void;
  setTaskStatus: (taskId: string, status: TaskStatus) => void;
  setTaskMinutes: (taskId: string, minutes: number) => void;
  setTaskActualMinutes: (taskId: string, minutes: number) => void;
  setTaskDate: (taskId: string, date: ISODate) => void;
  deleteTask: (taskId: string) => void;
  startTimer: (taskId: string) => void;
  pauseTimer: () => void;
  resumeTimer: () => void;
  stopTimer: (taskId?: string, markAsDone?: boolean) => void;
  discardTimer: () => void;
  createExamWithTasks: (
    exam: Exam,
    tasks: StudyTask[],
    preferences?: StudyPreferences,
  ) => Promise<void>;
  updateExam: (
    exam: Exam,
    updatedTasks?: StudyTask[],
    preferencesPatch?: Partial<StudyPreferences>,
  ) => Promise<void>;
  toggleArchiveExam: (examId: string) => boolean;
  applyRescheduledTasks: (examId: string, updatedTasks: StudyTask[]) => void;
  deleteExam: (examId: string) => void;
  updatePreferences: (patch: Partial<StudyPreferences>) => void;
  setSubscription: (subscription: UserSubscription) => void;
  recordAiUsage: (increment?: number) => void;
  restoreStudyData: (
    backupStudyData: BackupStudyData,
  ) => Promise<{ success: boolean; error?: string; autoArchivedCount?: number }>;
  loadDemo: () => void;
  clearAll: () => void;
}

const AppStoreContext = createContext<AppStore | null>(null);

export function AppStoreProvider({
  children,
  initialData,
}: {
  children: ReactNode;
  initialData?: AppData;
}) {
  const [data, dispatch] = useReducer(reducer, initialData ?? INITIAL_EMPTY_DATA);
  const [isLoaded, setIsLoaded] = useState<boolean>(!!initialData);
  const dataRef = useRef<AppData>(data);
  const isRestoringRef = useRef<boolean>(false);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  // 1. 初始化時從 AsyncStorage 載入
  useEffect(() => {
    if (initialData) return;
    let isMounted = true;
    loadAppDataFromStorage().then((saved) => {
      if (isMounted) {
        if (saved && saved.exams.length > 0) {
          // 檢查計時器狀態，避免因長時間關閉 App 導致計時異常超額
          let activeTimer = saved.activeTimer;
          if (activeTimer && activeTimer.isRunning) {
            const elapsed = Math.floor((Date.now() - activeTimer.startedAt) / 1000);
            if (elapsed > 12 * 3600) {
              activeTimer = {
                ...activeTimer,
                isRunning: false,
                accumulatedSeconds: activeTimer.accumulatedSeconds + Math.min(elapsed, 4 * 3600),
              };
            }
          }
          // 若無 selectedExamId，優先選取有任務的考試或即將到來的考試
          const examWithTasks = saved.exams.find((e) =>
            saved.tasks.some((t) => t.examId === e.id),
          );
          const effectiveSelected = saved.selectedExamId ?? examWithTasks?.id ?? saved.exams[0]?.id;
          dispatch({
            type: 'setData',
            data: {
              ...saved,
              activeTimer,
              selectedExamId: effectiveSelected,
              subscription: normalizeSubscriptionOnLoad(saved.subscription),
              aiUsage: saved.aiUsage ?? DEFAULT_AI_USAGE,
            },
          });
        } else if (saved) {
          dispatch({
            type: 'setData',
            data: {
              ...saved,
              subscription: normalizeSubscriptionOnLoad(saved.subscription),
              aiUsage: saved.aiUsage ?? DEFAULT_AI_USAGE,
            },
          });
        } else {
          // 首次開啟且無本機儲存資料：維持 INITIAL_EMPTY_DATA，等待使用者建立第一場考試
          dispatch({ type: 'setData', data: INITIAL_EMPTY_DATA });
        }
        setIsLoaded(true);
      }
    });
    return () => {
      isMounted = false;
    };
  }, [initialData]);

  // 2. 狀態變更時自動同步寫入本機儲存（還原作業進行中時暫停 auto-save 以防競態）
  useEffect(() => {
    if (isLoaded && !isRestoringRef.current) {
      saveAppDataToStorage(data);
    }
  }, [data, isLoaded]);

  const store = useMemo<AppStore>(
    () => ({
      data,
      isLoaded,
      selectedExamId: data.selectedExamId,
      setSelectedExamId: (examId: string) => dispatch({ type: 'setSelectedExam', examId }),
      setTaskStatus: (taskId, status) => dispatch({ type: 'setTaskStatus', taskId, status }),
      setTaskMinutes: (taskId, minutes) => dispatch({ type: 'setTaskMinutes', taskId, minutes }),
      setTaskActualMinutes: (taskId, minutes) =>
        dispatch({ type: 'setTaskActualMinutes', taskId, minutes }),
      setTaskDate: (taskId, date) => dispatch({ type: 'setTaskDate', taskId, date }),
      deleteTask: (taskId) => dispatch({ type: 'deleteTask', taskId }),
      startTimer: (taskId) => dispatch({ type: 'startTimer', taskId }),
      pauseTimer: () => dispatch({ type: 'pauseTimer' }),
      resumeTimer: () => dispatch({ type: 'resumeTimer' }),
      stopTimer: (taskId, markAsDone) => dispatch({ type: 'stopTimer', taskId, markAsDone }),
      discardTimer: () => dispatch({ type: 'discardTimer' }),
      createExamWithTasks: async (exam, tasks, preferences) => {
        const nextState = reducer(data, {
          type: 'createExamWithTasks',
          exam,
          tasks,
          preferences,
        });
        dispatch({ type: 'createExamWithTasks', exam, tasks, preferences });
        await saveAppDataToStorage(nextState);
      },
      updateExam: async (exam, updatedTasks, preferencesPatch) => {
        const nextState = reducer(data, {
          type: 'updateExam',
          exam,
          updatedTasks,
          preferencesPatch,
        });
        dispatch({ type: 'updateExam', exam, updatedTasks, preferencesPatch });
        await saveAppDataToStorage(nextState);
      },
      toggleArchiveExam: (examId: string) => {
        const target = dataRef.current.exams.find((e) => e.id === examId);
        if (target && target.archived) {
          const tier = getEffectiveTier(dataRef.current.subscription);
          const entitlements = getPlanEntitlements(tier);
          const isOnlyDemo =
            dataRef.current.isDemo ||
            (dataRef.current.exams.length === 1 && dataRef.current.exams[0].id === 'demo-toeic');
          const realExams = isOnlyDemo ? [] : dataRef.current.exams;
          const currentActiveCount = realExams.filter(
            (e) => !e.archived && e.id !== examId,
          ).length;
          if (currentActiveCount >= entitlements.maxActiveExams) {
            return false;
          }
        }
        dispatch({ type: 'toggleArchiveExam', examId });
        return true;
      },
      applyRescheduledTasks: (examId, updatedTasks) =>
        dispatch({ type: 'applyRescheduledTasks', examId, updatedTasks }),
      deleteExam: (examId) => dispatch({ type: 'deleteExam', examId }),
      updatePreferences: (patch) => dispatch({ type: 'updatePreferences', patch }),
      setSubscription: (subscription) => dispatch({ type: 'setSubscription', subscription }),
      recordAiUsage: (increment) => dispatch({ type: 'recordAiUsage', increment }),
      restoreStudyData: async (backupStudyData: BackupStudyData) => {
        if (isRestoringRef.current) {
          return { success: false, error: '正在進行還原作業，請稍候。' };
        }
        isRestoringRef.current = true;
        try {
          const currentState = dataRef.current;
          const tier = getEffectiveTier(currentState.subscription);
          const entitlements = getPlanEntitlements(tier);
          const incomingActiveCount = backupStudyData.exams.filter((e) => !e.archived).length;
          const autoArchivedCount = Math.max(0, incomingActiveCount - entitlements.maxActiveExams);

          const nextState = reducer(currentState, {
            type: 'restoreStudyData',
            payload: backupStudyData,
          });
          const result = await safeRestoreAppDataToStorage(nextState);
          if (!result.success) {
            return {
              success: false,
              error: result.error ?? '本機儲存寫入失敗，已保留原有資料。',
            };
          }
          dispatch({ type: 'restoreStudyData', payload: backupStudyData });
          return { success: true, autoArchivedCount };
        } finally {
          setTimeout(() => {
            isRestoringRef.current = false;
          }, 100);
        }
      },
      loadDemo: () => {
        dispatch({ type: 'loadDemo' });
      },
      clearAll: () => {
        dispatch({ type: 'clearAll' });
        clearAppDataFromStorage();
      },
    }),
    [data, isLoaded],
  );

  return <AppStoreContext.Provider value={store}>{children}</AppStoreContext.Provider>;
}

export function useAppStore(): AppStore {
  const ctx = useContext(AppStoreContext);
  if (!ctx) throw new Error('useAppStore 必須在 AppStoreProvider 內使用');
  return ctx;
}

/** 產生不重複的 id（不影響排程結果，只用於識別資料） */
let idCounter = 0;
export function createId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}
