const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// 設定測試環境變數
process.env.MOCK_REDIS = 'true';
process.env.OPENAI_API_KEY = 'test_mock_key';
process.env.APP_SERVER_SECRET = 'test_signing_secret_for_tests';
process.env.APPLE_IAP_ENVIRONMENT = 'sandbox';
process.env.APPLE_ALLOW_SANDBOX = 'true';
process.env.APPLE_WEBHOOK_DRY_RUN = 'true';

const VALID_TEST_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; // 64 hex chars = 256 bits
process.env.SANDBOX_TEST_SECRET = VALID_TEST_SECRET;

const diagModule = require('../dist/api/sandbox-test-notification.js');
const webhookModule = require('../dist/api/apple-webhook.js');
const {
  setCustomAppleServerApiClient,
} = require('../dist/lib/appleServerApi.js');
const {
  setCustomNotificationVerifier,
} = require('../dist/lib/appleWebhookHandler.js');
const {
  inMemoryRedisMockInstance,
} = require('../dist/lib/redis.js');
const {
  EXPECTED_BUNDLE_ID,
} = require('../dist/lib/appleIap.js');

const diagHandler = typeof diagModule === 'function' ? diagModule : diagModule.default;
const webhookHandler = typeof webhookModule === 'function' ? webhookModule : webhookModule.default;

function createTestServer() {
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
      if (req.url && req.url.startsWith('/api/sandbox-test-notification')) {
        await diagHandler(req, res);
      } else if (req.url && req.url.startsWith('/api/apple-webhook')) {
        await webhookHandler(req, res);
      } else {
        res.status(404).json({ error: 'Not Found' });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return server;
}

function makeRequest(server, options, body) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const reqOptions = {
      hostname: '127.0.0.1',
      port,
      path: options.path || '/api/sandbox-test-notification',
      method: options.method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    };

    const req = http.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: parsed,
        });
      });
    });

    req.on('error', reject);
    if (body !== undefined) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

