const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const OpenAI = require('openai');

const studyAdviceModule = require('../dist/api/study-advice.js');
const healthModule = require('../dist/api/health.js');
const { inMemoryRedisMockInstance, postCallSettleSuccess } = require('../dist/lib/redis.js');

const handler = typeof studyAdviceModule === 'function'
  ? studyAdviceModule
  : studyAdviceModule.default;

const healthHandler = typeof healthModule === 'function'
  ? healthModule
  : healthModule.default;

function createServer() {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString('utf-8');
    if (rawBody && req.headers['content-type']?.includes('application/json')) {
      try {
        req.body = JSON.parse(rawBody);
      } catch {
        req.body = rawBody;
      }
    } else {
      req.body = rawBody || {};
    }

    res.status = function (code) {
      res.statusCode = code;
      return this;
    };
    res.json = function (data) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(data));
      return this;
    };

    try {
      if (req.url && req.url.startsWith('/api/health')) {
        await healthHandler(req, res);
      } else {
        await handler(req, res);
      }
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err?.message || 'Internal test server error' }));
      }
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(res)),
      });
    });
  });
}

const samplePayload = {
  examName: '多益英語測驗',
  examDate: '2026-11-15',
  dailyAvailableMinutes: 90,
  intensity: 'normal',
  subjects: [
    { name: '聽力測驗', familiarity: 2, totalChapters: 10, completedChapters: 4 },
    { name: '閱讀測驗', familiarity: 1, totalChapters: 12, completedChapters: 2 },
  ],
  recentCompletionRate: 85,
  behindTasksCount: 1,
};

const mockOpenAiResponse = JSON.stringify({
  summary: '目前的準備節奏良好，閱讀測驗稍弱，建議加強長篇閱讀並以每日黃金 45 分鐘專攻。',
  focusSubjects: ['閱讀測驗', '聽力測驗'],
  actionableTips: [
    '每日安排 45 分鐘高專注閱讀弱點加強。',
    '利用專注計時器保持節奏，補齊落後的 1 項任務。',
    '最後兩週維持每週兩回模擬試題手感。',
  ],
  estimatedFeasibility: '以每日 90 分鐘計算，目前時間充裕，維持現有進度即可順利掌握全數重點。',
});

function setupMockOpenAiSuccess() {
  const dummy = new OpenAI({ apiKey: 'mock' });
  const completionsProto = Object.getPrototypeOf(dummy.chat.completions);
  const originalCreate = completionsProto.create;

  let callCount = 0;
  completionsProto.create = async function () {
    callCount += 1;
    return {
      choices: [
        {
          message: {
            role: 'assistant',
            content: mockOpenAiResponse,
          },
        },
      ],
      usage: {
        prompt_tokens: 320,
        completion_tokens: 180,
        total_tokens: 500,
      },
    };
  };

  return {
    restore: () => {
      completionsProto.create = originalCreate;
    },
    getCallCount: () => callCount,
  };
}

test('1. GET 請求應回傳 405 Method Not Allowed', async () => {
  const ctx = await createServer();
  try {
    const res = await fetch(`${ctx.url}/api/study-advice`, { method: 'GET' });
    assert.equal(res.status, 405);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /POST/);
  } finally {
    await ctx.close();
  }
});

test('2. 輸入格式無效時應回傳 400 INVALID_INPUT', async () => {
  const ctx = await createServer();
  try {
    const res = await fetch(`${ctx.url}/api/study-advice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ examName: '' }),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.code, 'INVALID_INPUT');
  } finally {
    await ctx.close();
  }
});

test('3. 輸入總字數超過 4,000 字上限應回傳 400 錯誤 (AI_MAX_INPUT_CHARS)', async () => {
  const ctx = await createServer();
  try {
    const longSubject = '科'.repeat(4005);
    const res = await fetch(`${ctx.url}/api/study-advice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...samplePayload,
        subjects: [{ name: longSubject, familiarity: 1 }],
      }),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /超過 4000 字限制/);
  } finally {
    await ctx.close();
  }
});

