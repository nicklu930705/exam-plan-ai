import React from 'react';
import renderer, { act } from 'react-test-renderer';

import { AiAdviceCard } from '../AiAdviceCard';
import type { StructuredAdvice, QuotaInfo } from '../../services/aiAdviceService';
import type { AiQuotaStatus } from '../../subscription/types';

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

describe('AiAdviceCard 會員標籤與額度顯示測試', () => {
  const sampleAdvice: StructuredAdvice = {
    summary: '備考策略重點',
    focusSubjects: ['科目一'],
    actionableTips: ['要點一', '要點二'],
    estimatedFeasibility: '可行性高',
  };

  const sampleProQuota: QuotaInfo = {
    usedToday: 1,
    dailyLimit: 15,
    remainingToday: 14,
    resetsAt: '2026-10-23T00:00:00+08:00',
    tier: 'pro',
  };

  const sampleFreeQuota: QuotaInfo = {
    usedToday: 0,
    dailyLimit: 3,
    remainingToday: 3,
    resetsAt: '2026-10-23T00:00:00+08:00',
    tier: 'free',
  };

  function renderCard(props: any): string {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<AiAdviceCard {...props} />);
    });
    return JSON.stringify(tree.toJSON());
  }

  it('1. Lifetime 會員方案應正確顯示「✦ 終身版會員」，不得誤標為免費版或 Pro', () => {
    const json = renderCard({
      advice: sampleAdvice,
      tier: 'lifetime',
      quota: sampleProQuota,
      isQuotaStale: false,
    });
    expect(json).toContain('✦ 終身版會員 · ');
    expect(json).toContain('今日已用 1/15 次（剩餘 14 次 · 每日 00:00 重設）');
    expect(json).not.toContain('免費版');
  });

  it('2. Pro 會員方案應正確顯示「✦ Pro 會員」', () => {
    const json = renderCard({
      advice: sampleAdvice,
      tier: 'pro',
      quota: sampleProQuota,
      isQuotaStale: false,
    });
    expect(json).toContain('✦ Pro 會員 · ');
    expect(json).toContain('今日已用 1/15 次（剩餘 14 次 · 每日 00:00 重設）');
    expect(json).not.toContain('免費版');
  });

  it('3. Free 會員方案應正確顯示「免費版」', () => {
    const json = renderCard({
      advice: sampleAdvice,
      tier: 'free',
      quota: sampleFreeQuota,
      isQuotaStale: false,
    });
    expect(json).toContain('免費版 · ');
    expect(json).toContain('今日已用 0/3 次（剩餘 3 次 · 每日 00:00 重設）');
    expect(json).not.toContain('✦ Pro 會員');
  });

  it('4. 若有效會員方案尚未確定（tier 為 undefined），應顯示中性文字「今日 AI 使用額度」，不得誤標免費版', () => {
    const json = renderCard({
      advice: sampleAdvice,
      quota: undefined,
      quotaStatus: {
        used: 2,
        limit: 15,
        remaining: 13,
        isExceeded: false,
        resetsAt: '2026-10-23T00:00:00+08:00',
      },
      isQuotaStale: false,
    });
    expect(json).toContain('今日 AI 使用額度 · ');
    expect(json).toContain('今日已用 2/15 次（剩餘 13 次 · 每日 00:00 重設）');
    expect(json).not.toContain('免費版');
  });

  it('5. 離線快取額度（isQuotaStale: true）應明確標示「上次同步」，不得標示為即時重設', () => {
    const json = renderCard({
      advice: sampleAdvice,
      tier: 'pro',
      quota: sampleProQuota,
      isQuotaStale: true,
    });
    expect(json).toContain('✦ Pro 會員 · ');
    expect(json).toContain('今日已用 1/15 次（剩餘 14 次 · 上次同步）');
    expect(json).not.toContain('每日 00:00 重設');
  });

  it('6. quotaStatus 單獨存在（無 quota 物件）時應能正常解析次數', () => {
    const statusOnly: AiQuotaStatus = {
      used: 1,
      limit: 3,
      remaining: 2,
      isExceeded: false,
      resetsAt: '2026-10-23T00:00:00+08:00',
    };
    const json = renderCard({
      advice: sampleAdvice,
      tier: 'free',
      quotaStatus: statusOnly,
      isQuotaStale: false,
    });
    expect(json).toContain('免費版 · ');
    expect(json).toContain('今日已用 1/3 次（剩餘 2 次 · 每日 00:00 重設）');
  });

  it('7. 進度已變更時（isOutdatedProgress: true）應正確浮現提醒框', () => {
    const json = renderCard({
      advice: sampleAdvice,
      tier: 'pro',
      quota: sampleProQuota,
      isOutdatedProgress: true,
    });
    expect(json).toContain('今日進度已有新更新 · 可點擊右上角重新整理以產生最新分析（將消耗 1 次配額）');
  });

  it('8. 歷史建議（isHistorical: true）應明確標示「✦ 歷史 AI 讀書建議」與「此為前次分析建議（已跨日）」', () => {
    const json = renderCard({
      advice: sampleAdvice,
      tier: 'pro',
      quota: sampleProQuota,
      isHistorical: true,
      generatedAt: '2026-10-22T08:30:00.000Z',
    });
    expect(json).toContain('✦ 歷史 AI 讀書建議');
    expect(json).toContain('此為前次分析建議（已跨日）· 可免費閱讀');
    expect(json).toContain('前次分析：');
  });

  it('9. 歷史建議且進度已更新時，應合併顯示歷史與進度提醒', () => {
    const json = renderCard({
      advice: sampleAdvice,
      tier: 'pro',
      quota: sampleProQuota,
      isHistorical: true,
      isOutdatedProgress: true,
      generatedAt: '2026-10-22T08:30:00.000Z',
    });
    expect(json).toContain('✦ 歷史 AI 讀書建議');
    expect(json).toContain('此為前次分析建議（已跨日且進度已有更新）· 可免費閱讀');
  });
});
