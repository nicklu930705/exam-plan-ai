import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';

import { loadAppDataFromStorage, saveAppDataToStorage } from '../../storage';
import {
  DEFAULT_PREFERENCES,
  INITIAL_EMPTY_DATA,
  reducer,
} from '../../store/AppStore';
import type { BackupStudyData } from '../../types/backup';
import type { AppData, Exam, StudyTask } from '../../types/models';
import {
  createBackupPayload,
  exportBackupToFile,
  getBackupFilename,
  pickAndReadBackupFile,
  validateBackupJson,
} from '../backupService';

// 模擬 AsyncStorage
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// 模擬 expo-sharing
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(),
  shareAsync: jest.fn(),
}));

// 模擬 expo-document-picker
jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(),
}));

// 模擬 expo-file-system
jest.mock('expo-file-system', () => {
  class MockFile {
    uri: string;
    exists = false;
    static writtenContent = '';
    constructor(...uris: any[]) {
      this.uri = uris
        .map((u) => (typeof u === 'object' && u?.uri ? u.uri : String(u)))
        .join('/');
    }
    create() {
      this.exists = true;
    }
    write(content: string) {
      MockFile.writtenContent = content;
    }
    delete() {
      this.exists = false;
    }
    async text() {
      return MockFile.writtenContent;
    }
  }
  return {
    File: MockFile,
    Paths: {
      cache: { uri: 'file:///mock/cache' },
      document: { uri: 'file:///mock/document' },
    },
  };
});