test('4. Payload 超過 15KB 應回傳 413 錯誤', async () => {
  const ctx = await createServer();
  try {
    const largeName = 'A'.repeat(16 * 1024);
    const payloadStr = JSON.stringify({ ...samplePayload, examName: largeName });
    const res = await fetch(`${ctx.url}/api/study-advice`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(payloadStr)),
      },
      body: payloadStr,
    });
    assert.equal(res.status, 413);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /15 KB/);
  } finally {
    await ctx.close();
  }
});

test('5. Redis 故障時應實作 Fail-Closed (安全關閉)，回傳 503 STORAGE_UNAVAILABLE', async () => {
  delete process.env.MOCK_REDIS;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;

  const ctx = await createServer();
  try {
    const res = await fetch(`${ctx.url}/api/study-advice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(samplePayload),
    });
    assert.equal(res.status, 503);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.code, 'STORAGE_UNAVAILABLE');
    assert.match(data.error, /無法連接用量資料庫/);
  } finally {
    await ctx.close();
  }
});

test('6. 未設定 OPENAI_API_KEY 時應回傳 500 API_KEY_MISSING 且不偽造假內容', async () => {
  process.env.MOCK_REDIS = 'true';
  inMemoryRedisMockInstance.clear();
  delete process.env.OPENAI_API_KEY;

  const ctx = await createServer();
  try {
    const res = await fetch(`${ctx.url}/api/study-advice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(samplePayload),
    });
    assert.equal(res.status, 500);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.code, 'API_KEY_MISSING');
    assert.equal(data.advice, undefined);
  } finally {
    await ctx.close();
  }
});

test('7. 成功請求：驗證繁中格式、source=openai_ai、配額資訊與計費資訊', async () => {
  process.env.MOCK_REDIS = 'true';
  process.env.OPENAI_API_KEY = 'sk-mock-valid-key';
  inMemoryRedisMockInstance.clear();

  const mock = setupMockOpenAiSuccess();
  const ctx = await createServer();
  try {
    const res = await fetch(`${ctx.url}/api/study-advice`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Device-Id': 'dev_test_user_001',
      },
      body: JSON.stringify(samplePayload),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.source, 'openai_ai');
    assert.ok(data.advice);
    assert.equal(data.advice.focusSubjects.length, 2);

    // 驗證配額結構
    assert.ok(data.quota);
    assert.equal(data.quota.usedToday, 1);
    assert.equal(data.quota.dailyLimit, 3);
    assert.equal(data.quota.remainingToday, 2);
    assert.equal(data.quota.tier, 'free');
    assert.ok(data.quota.resetsAt.includes('T00:00:00+08:00'));

    // 驗證計費結構
    assert.ok(data.costInfo);
    assert.ok(data.costInfo.actualCostUSD > 0);
  } finally {
    mock.restore();
    await ctx.close();
  }
});

test('8. 免費版每日 3 次限制：第 1~3 次成功，第 4 次被 429 DAILY_QUOTA_EXCEEDED 拒絕', async () => {
  process.env.MOCK_REDIS = 'true';
  process.env.OPENAI_API_KEY = 'sk-mock-valid-key';
  inMemoryRedisMockInstance.clear();

  const mock = setupMockOpenAiSuccess();
  const ctx = await createServer();
  const userId = 'dev_free_user_limit_test';

  try {
    for (let i = 1; i <= 3; i++) {
      const res = await fetch(`${ctx.url}/api/study-advice`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Device-Id': userId,
        },
        body: JSON.stringify(samplePayload),
      });
      assert.equal(res.status, 200, `第 ${i} 次請求應該成功`);
      const data = await res.json();
      assert.equal(data.quota.usedToday, i);
      assert.equal(data.quota.remainingToday, 3 - i);
    }

    // 第 4 次應該被拒絕
    const res4 = await fetch(`${ctx.url}/api/study-advice`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Device-Id': userId,
      },
      body: JSON.stringify(samplePayload),
    });
    assert.equal(res4.status, 429);
    const data4 = await res4.json();
    assert.equal(data4.success, false);
    assert.equal(data4.code, 'DAILY_QUOTA_EXCEEDED');
    assert.match(data4.error, /今日的 AI 建議額度已用完/);
  } finally {
    mock.restore();
    await ctx.close();
  }
});

