import type { SubjectDraft } from '../examForm';
import {
  hasErrors,
  parseChapters,
  validateExamInfo,
  validateStudyTime,
  validateSubject,
} from '../examForm';

describe('建立考試表單驗證 (Exam Form Validation)', () => {
  const today = '2026-10-12';

  describe('考試基本資訊驗證', () => {
    test('必填欄位未填寫：考試名稱為空應回傳錯誤', () => {
      const errors = validateExamInfo('   ', '2026-11-20', today);
      expect(errors.name).toBe('請輸入考試名稱');
      expect(hasErrors(errors)).toBe(true);
    });

    test('考試日期不合理：考試日期早於今天應回傳錯誤', () => {
      const errors = validateExamInfo('多益考試', '2026-10-01', today);
      expect(errors.examDate).toBe('考試日期不能早於今天');
      expect(hasErrors(errors)).toBe(true);
    });

    test('考試名稱與日期皆有效時無錯誤', () => {
      const errors = validateExamInfo('大學期中考', '2026-11-15', today);
      expect(errors.name).toBeUndefined();
      expect(errors.examDate).toBeUndefined();
      expect(hasErrors(errors)).toBe(false);
    });
  });

  describe('科目與章節驗證', () => {
    test('parseChapters 正確解析多行文字並過濾空行', () => {
      const input = `第一章 導論\n\n第二章 核心概念  \n   \n第三章 實務案例`;
      const chapters = parseChapters(input);
      expect(chapters).toEqual(['第一章 導論', '第二章 核心概念', '第三章 實務案例']);
    });

    test('科目名稱為空應回傳錯誤', () => {
      const draft: SubjectDraft = {
        id: 's1',
        name: ' ',
        familiarity: 2,
        chaptersText: '章節一',
      };
      const errors = validateSubject(draft, []);
      expect(errors.name).toBe('請輸入科目名稱');
    });

    test('未輸入章節或範圍時為合法選填，排程引擎將以科目名稱建立任務', () => {
      const draft: SubjectDraft = {
        id: 's1',
        name: '微積分',
        familiarity: 2,
        chaptersText: '   \n  \n',
      };
      const errors = validateSubject(draft, []);
      expect(errors.chapters).toBeUndefined();
      expect(hasErrors(errors)).toBe(false);
    });

    test('科目名稱重複時應回傳錯誤', () => {
      const existing: SubjectDraft[] = [
        { id: 's1', name: '英文聽力', familiarity: 2, chaptersText: 'Ch1' },
      ];
      const draft: SubjectDraft = {
        id: 's2',
        name: ' 英文聽力 ',
        familiarity: 1,
        chaptersText: 'Ch2',
      };
      const errors = validateSubject(draft, existing);
      expect(errors.name).toBe('已經有同名的科目');
    });
  });

  describe('讀書時間合理性驗證', () => {
    test('若七天全部設定為休息日應報錯', () => {
      const error = validateStudyTime(
        { dailyMinutes: 120, restDays: [0, 1, 2, 3, 4, 5, 6], intensity: 'normal' },
        today,
        '2026-11-12',
      );
      expect(error).toBe('每週至少要保留一天讀書');
    });

    test('每日時間少於 15 分鐘應報錯', () => {
      const error = validateStudyTime(
        { dailyMinutes: 10, restDays: [0], intensity: 'normal' },
        today,
        '2026-11-12',
      );
      expect(error).toBe('每日可讀書時間至少 15 分鐘');
    });

    test('考試前無可用讀書日應報錯', () => {
      // 考試在明天，但今天是週一且週一設為休息日
      const error = validateStudyTime(
        { dailyMinutes: 60, restDays: [1], intensity: 'normal' }, // 2026-10-12 is Monday (1)
        '2026-10-12',
        '2026-10-13',
      );
      expect(error).toBe('考試前沒有可以讀書的日子，請調整休息日或考試日期');
    });
  });
});
