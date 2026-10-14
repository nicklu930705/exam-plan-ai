const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const OpenAI = require('openai');

const studyAdviceModule = require('../dist/api/study-advice.js');
const handler = typeof studyAdviceModule === 'function'
  ? studyAdviceModule
  : studyAdviceModule.default;

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
      await handler(req, res);
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

test('2. 無效輸入資料應回傳 400 INVALID_INPUT', async () => {
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

test('3. 超過 15KB 的 Payload 應回傳 413 錯誤', async () => {
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

test('4. 未設定 OPENAI_API_KEY 時應回傳 500 API_KEY_MISSING 且不偽造假內容', async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.AI_PROVIDER;

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
    assert.match(data.error, /OPENAI_API_KEY/);
    assert.equal(data.advice, undefined); // 嚴禁在 API 失敗時偽造 AI 建議
  } finally {
    if (originalKey) process.env.OPENAI_API_KEY = originalKey;
    await ctx.close();
  }
});

test('5. 模擬 OpenAI 回傳成功時：驗證實際 POST 回應格式為繁體中文、source=openai_ai 與預設 gpt-5.6-luna', async () => {
  process.env.OPENAI_API_KEY = 'sk-mock-valid-key-for-testing';
  delete process.env.OPENAI_MODEL;
  delete process.env.AI_PROVIDER;

  const mockAdviceContent = JSON.stringify({
    summary: '目前的準備節奏良好，閱讀測驗稍弱，建議加強長篇閱讀並以每日黃金 45 分鐘專攻。',
    focusSubjects: ['閱讀測驗', '聽力測驗'],
    actionableTips: [
      '每日安排 45 分鐘高專注閱讀弱點加強。',
      '利用專注計時器保持節奏，補齊落後的 1 項任務。',
      '最後兩週維持每週兩回模擬試題手感。',
    ],
    estimatedFeasibility: '以每日 90 分鐘計算，目前時間充裕，維持現有進度即可順利掌握全數重點。',
  });

  const dummy = new OpenAI({ apiKey: 'mock' });
  const completionsProto = Object.getPrototypeOf(dummy.chat.completions);
  const originalCreate = completionsProto.create;

  let capturedArgs = null;
  completionsProto.create = async function (args) {
    capturedArgs = args;
    return {
      choices: [
        {
          message: {
            role: 'assistant',
            content: mockAdviceContent,
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

  const ctx = await createServer();
  try {
    const res = await fetch(`${ctx.url}/api/study-advice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(samplePayload),
    });

    assert.equal(res.status, 200);
    const data = await res.json();

    // 驗證模型預設為 gpt-5.6-luna
    assert.equal(capturedArgs.model, 'gpt-5.6-luna');
    assert.equal(capturedArgs.response_format?.type, 'json_object');
    assert.equal(capturedArgs.max_tokens, 900);

    // 驗證最外層回應結構
    assert.equal(data.success, true);
    assert.equal(data.source, 'openai_ai');
    assert.ok(typeof data.disclaimer === 'string' && data.disclaimer.length > 0);

    // 驗證 advice 內部欄位與繁體中文內容
    assert.ok(data.advice, '必須包含 advice 物件');
    assert.equal(data.advice.summary, '目前的準備節奏良好，閱讀測驗稍弱，建議加強長篇閱讀並以每日黃金 45 分鐘專攻。');
    assert.deepEqual(data.advice.focusSubjects, ['閱讀測驗', '聽力測驗']);
    assert.equal(data.advice.actionableTips.length, 3);
    assert.equal(data.advice.actionableTips[0], '每日安排 45 分鐘高專注閱讀弱點加強。');
    assert.match(data.advice.estimatedFeasibility, /90 分鐘/);

    // 驗證嚴格無 API 金鑰洩漏
    const jsonString = JSON.stringify(data);
    assert.equal(jsonString.includes('sk-mock-valid-key-for-testing'), false);
  } finally {
    completionsProto.create = originalCreate;
    delete process.env.OPENAI_API_KEY;
    await ctx.close();
  }
});

test('6. 驗證可透過 OPENAI_MODEL 環境變數自訂模型', async () => {
  process.env.OPENAI_API_KEY = 'sk-mock-valid-key';
  process.env.OPENAI_MODEL = 'gpt-5-mini';
  delete process.env.AI_PROVIDER;

  const dummy = new OpenAI({ apiKey: 'mock' });
  const completionsProto = Object.getPrototypeOf(dummy.chat.completions);
  const originalCreate = completionsProto.create;

  let capturedModel = '';
  completionsProto.create = async function (args) {
    capturedModel = args.model;
    return {
      choices: [
        {
          message: {
            role: 'assistant',
            content: JSON.stringify({
              summary: '自訂模型測試建議',
              focusSubjects: ['測試科目'],
              actionableTips: ['行動指引 1'],
              estimatedFeasibility: '進度合理',
            }),
          },
        },
      ],
    };
  };

  const ctx = await createServer();
  try {
    const res = await fetch(`${ctx.url}/api/study-advice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(samplePayload),
    });

    assert.equal(res.status, 200);
    assert.equal(capturedModel, 'gpt-5-mini');
  } finally {
    completionsProto.create = originalCreate;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL;
    await ctx.close();
  }
});

test('7. 模擬 OpenAI 401 錯誤時應對應回傳 401 OPENAI_AUTH_ERROR', async () => {
  process.env.OPENAI_API_KEY = 'sk-invalid-key';
  delete process.env.AI_PROVIDER;

  const dummy = new OpenAI({ apiKey: 'mock' });
  const completionsProto = Object.getPrototypeOf(dummy.chat.completions);
  const originalCreate = completionsProto.create;

  completionsProto.create = async function () {
    const err = new Error('Incorrect API key provided');
    err.status = 401;
    err.code = 'invalid_api_key';
    throw err;
  };

  const ctx = await createServer();
  try {
    const res = await fetch(`${ctx.url}/api/study-advice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(samplePayload),
    });

    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.code, 'OPENAI_AUTH_ERROR');
    assert.match(data.error, /OpenAI API Key 無效/);
  } finally {
    completionsProto.create = originalCreate;
    delete process.env.OPENAI_API_KEY;
    await ctx.close();
  }
});

test('8. 模擬 OpenAI 429 額度不足時應對應回傳 429 QUOTA_EXCEEDED', async () => {
  process.env.OPENAI_API_KEY = 'sk-mock-key';
  delete process.env.AI_PROVIDER;

  const dummy = new OpenAI({ apiKey: 'mock' });
  const completionsProto = Object.getPrototypeOf(dummy.chat.completions);
  const originalCreate = completionsProto.create;

  completionsProto.create = async function () {
    const err = new Error('You exceeded your current quota');
    err.status = 429;
    err.code = 'insufficient_quota';
    throw err;
  };

  const ctx = await createServer();
  try {
    const res = await fetch(`${ctx.url}/api/study-advice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(samplePayload),
    });

    assert.equal(res.status, 429);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.code, 'QUOTA_EXCEEDED');
    assert.match(data.error, /OpenAI 帳戶額度不足/);
  } finally {
    completionsProto.create = originalCreate;
    delete process.env.OPENAI_API_KEY;
    await ctx.close();
  }
});

test('9. 若指定 AI_PROVIDER=gemini 備援方案且未設 GEMINI_API_KEY 時回傳 GEMINI 金鑰遺失錯誤', async () => {
  const origProvider = process.env.AI_PROVIDER;
  const origGeminiKey = process.env.GEMINI_API_KEY;
  process.env.AI_PROVIDER = 'gemini';
  delete process.env.GEMINI_API_KEY;

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
    assert.match(data.error, /GEMINI_API_KEY/);
  } finally {
    if (origProvider !== undefined) process.env.AI_PROVIDER = origProvider;
    else delete process.env.AI_PROVIDER;
    if (origGeminiKey !== undefined) process.env.GEMINI_API_KEY = origGeminiKey;
    await ctx.close();
  }
});