test('9. Pro 權限偽造防禦：未經 Apple 伺服端驗證宣告 Pro 者，嚴格鎖定為 Free 額度 (第 4 次被擋)', async () => {
  process.env.MOCK_REDIS = 'true';
  process.env.OPENAI_API_KEY = 'sk-mock-valid-key';
  inMemoryRedisMockInstance.clear();

  const mock = setupMockOpenAiSuccess();
  const ctx = await createServer();
  const userId = 'dev_fake_pro_attacker';

  try {
    for (let i = 1; i <= 3; i++) {
      const res = await fetch(`${ctx.url}/api/study-advice`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Device-Id': userId,
          'X-User-Tier': 'pro', // 偽造 Pro 標頭
        },
        body: JSON.stringify({ ...samplePayload, tier: 'pro', plan: 'pro' }), // 偽造 Pro body
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.quota.tier, 'free', '未驗證憑證前絕不可提升為 Pro 額度');
    }

    // 第 4 次嘗試呼叫，依然受 Free 限制擋下
    const res4 = await fetch(`${ctx.url}/api/study-advice`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Device-Id': userId,
        'X-User-Tier': 'pro',
      },
      body: JSON.stringify({ ...samplePayload, tier: 'pro' }),
    });
    assert.equal(res4.status, 429);
    const data4 = await res4.json();
    assert.equal(data4.code, 'DAILY_QUOTA_EXCEEDED');
  } finally {
    mock.restore();
    await ctx.close();
  }
});

test('10. 進行中請求鎖 (Concurrency Lock)：同一使用者並行請求時，第二筆被 429 CONCURRENT_REQUEST 拒絕', async () => {
  process.env.MOCK_REDIS = 'true';
  process.env.OPENAI_API_KEY = 'sk-mock-valid-key';
  inMemoryRedisMockInstance.clear();

  const dummy = new OpenAI({ apiKey: 'mock' });
  const completionsProto = Object.getPrototypeOf(dummy.chat.completions);
  const originalCreate = completionsProto.create;

  // 刻意延遲 200ms 模擬請求進行中
  completionsProto.create = async function () {
    await new Promise((r) => setTimeout(r, 200));
    return {
      choices: [{ message: { role: 'assistant', content: mockOpenAiResponse } }],
      usage: { prompt_tokens: 300, completion_tokens: 200, total_tokens: 500 },
    };
  };

  const ctx = await createServer();
  const userId = 'dev_concurrent_user';

  try {
    const req1 = fetch(`${ctx.url}/api/study-advice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Device-Id': userId },
      body: JSON.stringify(samplePayload),
    });

    // 稍微延遲 20ms 發出第二筆請求
    await new Promise((r) => setTimeout(r, 20));
    const req2 = fetch(`${ctx.url}/api/study-advice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Device-Id': userId },
      body: JSON.stringify(samplePayload),
    });

    const [res1, res2] = await Promise.all([req1, req2]);
    const statuses = [res1.status, res2.status];
    assert.ok(statuses.includes(200), '第一筆請求應該成功 (200)');
    assert.ok(statuses.includes(429), '第二筆並行請求應該被阻擋 (429)');

    const blockedRes = res1.status === 429 ? res1 : res2;
    const blockedData = await blockedRes.json();
    assert.equal(blockedData.code, 'CONCURRENT_REQUEST');
  } finally {
    completionsProto.create = originalCreate;
    await ctx.close();
  }
});

test('11. 每分鐘速率限制 (Rate Limit)：同一使用者 1 分鐘內第 4 次請求被 429 RATE_LIMIT_EXCEEDED 拒絕', async () => {
  process.env.MOCK_REDIS = 'true';
  process.env.OPENAI_API_KEY = 'sk-mock-valid-key';
  process.env.FREE_DAILY_AI_LIMIT = '20'; // 放寬每日上限以測試每分鐘頻率限制
  inMemoryRedisMockInstance.clear();

  const mock = setupMockOpenAiSuccess();
  const ctx = await createServer();
  const userId = 'dev_rate_limit_user';

  try {
    for (let i = 1; i <= 3; i++) {
      const res = await fetch(`${ctx.url}/api/study-advice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Client-Device-Id': userId },
        body: JSON.stringify(samplePayload),
      });
      assert.equal(res.status, 200);
    }

    const res4 = await fetch(`${ctx.url}/api/study-advice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Device-Id': userId },
      body: JSON.stringify(samplePayload),
    });
    assert.equal(res4.status, 429);
    const data4 = await res4.json();
    assert.equal(data4.code, 'RATE_LIMIT_EXCEEDED');
    assert.match(data4.error, /每分鐘上限 3 次/);
  } finally {
    delete process.env.FREE_DAILY_AI_LIMIT;
    mock.restore();
    await ctx.close();
  }
});