test('Sandbox TEST Notification 診斷端點與 TEST Webhook 測試套件', async (t) => {
  const server = createTestServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    setCustomAppleServerApiClient(null);
    setCustomNotificationVerifier(null);
  });

  t.beforeEach(() => {
    inMemoryRedisMockInstance.clear();
    process.env.APPLE_IAP_ENVIRONMENT = 'sandbox';
    process.env.APPLE_ALLOW_SANDBOX = 'true';
    process.env.APPLE_WEBHOOK_DRY_RUN = 'true';
    process.env.SANDBOX_TEST_SECRET = VALID_TEST_SECRET;
  });

  await t.test('1. OPTIONS 預檢請求：回傳 200 與允許標頭包含 X-Sandbox-Secret', async () => {
    const res = await makeRequest(server, { method: 'OPTIONS' });
    assert.equal(res.status, 200);
    assert.ok(res.headers['access-control-allow-headers'].includes('X-Sandbox-Secret'));
  });

  await t.test('2. 正式環境拒絕防護：當 APPLE_IAP_ENVIRONMENT=production 時回傳 403', async () => {
    process.env.APPLE_IAP_ENVIRONMENT = 'production';
    process.env.APPLE_ALLOW_SANDBOX = 'false';

    const res = await makeRequest(
      server,
      {
        headers: { 'X-Sandbox-Secret': VALID_TEST_SECRET },
      },
      { action: 'request' },
    );

    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'FORBIDDEN_ENVIRONMENT');
  });

  await t.test('3. 管理密鑰未配置防護：SANDBOX_TEST_SECRET 缺失時回傳 503', async () => {
    delete process.env.SANDBOX_TEST_SECRET;

    const res = await makeRequest(
      server,
      {
        headers: { 'X-Sandbox-Secret': VALID_TEST_SECRET },
      },
      { action: 'request' },
    );

    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'DIAGNOSTIC_DISABLED');
  });

  await t.test('4. 管理密鑰格式不符防護：非 64 位元十六進位字元時回傳 503', async () => {
    // 雖然有 64 字元但包含非十六進位字元 'z'
    process.env.SANDBOX_TEST_SECRET = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';

    const res = await makeRequest(
      server,
      {
        headers: { 'X-Sandbox-Secret': VALID_TEST_SECRET },
      },
      { action: 'request' },
    );

    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'DIAGNOSTIC_DISABLED');
  });

  await t.test('5. 乾跑防護檢查：APPLE_WEBHOOK_DRY_RUN=false 時拒絕執行並回傳 403', async () => {
    process.env.APPLE_WEBHOOK_DRY_RUN = 'false';

    const res = await makeRequest(
      server,
      {
        headers: { 'X-Sandbox-Secret': VALID_TEST_SECRET },
      },
      { action: 'request' },
    );

    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'DRY_RUN_REQUIRED');
  });

  await t.test('6. 缺失憑證拒絕：未帶 X-Sandbox-Secret 標頭回傳 401', async () => {
    const res = await makeRequest(server, {}, { action: 'request' });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'UNAUTHORIZED');
  });

  await t.test('7. 錯誤憑證拒絕：64 位元合法格式但內容不符回傳 401', async () => {
    const wrongValidFormatSecret = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const res = await makeRequest(
      server,
      {
        headers: { 'X-Sandbox-Secret': wrongValidFormatSecret },
      },
      { action: 'request' },
    );
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'UNAUTHORIZED');
  });

  await t.test('8. 時序安全比對：任意格式或長度之攻擊密鑰均安全拒絕且不拋出例外', async () => {
    const res = await makeRequest(
      server,
      {
        headers: { 'X-Sandbox-Secret': 'short_and_invalid_length' },
      },
      { action: 'request' },
    );
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'UNAUTHORIZED');
  });

  await t.test('9. Apple Client 未配置：回傳 503 且不外洩私鑰', async () => {
    setCustomAppleServerApiClient({
      isConfigured: () => false,
      getStatus: () => ({ isConfigured: false, bundleId: EXPECTED_BUNDLE_ID, environment: 'sandbox', reason: '金鑰未配置' }),
    });

    const res = await makeRequest(
      server,
      {
        headers: { 'X-Sandbox-Secret': VALID_TEST_SECRET },
      },
      { action: 'request' },
    );

    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'APPLE_API_NOT_CONFIGURED');
  });

  await t.test('10. 正常 action="request"：成功向 Apple 申請測試通知並取得 testNotificationToken', async () => {
    const mockToken = 'mock_apple_test_token_8899aabb';
    setCustomAppleServerApiClient({
      isConfigured: () => true,
      getStatus: () => ({ isConfigured: true, bundleId: EXPECTED_BUNDLE_ID, environment: 'sandbox' }),
      requestTestNotification: async () => ({
        testNotificationToken: mockToken,
      }),
    });

    const res = await makeRequest(
      server,
      {
        headers: { 'X-Sandbox-Secret': VALID_TEST_SECRET },
      },
      { action: 'request' },
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.action, 'request');
    assert.equal(res.body.testNotificationToken, mockToken);
    assert.equal(res.body.environment, 'sandbox');
  });

  await t.test('11. action="status" 缺少 token：回傳 400', async () => {
    setCustomAppleServerApiClient({
      isConfigured: () => true,
      getStatus: () => ({ isConfigured: true, bundleId: EXPECTED_BUNDLE_ID, environment: 'sandbox' }),
    });

    const res = await makeRequest(
      server,
      {
        headers: { 'X-Sandbox-Secret': VALID_TEST_SECRET },
      },
      { action: 'status' },
    );

    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'MISSING_TEST_TOKEN');
  });

  await t.test('12. 正常 action="status" 且 Apple 送達成功：解析 sendAttemptResult="SUCCESS"', async () => {
    const mockToken = 'mock_token_success_123';
    setCustomAppleServerApiClient({
      isConfigured: () => true,
      getStatus: () => ({ isConfigured: true, bundleId: EXPECTED_BUNDLE_ID, environment: 'sandbox' }),
      getTestNotificationStatus: async (token) => {
        assert.equal(token, mockToken);
        return {
          signedPayload: 'mock_signed_test_payload',
          sendAttempts: [
            {
              attemptDate: 1729265000000,
              sendAttemptResult: 'SUCCESS',
            },
          ],
        };
      },
    });

    const res = await makeRequest(
      server,
      {
        headers: { 'X-Sandbox-Secret': VALID_TEST_SECRET },
      },
      { action: 'status', testNotificationToken: mockToken },
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.action, 'status');
    assert.equal(res.body.sendAttempts.length, 1);
    assert.equal(res.body.sendAttempts[0].sendAttemptResult, 'SUCCESS');
    assert.equal(res.body.hasSignedPayload, true);
    // 確證無完整 JWS 洩漏
    assert.equal(res.body.signedPayload, undefined);
  });

  await t.test('13. 正常 action="status" 且 Apple 回報失敗狀態：不預設成功，正確解析 TIMED_OUT', async () => {
    const mockToken = 'mock_token_timeout_456';
    setCustomAppleServerApiClient({
      isConfigured: () => true,
      getStatus: () => ({ isConfigured: true, bundleId: EXPECTED_BUNDLE_ID, environment: 'sandbox' }),
      getTestNotificationStatus: async () => ({
        sendAttempts: [
          {
            attemptDate: 1729265100000,
            sendAttemptResult: 'TIMED_OUT',
          },
        ],
      }),
    });

    const res = await makeRequest(
      server,
      {
        headers: { 'X-Sandbox-Secret': VALID_TEST_SECRET },
      },
      { action: 'status', testNotificationToken: mockToken },
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.sendAttempts[0].sendAttemptResult, 'TIMED_OUT');
  });

  await t.test('14. 頻率限制防禦：超過 5 次呼叫回傳 429 RATE_LIMIT_EXCEEDED', async () => {
    setCustomAppleServerApiClient({
      isConfigured: () => true,
      getStatus: () => ({ isConfigured: true, bundleId: EXPECTED_BUNDLE_ID, environment: 'sandbox' }),
      requestTestNotification: async () => ({ testNotificationToken: 'token' }),
    });

    // 連續發送 5 次 (成功)
    for (let i = 0; i < 5; i++) {
      const res = await makeRequest(
        server,
        {
          headers: { 'X-Sandbox-Secret': VALID_TEST_SECRET },
        },
        { action: 'request' },
      );
      assert.equal(res.status, 200);
    }

    // 第 6 次觸發限流
    const limitedRes = await makeRequest(
      server,
      {
        headers: { 'X-Sandbox-Secret': VALID_TEST_SECRET },
      },
      { action: 'request' },
    );
    assert.equal(limitedRes.status, 429);
    assert.equal(limitedRes.body.code, 'RATE_LIMIT_EXCEEDED');
  });

  await t.test('15. Webhook TEST 模擬驗證：Apple TEST 通知 (無交易資訊) 能正常驗證並回傳 HTTP 200', async () => {
    // 模擬 Apple 官方 TEST 簽署通知：具有外層 signedPayload，但無 signedTransactionInfo
    setCustomNotificationVerifier({
      verifyAndDecode: async (payload) => {
        assert.equal(payload, 'valid_apple_signed_test_payload');
        return {
          isValid: true,
          notificationType: 'TEST',
          notificationUUID: 'test_uuid_apple_sandbox_1234',
          signedDate: Date.now(),
          environment: 'Sandbox',
          bundleId: EXPECTED_BUNDLE_ID,
          transaction: undefined, // TEST 通知無交易
          renewalInfo: undefined, // TEST 通知無續約
        };
      },
    });

    const res = await makeRequest(
      server,
      {
        path: '/api/apple-webhook',
        method: 'POST',
      },
      { signedPayload: 'valid_apple_signed_test_payload' },
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.notificationType, 'TEST');
    assert.equal(res.body.action, 'IGNORE_TEST_NOTIFICATION');

    // 檢查 Redis：絕無任何正式會員主記錄被寫入
    const keys = await inMemoryRedisMockInstance.smembers('exam_ai:keys_check');
    assert.equal(keys.length, 0);
  });
});
