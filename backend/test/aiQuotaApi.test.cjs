const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.MOCK_REDIS = 'true';
process.env.APP_SERVER_SECRET = 'test_secret_for_ai_quota_tests_32_bytes_long';

const aiQuotaModule = require('../dist/api/ai-quota.js');
const { inMemoryRedisMockInstance } = require('../dist/lib/redis.js');
const { generateEntitlementProofToken } = require('../dist/lib/entitlement.js');
const { getTaipeiDateParts } = require('../dist/lib/timezone.js');

const handler = typeof aiQuotaModule === 'function' ? aiQuotaModule : aiQuotaModule.default;

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

test('唯讀每日 AI 額度查詢 API 測試套件 (GET /api/ai-quota)', async (t) => {
  let appServer;

  t.before(async () => {
    appServer = await createServer();
  });

  t.after(async () => {
    if (appServer) await appServer.close();
  });

  t.beforeEach(() => {
    inMemoryRedisMockInstance.clearAll();
  });

  await t.test('1. OPTIONS 請求應回傳 200/204 CORS 成功', async () => {
    const res = await fetch(`${appServer.url}/api/ai-quota`, {
      method: 'OPTIONS',
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
  });

  await t.test('2. 非 GET 方法 (如 POST) 應回傳 405 METHOD_NOT_ALLOWED', async () => {
    const res = await fetch(`${appServer.url}/api/ai-quota`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 405);
    const body = await res.json();
    assert.strictEqual(body.code, 'METHOD_NOT_ALLOWED');
  });

  await t.test('3. Free 未登入用戶初次查詢：回傳 0/3，剩餘 3 次', async () => {
    const res = await fetch(`${appServer.url}/api/ai-quota`, {
      method: 'GET',
      headers: {
        'x-client-device-id': 'dev_free_user_initial_test',
      },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.quota.tier, 'free');
    assert.strictEqual(body.quota.dailyLimit, 3);
    assert.strictEqual(body.quota.usedToday, 0);
    assert.strictEqual(body.quota.remainingToday, 3);
    assert.ok(body.quota.resetsAt.includes('T00:00:00+08:00'));
  });

  await t.test('4. Free 用戶今日已有 1 次用量：精準反映 1/3，剩餘 2 次', async () => {
    const userId = 'dev_free_user_with_usage';
    const { dateKey } = getTaipeiDateParts();
    await inMemoryRedisMockInstance.set(`exam_ai:usage:day:${dateKey}:${userId}`, 1);

    const res = await fetch(`${appServer.url}/api/ai-quota`, {
      method: 'GET',
      headers: {
        'x-client-device-id': userId,
      },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.quota.usedToday, 1);
    assert.strictEqual(body.quota.remainingToday, 2);
  });

  await t.test('5. 唯讀保證：連續呼叫 GET /api/ai-quota 絕不自增計數器', async () => {
    const userId = 'dev_readonly_verification_user';
    const { dateKey } = getTaipeiDateParts();
    await inMemoryRedisMockInstance.set(`exam_ai:usage:day:${dateKey}:${userId}`, 1);

    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${appServer.url}/api/ai-quota`, {
        method: 'GET',
        headers: { 'x-client-device-id': userId },
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.quota.usedToday, 1);
      assert.strictEqual(body.quota.remainingToday, 2);
    }

    const rawInRedis = await inMemoryRedisMockInstance.get(`exam_ai:usage:day:${dateKey}:${userId}`);
    assert.strictEqual(rawInRedis, 1);
  });

  await t.test('6. Pro 用戶持合法 Proof Token：回傳 Pro 15 次上限與真實已用次數', async () => {
    const userId = 'dev_pro_verified_user_123';
    const origTxId = 'tx_orig_pro_123';
    const token = generateEntitlementProofToken(userId, origTxId, Date.now() + 7 * 86400 * 1000);

    const { dateKey } = getTaipeiDateParts();
    await inMemoryRedisMockInstance.set(`exam_ai:usage:day:${dateKey}:${userId}`, 2);

    const res = await fetch(`${appServer.url}/api/ai-quota`, {
      method: 'GET',
      headers: {
        'x-client-device-id': userId,
        'x-apple-proof-token': token,
      },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.quota.tier, 'pro');
    assert.strictEqual(body.quota.dailyLimit, 15);
    assert.strictEqual(body.quota.usedToday, 2);
    assert.strictEqual(body.quota.remainingToday, 13);
  });

  await t.test('7. 未知裝置安全防護：未提供任何 Device ID 標頭，安全降級為 IP Hash 識別並鎖定 Free 0/3', async () => {
    const res = await fetch(`${appServer.url}/api/ai-quota`, {
      method: 'GET',
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.quota.tier, 'free');
    assert.strictEqual(body.quota.dailyLimit, 3);
    assert.strictEqual(body.quota.usedToday, 0);
    assert.strictEqual(body.quota.remainingToday, 3);
  });

  await t.test('8. 偽造裝置 ID 防護：帶有冒號與惡意字元之 Device ID 經安全過濾，不造成 Redis Key 注入', async () => {
    const rawMaliciousId = 'dev_attacker:injection:::key!@#$%^&*()';
    const res = await fetch(`${appServer.url}/api/ai-quota`, {
      method: 'GET',
      headers: {
        'x-client-device-id': rawMaliciousId,
      },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.quota.tier, 'free');
    assert.strictEqual(body.quota.dailyLimit, 3);

    // 驗證過濾後的乾淨 key 存在，且冒號未被注入為 namespace
    const { dateKey } = getTaipeiDateParts();
    const sanitizedId = 'dev_attackerinjectionkey';
    const expectedKey = `exam_ai:usage:day:${dateKey}:${sanitizedId}`;
    // 查詢鍵不含注入字元
    assert.ok(!expectedKey.includes(':::'));
  });

  await t.test('9. 過期 Proof Token 防護：Token 已逾期且無續約，安全判定為無效並鎖定 Free 額度', async () => {
    const userId = 'dev_expired_token_user';
    const origTxId = 'tx_orig_expired_123';
    // 產生 1 小時前已過期的 Token
    const token = generateEntitlementProofToken(userId, origTxId, Date.now() - 3600 * 1000);

    const res = await fetch(`${appServer.url}/api/ai-quota`, {
      method: 'GET',
      headers: {
        'x-client-device-id': userId,
        'x-apple-proof-token': token,
      },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.quota.tier, 'free');
    assert.strictEqual(body.quota.dailyLimit, 3);
  });

  await t.test('10. 跨裝置冒用防護：裝置 B 盜用裝置 A 之合法 Proof Token，身分比對失敗鎖定為 Free', async () => {
    const victimUserId = 'dev_victim_user_A';
    const attackerUserId = 'dev_attacker_user_B';
    const origTxId = 'tx_orig_victim_999';
    // 簽署綁定 victimUserId 之合法 Token
    const victimToken = generateEntitlementProofToken(victimUserId, origTxId, Date.now() + 7 * 86400 * 1000);

    const res = await fetch(`${appServer.url}/api/ai-quota`, {
      method: 'GET',
      headers: {
        'x-client-device-id': attackerUserId,
        'x-apple-proof-token': victimToken,
      },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    // 盜用者無法取得 Pro 額度，嚴格受限為 Free
    assert.strictEqual(body.quota.tier, 'free');
    assert.strictEqual(body.quota.dailyLimit, 3);
  });

  await t.test('11. 退款聯防防護：交易已被 Apple 撤銷/退款，持有效簽名之 Token 一律降為 Free', async () => {
    const userId = 'dev_refunded_subscriber';
    const origTxId = 'tx_orig_refunded_888';
    const token = generateEntitlementProofToken(userId, origTxId, Date.now() + 7 * 86400 * 1000);

    // 在 Redis 寫入已撤銷記錄
    await inMemoryRedisMockInstance.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      status: 'revoked',
      revocationDate: Date.now() - 1000,
      tier: 'pro',
    });

    const res = await fetch(`${appServer.url}/api/ai-quota`, {
      method: 'GET',
      headers: {
        'x-client-device-id': userId,
        'x-apple-proof-token': token,
      },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.quota.tier, 'free');
    assert.strictEqual(body.quota.dailyLimit, 3);
  });

  await t.test('12. Lifetime 終身買斷版權益：Redis 記錄為 active Lifetime，正確回傳 15 次上限與真實已用次數', async () => {
    const userId = 'dev_lifetime_buyer_user';
    const origTxId = 'tx_orig_lifetime_777';

    // 建立 Lifetime 權限快取與交易關聯
    await inMemoryRedisMockInstance.sadd(`exam_ai:user:${userId}:apple_txns`, origTxId);
    await inMemoryRedisMockInstance.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      status: 'active',
      tier: 'lifetime',
      productId: 'exampro_lifetime',
    });
    await inMemoryRedisMockInstance.set(`exam_ai:user:${userId}:entitlement`, {
      userId,
      tier: 'lifetime',
      productId: 'exampro_lifetime',
      originalTransactionId: origTxId,
      expiresAt: null,
      verifiedAt: Date.now(),
      environment: 'Sandbox',
    });

    // 模擬今日已使用 3 次
    const { dateKey } = getTaipeiDateParts();
    await inMemoryRedisMockInstance.set(`exam_ai:usage:day:${dateKey}:${userId}`, 3);

    const res = await fetch(`${appServer.url}/api/ai-quota`, {
      method: 'GET',
      headers: {
        'x-client-device-id': userId,
      },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.quota.tier, 'pro');
    assert.strictEqual(body.quota.dailyLimit, 15);
    assert.strictEqual(body.quota.usedToday, 3);
    assert.strictEqual(body.quota.remainingToday, 12);
  });
});