test('12. 冪等鍵 (Idempotency Key)：重送相同 Key 直接回傳快取，不重複扣額或呼叫 OpenAI', async () => {
  process.env.MOCK_REDIS = 'true';
  process.env.OPENAI_API_KEY = 'sk-mock-valid-key';
  inMemoryRedisMockInstance.clear();

  const mock = setupMockOpenAiSuccess();
  const ctx = await createServer();
  const idempotencyKey = 'idem_unique_test_key_12345';

  try {
    const res1 = await fetch(`${ctx.url}/api/study-advice`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Device-Id': 'dev_user_idem',
        'X-Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(samplePayload),
    });
    assert.equal(res1.status, 200);
    const data1 = await res1.json();
    assert.equal(mock.getCallCount(), 1);

    // 重送相同 Idempotency-Key
    const res2 = await fetch(`${ctx.url}/api/study-advice`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Device-Id': 'dev_user_idem',
        'X-Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(samplePayload),
    });
    assert.equal(res2.status, 200);
    const data2 = await res2.json();

    // 驗證未再次呼叫 OpenAI，且回應內容一致
    assert.equal(mock.getCallCount(), 1, '命中冪等快取時不應重複呼叫 OpenAI');
    assert.equal(data2.advice.summary, data1.advice.summary);
  } finally {
    mock.restore();
    await ctx.close();
  }
});

test('13. 伺服端單日預算上限 (DAILY_BUDGET)：超過日預算 ($0.50) 拒絕後續請求', async () => {
  process.env.MOCK_REDIS = 'true';
  process.env.OPENAI_API_KEY = 'sk-mock-valid-key';
  process.env.AI_DAILY_BUDGET_USD = '0.0001'; // 設定極低日預算以觸發上限
  inMemoryRedisMockInstance.clear();

  const mock = setupMockOpenAiSuccess();
  const ctx = await createServer();

  try {
    const res = await fetch(`${ctx.url}/api/study-advice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Device-Id': 'dev_user_budget_test' },
      body: JSON.stringify(samplePayload),
    });
    assert.equal(res.status, 429);
    const data = await res.json();
    assert.equal(data.code, 'DAILY_BUDGET_EXCEEDED');
    assert.match(data.error, /本日系統 AI 服務總運算額度已達安全上限/);
  } finally {
    delete process.env.AI_DAILY_BUDGET_USD;
    mock.restore();
    await ctx.close();
  }
});

test('14. 請求失敗或逾時退款：OpenAI 呼叫失敗時，安全退回預扣額度與每日計數', async () => {
  process.env.MOCK_REDIS = 'true';
  process.env.OPENAI_API_KEY = 'sk-mock-valid-key';
  inMemoryRedisMockInstance.clear();

  const dummy = new OpenAI({ apiKey: 'mock' });
  const completionsProto = Object.getPrototypeOf(dummy.chat.completions);
  const originalCreate = completionsProto.create;

  let shouldFail = true;
  completionsProto.create = async function () {
    if (shouldFail) {
      const err = new Error('OpenAI Simulated Internal Failure');
      err.status = 500;
      throw err;
    }
    return {
      choices: [{ message: { role: 'assistant', content: mockOpenAiResponse } }],
      usage: { prompt_tokens: 300, completion_tokens: 200, total_tokens: 500 },
    };
  };

  const ctx = await createServer();
  const userId = 'dev_refund_test_user';

  try {
    // 第一次請求 (失敗)
    const res1 = await fetch(`${ctx.url}/api/study-advice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Device-Id': userId },
      body: JSON.stringify(samplePayload),
    });
    assert.equal(res1.status, 500);

    // 第二次請求 (修復後再試)
    shouldFail = false;
    const res2 = await fetch(`${ctx.url}/api/study-advice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Device-Id': userId },
      body: JSON.stringify(samplePayload),
    });
    assert.equal(res2.status, 200);
    const data2 = await res2.json();

    // 驗證第一次失敗未佔用次數，第二次請求後 usedToday 仍為 1
    assert.equal(data2.quota.usedToday, 1);
    assert.equal(data2.quota.remainingToday, 2);
  } finally {
    completionsProto.create = originalCreate;
    await ctx.close();
  }
});

test('15. 伺服端每月預算上限 (MONTHLY_BUDGET)：超過月預算 ($5.00) 拒絕後續請求', async () => {
  process.env.MOCK_REDIS = 'true';
  process.env.OPENAI_API_KEY = 'sk-mock-valid-key';
  process.env.AI_MONTHLY_BUDGET_USD = '0.0001'; // 設定極低月預算以觸發上限
  inMemoryRedisMockInstance.clear();

  const mock = setupMockOpenAiSuccess();
  const ctx = await createServer();

  try {
    const res = await fetch(`${ctx.url}/api/study-advice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Device-Id': 'dev_user_monthly_budget_test' },
      body: JSON.stringify(samplePayload),
    });
    assert.equal(res.status, 429);
    const data = await res.json();
    assert.equal(data.code, 'MONTHLY_BUDGET_EXCEEDED');
    assert.match(data.error, /本月系統 AI 服務總運算額度已達安全預算上限/);
  } finally {
    delete process.env.AI_MONTHLY_BUDGET_USD;
    mock.restore();
    await ctx.close();
  }
});