describe('讀書資料備份與還原服務 (Backup & Restore Service)', () => {
  const sampleExam: Exam = {
    id: 'exam-sample-1',
    name: '多益英語衝刺',
    examDate: '2026-11-30',
    subjects: [
      {
        id: 'subj-1',
        name: '聽力',
        familiarity: 2,
        chapters: [{ id: 'chap-1', title: '題型解析' }],
      },
    ],
    createdAt: '2026-10-16T12:00:00.000Z',
  };

  const sampleTask: StudyTask = {
    id: 'task-sample-1',
    examId: 'exam-sample-1',
    subjectId: 'subj-1',
    subjectName: '聽力',
    chapterId: 'chap-1',
    title: '題型解析精讀',
    kind: 'study',
    date: '2026-10-17',
    estimatedMinutes: 60,
    actualMinutes: 45,
    timerMinutes: 45,
    status: 'pending',
  };

  const sampleAppData: AppData = {
    exams: [sampleExam],
    tasks: [sampleTask],
    preferences: {
      dailyMinutes: 90,
      restDays: [0, 6],
      intensity: 'intense',
    },
    selectedExamId: 'exam-sample-1',
    isDemo: false,
    activeTimer: {
      taskId: 'task-sample-1',
      taskTitle: '題型解析精讀',
      startedAt: Date.now() - 60000,
      accumulatedSeconds: 120,
      isRunning: true,
    },
    subscription: {
      plan: 'free',
      billingCycle: 'none',
      status: 'none',
    },
    aiUsage: {
      monthlyCalls: 2,
      lastResetMonth: '2026-10',
    },
  };

  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
    (Sharing.isAvailableAsync as jest.Mock).mockResolvedValue(true);
    (Sharing.shareAsync as jest.Mock).mockResolvedValue(undefined);
  });

  // 1. 正常資料匯出
  test('1. 正常資料匯出：產出合規結構且絕不外洩敏感資訊', () => {
    const payload = createBackupPayload(sampleAppData, '1.0.0');

    expect(payload.schemaVersion).toBe(1);
    expect(payload.appName).toBe('考試計畫 AI');
    expect(payload.appVersion).toBe('1.0.0');
    expect(typeof payload.exportedAt).toBe('string');
    expect(isNaN(Date.parse(payload.exportedAt))).toBe(false);

    // 檢查包含的讀書資料
    expect(payload.studyData.exams).toHaveLength(1);
    expect(payload.studyData.exams[0].name).toBe('多益英語衝刺');
    expect(payload.studyData.tasks).toHaveLength(1);
    expect(payload.studyData.tasks[0].title).toBe('題型解析精讀');
    expect(payload.studyData.preferences.dailyMinutes).toBe(90);
    expect(payload.studyData.preferences.restDays).toEqual([0, 6]);
    expect(payload.studyData.preferences.intensity).toBe('intense');

    // 嚴格確認不備份敏感資訊
    const anyPayload = payload as any;
    expect(anyPayload.subscription).toBeUndefined();
    expect(anyPayload.studyData.subscription).toBeUndefined();
    expect(anyPayload.aiUsage).toBeUndefined();
    expect(anyPayload.studyData.aiUsage).toBeUndefined();
    expect(anyPayload.activeTimer).toBeUndefined();
    expect(anyPayload.studyData.activeTimer).toBeUndefined();
    expect(anyPayload.deviceId).toBeUndefined();
    expect(anyPayload.backendUrl).toBeUndefined();

    // 檔名格式驗證
    const filename = getBackupFilename(new Date('2026-10-16T12:00:00Z'));
    expect(filename).toBe('考試計畫AI_備份_2026-10-16.json');
  });

  // 2. 空白資料匯出
  test('2. 空白資料匯出：無考試與任務時仍可正確產出有效空白結構', () => {
    const emptyPayload = createBackupPayload(INITIAL_EMPTY_DATA, '1.0.0');

    expect(emptyPayload.schemaVersion).toBe(1);
    expect(emptyPayload.studyData.exams).toEqual([]);
    expect(emptyPayload.studyData.tasks).toEqual([]);
    expect(emptyPayload.studyData.preferences.dailyMinutes).toBe(120);

    const jsonStr = JSON.stringify(emptyPayload);
    const validation = validateBackupJson(jsonStr);
    expect(validation.isValid).toBe(true);
  });

  // 3. 正常備份還原
  test('3. 正常備份還原：解析並將資料完整寫入 AppStore', () => {
    const payload = createBackupPayload(sampleAppData, '1.0.0');
    const jsonStr = JSON.stringify(payload);

    const validation = validateBackupJson(jsonStr);
    expect(validation.isValid).toBe(true);
    if (!validation.isValid) return;

    const nextState = reducer(INITIAL_EMPTY_DATA, {
      type: 'restoreStudyData',
      payload: validation.payload.studyData,
    });

    expect(nextState.exams).toHaveLength(1);
    expect(nextState.exams[0].name).toBe('多益英語衝刺');
    expect(nextState.tasks).toHaveLength(1);
    expect(nextState.preferences.dailyMinutes).toBe(90);
    expect(nextState.selectedExamId).toBe('exam-sample-1');
  });

  // 4. 不合法 JSON
  test('4. 不合法 JSON：非 JSON 字串時拒絕並明確報錯', () => {
    const invalidJson = '{ corrupted JSON data: [missing bracket';
    const validation = validateBackupJson(invalidJson);

    expect(validation.isValid).toBe(false);
    if (!validation.isValid) {
      expect(validation.error).toContain('無法解析為 JSON');
    }
  });

  // 5. 不支援 schemaVersion
  test('5. 不支援 schemaVersion：當版本不為 1 時拒絕還原', () => {
    const payload = createBackupPayload(sampleAppData, '1.0.0') as any;
    payload.schemaVersion = 99;

    const validation = validateBackupJson(JSON.stringify(payload));
    expect(validation.isValid).toBe(false);
    if (!validation.isValid) {
      expect(validation.error).toContain('不支援的備份版本');
    }
  });

  // 6. 缺少必要欄位
  test('6. 缺少必要欄位：缺少 studyData、exams、tasks 或 preferences 時拒絕', () => {
    // 缺少 studyData
    const missingStudyData = {
      schemaVersion: 1,
      appName: '考試計畫 AI',
      exportedAt: new Date().toISOString(),
    };
    expect(validateBackupJson(JSON.stringify(missingStudyData)).isValid).toBe(false);

    // 缺少 exams
    const missingExams = {
      ...createBackupPayload(sampleAppData),
      studyData: {
        tasks: [],
        preferences: DEFAULT_PREFERENCES,
      },
    };
    expect(validateBackupJson(JSON.stringify(missingExams)).isValid).toBe(false);

    // 缺少 tasks
    const missingTasks = {
      ...createBackupPayload(sampleAppData),
      studyData: {
        exams: [],
        preferences: DEFAULT_PREFERENCES,
      },
    };
    expect(validateBackupJson(JSON.stringify(missingTasks)).isValid).toBe(false);

    // 缺少 preferences
    const missingPreferences = {
      ...createBackupPayload(sampleAppData),
      studyData: {
        exams: [],
        tasks: [],
      },
    };
    expect(validateBackupJson(JSON.stringify(missingPreferences)).isValid).toBe(false);
  });

  // 7. 考試與任務關聯不一致
  test('7. 考試與任務關聯不一致：任務指向不存在的考試或科目時嚴格拒絕', () => {
    const payload = createBackupPayload(sampleAppData, '1.0.0');

    // 任務關聯到不存在的考試
    const orphanedTask: StudyTask = {
      ...sampleTask,
      id: 'task-orphaned',
      examId: 'non-existing-exam-999',
    };
    const invalidExamRelation = {
      ...payload,
      studyData: {
        ...payload.studyData,
        tasks: [orphanedTask],
      },
    };
    const res1 = validateBackupJson(JSON.stringify(invalidExamRelation));
    expect(res1.isValid).toBe(false);
    if (!res1.isValid) {
      expect(res1.error).toContain('考試與任務關聯不一致');
    }

    // 任務關聯到不存在的科目
    const invalidSubjTask: StudyTask = {
      ...sampleTask,
      id: 'task-invalid-subj',
      subjectId: 'non-existing-subj-888',
    };
    const invalidSubjRelation = {
      ...payload,
      studyData: {
        ...payload.studyData,
        tasks: [invalidSubjTask],
      },
    };
    const res2 = validateBackupJson(JSON.stringify(invalidSubjRelation));
    expect(res2.isValid).toBe(false);
    if (!res2.isValid) {
      expect(res2.error).toContain('科目與任務關聯不一致');
    }
  });

  // 8. 使用者取消操作
  test('8. 使用者取消操作：文件選取取消時安靜處理，不報錯不更動資料', async () => {
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({
      canceled: true,
      assets: null,
    });

    const pickResult = await pickAndReadBackupFile();
    expect(pickResult.status).toBe('cancelled');
  });

  // 9. 重複匯入不產生重複資料
  test('9. 重複匯入不產生重複資料：以覆蓋模式還原，多次還原數量不倍增', () => {
    const payload = createBackupPayload(sampleAppData, '1.0.0');

    // 第一次還原
    let state = reducer(INITIAL_EMPTY_DATA, {
      type: 'restoreStudyData',
      payload: payload.studyData,
    });
    expect(state.exams).toHaveLength(1);
    expect(state.tasks).toHaveLength(1);

    // 第二次還原相同備份
    state = reducer(state, {
      type: 'restoreStudyData',
      payload: payload.studyData,
    });
    expect(state.exams).toHaveLength(1);
    expect(state.tasks).toHaveLength(1);
  });

  // 10. AsyncStorage 寫入失敗
  test('10. AsyncStorage 寫入失敗：儲存層拋錯時返回失敗且不更動現有狀態', async () => {
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('磁碟空間已滿'));

    const saved = await saveAppDataToStorage(sampleAppData);
    expect(saved).toBe(false);
  });

  // 11. 不得透過備份偽造會員權限
  test('11. 不得透過備份偽造會員權限：即使備份內惡意注入 Pro/Lifetime，還原後使用者方案保持不變', () => {
    const userState: AppData = {
      ...INITIAL_EMPTY_DATA,
      subscription: {
        plan: 'free',
        billingCycle: 'none',
        status: 'none',
      },
    };

    // 惡意偽造的備份 payload 嘗試帶入 lifetime 方案
    const maliciousStudyData: BackupStudyData & { subscription?: any; plan?: string } = {
      exams: [sampleExam],
      tasks: [sampleTask],
      preferences: DEFAULT_PREFERENCES,
      subscription: {
        plan: 'lifetime',
        status: 'active',
      },
      plan: 'lifetime',
    };

    const nextState = reducer(userState, {
      type: 'restoreStudyData',
      payload: maliciousStudyData as BackupStudyData,
    });

    // 方案維持原本的 free，絕不因備份檔而升級為 lifetime
    expect(nextState.subscription?.plan).toBe('free');
  });

  // 12. 不恢復裝置識別碼和 AI 額度
  test('12. 不恢復裝置識別碼和 AI 額度：當前裝置之 aiUsage 完整保留', () => {
    const userState: AppData = {
      ...INITIAL_EMPTY_DATA,
      aiUsage: {
        monthlyCalls: 5,
        lastResetMonth: '2026-10',
      },
    };

    const backupPayload = createBackupPayload(sampleAppData, '1.0.0');

    const nextState = reducer(userState, {
      type: 'restoreStudyData',
      payload: backupPayload.studyData,
    });

    // 現有 aiUsage 維持 5，不被覆蓋為預設值或備份值
    expect(nextState.aiUsage?.monthlyCalls).toBe(5);
    expect(nextState.aiUsage?.lastResetMonth).toBe('2026-10');
  });

  // 13. 不恢復進行中的計時器
  test('13. 不恢復進行中的計時器：還原後 activeTimer 必定為 null', () => {
    const userStateWithTimer: AppData = {
      ...sampleAppData,
      activeTimer: {
        taskId: 'task-sample-1',
        taskTitle: '題型解析精讀',
        startedAt: Date.now() - 3600000,
        accumulatedSeconds: 300,
        isRunning: true,
      },
    };

    const backupPayload = createBackupPayload(sampleAppData, '1.0.0');

    const nextState = reducer(userStateWithTimer, {
      type: 'restoreStudyData',
      payload: backupPayload.studyData,
    });

    // activeTimer 必須被清除為 null，防止跨裝置/跨時間出現計時幽靈
    expect(nextState.activeTimer).toBeNull();
  });

  // 14. 更新既有版本後資料相容
  test('14. 更新既有版本後資料相容：既有 AsyncStorage 資料格式讀寫完全相容', async () => {
    // 模擬既有舊版儲存格式（@exam_plan_ai:v1_data）
    await AsyncStorage.setItem(
      '@exam_plan_ai:v1_data',
      JSON.stringify({
        exams: [sampleExam],
        tasks: [sampleTask],
        preferences: DEFAULT_PREFERENCES,
        isDemo: false,
      }),
    );

    const loaded = await loadAppDataFromStorage();
    expect(loaded).not.toBeNull();
    expect(loaded?.exams).toHaveLength(1);
    expect(loaded?.exams[0].name).toBe('多益英語衝刺');

    // 將舊版讀取出的資料建立備份
    const payload = createBackupPayload(loaded!);
    expect(payload.schemaVersion).toBe(1);
    expect(payload.studyData.exams[0].name).toBe('多益英語衝刺');

    // 重新寫入後亦能正常還原
    const validation = validateBackupJson(JSON.stringify(payload));
    expect(validation.isValid).toBe(true);
  });

  // 15. 系統檔案分享流程驗證
  test('15. 系統檔案分享流程：當分享功能可用時，正確呼叫 Sharing.shareAsync', async () => {
    const payload = createBackupPayload(sampleAppData, '1.0.0');
    const result = await exportBackupToFile(payload);
    expect(result.success).toBe(true);
    expect(Sharing.shareAsync).toHaveBeenCalledWith(
      expect.stringContaining('考試計畫AI_備份_'),
      expect.objectContaining({
        mimeType: 'application/json',
        UTI: 'public.json',
      }),
    );
  });

  // 16. 重複識別碼（ID）嚴格拒絕
  test('16. 重複識別碼檢驗：包含重複之 exam ID、subject ID 或 task ID 時拒絕匯入', () => {
    const payload = createBackupPayload(sampleAppData, '1.0.0');

    // 重複 exam ID
    const duplicateExam = { ...sampleExam };
    const invalidExams = {
      ...payload,
      studyData: {
        ...payload.studyData,
        exams: [sampleExam, duplicateExam],
      },
    };
    const resExam = validateBackupJson(JSON.stringify(invalidExams));
    expect(resExam.isValid).toBe(false);
    if (!resExam.isValid) {
      expect(resExam.error).toContain('重複的考試識別碼');
    }

    // 重複 subject ID
    const examWithDupSubjects: Exam = {
      ...sampleExam,
      subjects: [
        { id: 'subj-dup', name: '科目A', familiarity: 2, chapters: [] },
        { id: 'subj-dup', name: '科目B', familiarity: 1, chapters: [] },
      ],
    };
    const invalidSubjects = {
      ...payload,
      studyData: {
        ...payload.studyData,
        exams: [examWithDupSubjects],
        tasks: [],
      },
    };
    const resSubj = validateBackupJson(JSON.stringify(invalidSubjects));
    expect(resSubj.isValid).toBe(false);
    if (!resSubj.isValid) {
      expect(resSubj.error).toContain('重複的科目識別碼');
    }

    // 重複 task ID
    const dupTask = { ...sampleTask };
    const invalidTasks = {
      ...payload,
      studyData: {
        ...payload.studyData,
        tasks: [sampleTask, dupTask],
      },
    };
    const resTask = validateBackupJson(JSON.stringify(invalidTasks));
    expect(resTask.isValid).toBe(false);
    if (!resTask.isValid) {
      expect(resTask.error).toContain('重複的任務識別碼');
    }
  });

  // 17. 跨考試科目關聯錯置檢驗
  test('17. 跨考試關聯檢驗：任務之 subjectId 雖存在於其他考試，但不屬於所屬 exam 時拒絕', () => {
    const examA: Exam = {
      id: 'exam-A',
      name: '考試A',
      examDate: '2026-11-20',
      subjects: [{ id: 'subj-A', name: '科目A', familiarity: 2, chapters: [] }],
      createdAt: '2026-10-16T12:00:00.000Z',
    };
    const examB: Exam = {
      id: 'exam-B',
      name: '考試B',
      examDate: '2026-12-20',
      subjects: [{ id: 'subj-B', name: '科目B', familiarity: 2, chapters: [] }],
      createdAt: '2026-10-16T12:00:00.000Z',
    };
    // 任務所屬 exam-A，但 subjectId 卻指向 exam-B 的 subj-B
    const mismatchTask: StudyTask = {
      id: 'task-mismatch',
      examId: 'exam-A',
      subjectId: 'subj-B',
      title: '錯置任務',
      kind: 'study',
      date: '2026-10-18',
      estimatedMinutes: 60,
      status: 'pending',
    };

    const payload = {
      ...createBackupPayload(sampleAppData, '1.0.0'),
      studyData: {
        exams: [examA, examB],
        tasks: [mismatchTask],
        preferences: DEFAULT_PREFERENCES,
      },
    };

    const res = validateBackupJson(JSON.stringify(payload));
    expect(res.isValid).toBe(false);
    if (!res.isValid) {
      expect(res.error).toContain('不屬於該場考試');
    }
  });

  // 18. 非法或不存在的公曆日期檢驗
  test('18. 公曆日期檢驗：不存在之 2 月 31 日、0000 年或超過 2100 年均嚴格拒絕', () => {
    const payload = createBackupPayload(sampleAppData, '1.0.0');

    // 2 月 31 日（不存在的日期）
    const leapExam: Exam = {
      ...sampleExam,
      examDate: '2026-02-31',
    };
    const resFeb31 = validateBackupJson(
      JSON.stringify({
        ...payload,
        studyData: { ...payload.studyData, exams: [leapExam], tasks: [] },
      }),
    );
    expect(resFeb31.isValid).toBe(false);
    if (!resFeb31.isValid) {
      expect(resFeb31.error).toContain('非有效公曆日期');
    }

    // 0000-00-00
    const resZeroDate = validateBackupJson(
      JSON.stringify({
        ...payload,
        studyData: {
          ...payload.studyData,
          exams: [{ ...sampleExam, examDate: '0000-00-00' }],
          tasks: [],
        },
      }),
    );
    expect(resZeroDate.isValid).toBe(false);

    // 任務非法日期（第 13 個月）
    const resTaskDate = validateBackupJson(
      JSON.stringify({
        ...payload,
        studyData: {
          ...payload.studyData,
          tasks: [{ ...sampleTask, date: '2026-13-45' }],
        },
      }),
    );
    expect(resTaskDate.isValid).toBe(false);
  });

  // 19. 不合理的分鐘數與時間數值檢驗
  test('19. 時間數值檢驗：預估時間 <= 0、> 1440 或非整數均拒絕', () => {
    const payload = createBackupPayload(sampleAppData, '1.0.0');

    // 預估時間為 0
    const resZeroMin = validateBackupJson(
      JSON.stringify({
        ...payload,
        studyData: {
          ...payload.studyData,
          tasks: [{ ...sampleTask, estimatedMinutes: 0 }],
        },
      }),
    );
    expect(resZeroMin.isValid).toBe(false);

    // 預估時間為負數
    const resNegMin = validateBackupJson(
      JSON.stringify({
        ...payload,
        studyData: {
          ...payload.studyData,
          tasks: [{ ...sampleTask, estimatedMinutes: -30 }],
        },
      }),
    );
    expect(resNegMin.isValid).toBe(false);

    // 預估時間過大（2000 分鐘）
    const resHugeMin = validateBackupJson(
      JSON.stringify({
        ...payload,
        studyData: {
          ...payload.studyData,
          tasks: [{ ...sampleTask, estimatedMinutes: 2000 }],
        },
      }),
    );
    expect(resHugeMin.isValid).toBe(false);

    // 預估時間非整數
    const resFloatMin = validateBackupJson(
      JSON.stringify({
        ...payload,
        studyData: {
          ...payload.studyData,
          tasks: [{ ...sampleTask, estimatedMinutes: 45.5 }],
        },
      }),
    );
    expect(resFloatMin.isValid).toBe(false);

    // 讀書偏好每日時間過小（< 15 分鐘）
    const resSmallPref = validateBackupJson(
      JSON.stringify({
        ...payload,
        studyData: {
          ...payload.studyData,
          preferences: { ...DEFAULT_PREFERENCES, dailyMinutes: 10 },
        },
      }),
    );
    expect(resSmallPref.isValid).toBe(false);
  });

  // 20. 惡意欄位外掛防禦（Privilege & Identity Isolation）
  test('20. 惡意欄位隔離防禦：外部 JSON 同時注入 subscription、aiUsage、activeTimer、backendUrl、deviceId 全數被過濾隔離', () => {
    const maliciousJson = JSON.stringify({
      schemaVersion: 1,
      appName: '考試計畫 AI',
      exportedAt: '2026-10-16T12:00:00.000Z',
      subscription: { plan: 'lifetime', status: 'active' },
      aiUsage: { monthlyCalls: 0, lastResetMonth: '2026-10' },
      activeTimer: { isRunning: true, taskId: 'hacked-task', startedAt: Date.now(), accumulatedSeconds: 0 },
      backendUrl: 'https://malicious-attacker.com',
      deviceId: 'fake-hacked-device-id',
      studyData: {
        exams: [sampleExam],
        tasks: [sampleTask],
        preferences: DEFAULT_PREFERENCES,
        selectedExamId: sampleExam.id,
        subscription: { plan: 'lifetime' },
        aiUsage: { monthlyCalls: 0 },
        activeTimer: { isRunning: true },
        backendUrl: 'https://malicious-attacker.com',
        deviceId: 'fake-hacked-device-id',
      },
    });

    const validation = validateBackupJson(maliciousJson);
    expect(validation.isValid).toBe(true);
    if (!validation.isValid) return;

    // 驗證生成的 cleanPayload 頂層與 studyData 均不包含任何外掛欄位
    const payload = validation.payload as any;
    expect(payload.subscription).toBeUndefined();
    expect(payload.aiUsage).toBeUndefined();
    expect(payload.activeTimer).toBeUndefined();
    expect(payload.backendUrl).toBeUndefined();
    expect(payload.deviceId).toBeUndefined();
    expect(payload.studyData.subscription).toBeUndefined();
    expect(payload.studyData.aiUsage).toBeUndefined();
    expect(payload.studyData.backendUrl).toBeUndefined();
    expect(payload.studyData.deviceId).toBeUndefined();

    // 模擬使用者現有狀態（free 方案、7 次 AI 呼叫）
    const initialUserAppState: AppData = {
      ...INITIAL_EMPTY_DATA,
      subscription: {
        plan: 'free',
        billingCycle: 'none',
        status: 'none',
      },
      aiUsage: {
        monthlyCalls: 7,
        lastResetMonth: '2026-10',
      },
      activeTimer: null,
    };

    const nextState = reducer(initialUserAppState, {
      type: 'restoreStudyData',
      payload: validation.payload.studyData,
    });

    // 驗證核心狀態絕不被篡改
    expect(nextState.subscription?.plan).toBe('free');
    expect(nextState.aiUsage?.monthlyCalls).toBe(7);
    expect(nextState.activeTimer).toBeNull();
  });

  // 21. 已完成任務進度與讀書偏好完整保留
  test('21. 進度與偏好完整保留：包含已完成狀態、完成時間、實際累計時間與偏好設定均完整還原', () => {
    const completedTask: StudyTask = {
      ...sampleTask,
      id: 'task-completed-1',
      status: 'done',
      completedAt: '2026-10-16T15:30:00.000Z',
      actualMinutes: 75,
      timerMinutes: 60,
    };

    const payload = createBackupPayload({
      exams: [sampleExam],
      tasks: [completedTask],
      preferences: {
        dailyMinutes: 180,
        restDays: [0, 6],
        intensity: 'intense',
      },
      isDemo: false,
      selectedExamId: sampleExam.id,
    });

    const validation = validateBackupJson(JSON.stringify(payload));
    expect(validation.isValid).toBe(true);
    if (!validation.isValid) return;

    const restoredState = reducer(INITIAL_EMPTY_DATA, {
      type: 'restoreStudyData',
      payload: validation.payload.studyData,
    });

    expect(restoredState.tasks[0].status).toBe('done');
    expect(restoredState.tasks[0].completedAt).toBe('2026-10-16T15:30:00.000Z');
    expect(restoredState.tasks[0].actualMinutes).toBe(75);
    expect(restoredState.tasks[0].timerMinutes).toBe(60);
    expect(restoredState.preferences.dailyMinutes).toBe(180);
    expect(restoredState.preferences.restDays).toEqual([0, 6]);
    expect(restoredState.preferences.intensity).toBe('intense');
  });

  // 22. 封存狀態完整匯出與還原
  test('22. 封存狀態完整匯出與還原：已封存考試匯出後包含 archived: true，還原後維持封存狀態', () => {
    const archivedExam: Exam = {
      ...sampleExam,
      id: 'exam-archived-1',
      name: '已封存多益',
      archived: true,
    };
    const payload = createBackupPayload({
      exams: [archivedExam],
      tasks: [{ ...sampleTask, examId: 'exam-archived-1' }],
      preferences: DEFAULT_PREFERENCES,
      isDemo: false,
    });

    expect(payload.studyData.exams[0].archived).toBe(true);

    const validation = validateBackupJson(JSON.stringify(payload));
    expect(validation.isValid).toBe(true);
    if (!validation.isValid) return;

    const restoredState = reducer(INITIAL_EMPTY_DATA, {
      type: 'restoreStudyData',
      payload: validation.payload.studyData,
    });

    expect(restoredState.exams[0].archived).toBe(true);
  });

  // 23. 封存欄位型別驗證與舊版向後相容
  test('23. 封存欄位驗證：非布林值之 archived 被拒絕，省略 archived 的舊版備份合法通過', () => {
    const rawPayload: any = createBackupPayload({
      exams: [sampleExam],
      tasks: [sampleTask],
      preferences: DEFAULT_PREFERENCES,
      isDemo: false,
    });

    // 非布林值
    rawPayload.studyData.exams[0].archived = 'true';
    const invalidRes = validateBackupJson(JSON.stringify(rawPayload));
    expect(invalidRes.isValid).toBe(false);
    if (!invalidRes.isValid) {
      expect(invalidRes.error).toContain('封存狀態格式不正確');
    }

    // 省略 archived（舊版備份）
    delete rawPayload.studyData.exams[0].archived;
    const legacyRes = validateBackupJson(JSON.stringify(rawPayload));
    expect(legacyRes.isValid).toBe(true);

    if (legacyRes.isValid) {
      const restored = reducer(INITIAL_EMPTY_DATA, {
        type: 'restoreStudyData',
        payload: legacyRes.payload.studyData,
      });
      expect(restored.exams[0].archived).toBe(false);
    }
  });

  // 24. Free 會員匯入多場進行中考試時的安全處理：不刪除任何紀錄，超額者安全轉為封存
  test('24. Free 會員匯入多場進行中考試：完整保留全部考試與任務，超過方案上限者安全轉為封存', () => {
    const exam1: Exam = { ...sampleExam, id: 'exam-1', name: '考試一', archived: false };
    const exam2: Exam = { ...sampleExam, id: 'exam-2', name: '考試二', archived: false };
    const task1: StudyTask = { ...sampleTask, id: 'task-1', examId: 'exam-1' };
    const task2: StudyTask = { ...sampleTask, id: 'task-2', examId: 'exam-2' };

    const freeUserState: AppData = {
      ...INITIAL_EMPTY_DATA,
      subscription: { plan: 'free', billingCycle: 'none', status: 'none' },
    };

    const restored = reducer(freeUserState, {
      type: 'restoreStudyData',
      payload: {
        exams: [exam1, exam2],
        tasks: [task1, task2],
        preferences: DEFAULT_PREFERENCES,
        selectedExamId: 'exam-1',
      },
    });

    // 驗證 100% 考試與任務全部保留
    expect(restored.exams.length).toBe(2);
    expect(restored.tasks.length).toBe(2);
    // 第一場為進行中
    expect(restored.exams[0].id).toBe('exam-1');
    expect(restored.exams[0].archived).toBe(false);
    // 第二場自動安全轉為已封存（不靜默突破上限，也不刪除資料）
    expect(restored.exams[1].id).toBe('exam-2');
    expect(restored.exams[1].archived).toBe(true);
    // selectedExamId 鎖定在進行中的考試一
    expect(restored.selectedExamId).toBe('exam-1');
  });
});