test('16. 安全鎖釋放 (Safe Lock Release)：舊請求完成結算時，若鎖已被新請求取得，絕不誤刪新請求的鎖', async () => {
  process.env.MOCK_REDIS = 'true';
  inMemoryRedisMockInstance.clear();

  const userId = 'dev_lock_safety_user';
  const lockKey = `exam_ai:lock:${userId}`;

  // 模擬新請求 (req_new) 已經取得鎖
  inMemoryRedisMockInstance.store.set(lockKey, { value: 'req_new', expireAt: Date.now() + 30000 });

  // 模擬舊請求 (req_old) 此時才執行完成結算
  await postCallSettleSuccess({
    userId,
    requestId: 'req_old',
    reservedCostMicroUSD: 1000,
    actualCostMicroUSD: 500,
  });

  // 驗證新請求的鎖仍然完好存在，未被 req_old 刪除
  const currentLock = inMemoryRedisMockInstance.store.get(lockKey);
  assert.ok(currentLock, '新請求的鎖必須仍然存在');
  assert.equal(currentLock.value, 'req_new', '鎖的擁有者必須仍為 req_new');
});

test('17. 健康檢查端點 (GET /api/health)：正常回傳系統狀態且不洩漏任何機密資訊', async () => {
  process.env.MOCK_REDIS = 'true';
  process.env.OPENAI_API_KEY = 'sk-mock-valid-key';
  process.env.OPENAI_MODEL = 'gpt-5.6-luna';

  const ctx = await createServer();
  try {
    const res = await fetch(`${ctx.url}/api/health`, { method: 'GET' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'healthy');
    assert.equal(data.redis.status, 'connected');
    assert.equal(data.ai.model, 'gpt-5.6-luna');
    assert.equal(data.ai.openaiConfigured, true);
    assert.equal(data.quotaRules.freeDailyLimit, 3);
    assert.equal(data.quotaRules.proDailyLimit, 15);

    // 驗證絕不洩漏 API Key 或 Token
    const rawText = JSON.stringify(data);
    assert.ok(!rawText.includes('sk-mock-valid-key'));
    assert.ok(!rawText.includes('token'));
  } finally {
    await ctx.close();
  }
});

test('18. 多使用者並發預算保護：剩餘預算僅足夠 1 筆時，並發請求只有 1 筆通過，另一筆被 DAILY_BUDGET_EXCEEDED 拒絕', async () => {
  process.env.MOCK_REDIS = 'true';
  process.env.OPENAI_API_KEY = 'sk-mock-valid-key';
  // 設定日預算為極小值，僅允許約 1 筆預扣成本通過
  process.env.AI_DAILY_BUDGET_USD = '0.0015';
  inMemoryRedisMockInstance.clear();

  const dummy = new OpenAI({ apiKey: 'mock' });
  const completionsProto = Object.getPrototypeOf(dummy.chat.completions);
  const originalCreate = completionsProto.create;

  // 延遲 100ms 模擬真實 API 呼叫期間
  completionsProto.create = async function () {
    await new Promise((r) => setTimeout(r, 100));
    return {
      choices: [{ message: { role: 'assistant', content: mockOpenAiResponse } }],
      usage: { prompt_tokens: 300, completion_tokens: 200, total_tokens: 500 },
    };
  };

  const ctx = await createServer();

  try {
    const reqA = fetch(`${ctx.url}/api/study-advice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Device-Id': 'dev_user_budget_race_A' },
      body: JSON.stringify(samplePayload),
    });

    const reqB = fetch(`${ctx.url}/api/study-advice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Device-Id': 'dev_user_budget_race_B' },
      body: JSON.stringify(samplePayload),
    });

    const [resA, resB] = await Promise.all([reqA, reqB]);
    const statuses = [resA.status, resB.status];

    assert.ok(statuses.includes(200), '應有 1 筆並發請求在預算內成功');
    assert.ok(statuses.includes(429), '超額的另 1 筆並發請求必須被 429 阻擋');

    const blocked = resA.status === 429 ? resA : resB;
    const blockedData = await blocked.json();
    assert.equal(blockedData.code, 'DAILY_BUDGET_EXCEEDED');
  } finally {
    delete process.env.AI_DAILY_BUDGET_USD;
    completionsProto.create = originalCreate;
    await ctx.close();
  }
});

test('19. 跨月份預算隔離：上月累積支出達上限，不影響當月預算計算與正常呼叫', async () => {
  process.env.MOCK_REDIS = 'true';
  process.env.OPENAI_API_KEY = 'sk-mock-valid-key';
  inMemoryRedisMockInstance.clear();

  // 模擬上個月 (2026-09) 預算已經爆滿達 10,000,000 micro-USD ($10 USD)
  const pastMonthKey = 'exam_ai:budget:month:2026-09';
  inMemoryRedisMockInstance.store.set(pastMonthKey, { value: '10000000' });

  const mock = setupMockOpenAiSuccess();
  const ctx = await createServer();

  try {
    const res = await fetch(`${ctx.url}/api/study-advice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Device-Id': 'dev_user_cross_month' },
      body: JSON.stringify(samplePayload),
    });

    assert.equal(res.status, 200, '當月在獨立 key 下運作，不受上月預算已耗盡影響');
    const data = await res.json();
    assert.equal(data.success, true);
  } finally {
    mock.restore();
    await ctx.close();
  }
});

test('20. 缺少 usage 資料之保守安全計費：OpenAI 回應未附帶 usage 時，系統仍能保守扣除預算且標記 isExactPricing=false', async () => {
  process.env.MOCK_REDIS = 'true';
  process.env.OPENAI_API_KEY = 'sk-mock-valid-key';
  inMemoryRedisMockInstance.clear();

  const dummy = new OpenAI({ apiKey: 'mock' });
  const completionsProto = Object.getPrototypeOf(dummy.chat.completions);
  const originalCreate = completionsProto.create;

  // 模擬 OpenAI 未回傳 usage 欄位的情境
  completionsProto.create = async function () {
    return {
      choices: [{ message: { role: 'assistant', content: mockOpenAiResponse } }],
      // 故意不回傳 usage
    };
  };

  const ctx = await createServer();

  try {
    const res = await fetch(`${ctx.url}/api/study-advice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Device-Id': 'dev_user_missing_usage' },
      body: JSON.stringify(samplePayload),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.costInfo, '必須回傳計費資訊');
    assert.ok(data.costInfo.actualCostUSD > 0, '即便無 usage，仍須採用保守估算金額，不可計為 0 元');
    assert.equal(data.costInfo.isExactPricing, false, '因無 usage 數據，必須明確標記為非精確定價');
  } finally {
    completionsProto.create = originalCreate;
    await ctx.close();
  }
});


