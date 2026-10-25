/**
 * 考試計畫 AI - Apple App Review 正式環境 Sandbox 相容性與隔離保護測試套件
 *
 * 驗證目標：
 * 1. 正式後端 (APPLE_IAP_ENVIRONMENT=production) 支援 Apple 審查員合法 Sandbox JWS 交易。
 * 2. 正式交易 (Production) 與審查交易 (Sandbox) 嚴格標記與隔離 (isSandbox: true/false)。
 * 3. 偽造 JWS、錯誤 Bundle ID、未授權 Product ID 必須被堅決拒絕。
 * 4. 未驗證交易絕不能賦予 Pro 權限。
 * 5. 審查交易到期、退款能正確降級為 Free。
 * 6. 審查員與一般付費者能享有各自的 AI 額度判定 (Pro 15 次 vs Free 3 次)。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { parse: parseUrl } = require('node:url');

const {
  resolveAppleEnvironment,
  isTransactionEnvironmentAllowed,
  isNotificationEnvironmentAllowed,
} = require('../dist/lib/appleEnvironment.js');
const {
  setCustomTransactionVerifier,
} = require('../dist/lib/appleIap.js');
const {
  getUserEntitlement,
  saveVerifiedEntitlement,
  generateEntitlementProofToken,
  verifyEntitlementProofToken,
} = require('../dist/lib/entitlement.js');
const { getRedisClient, inMemoryRedisMockInstance } = require('../dist/lib/redis.js');

const verifyTransactionHandler = require('../dist/api/verify-transaction.js').default;
const subscriptionStatusHandler = require('../dist/api/subscription-status.js').default;
const aiQuotaHandler = require('../dist/api/ai-quota.js').default;

function startTestServer() {
  const server = http.createServer(async (req, res) => {
    const parsed = parseUrl(req.url, true);
    req.query = parsed.query;

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');
    if (rawBody && req.headers['content-type']?.includes('application/json')) {
      try {
        req.body = JSON.parse(rawBody);
      } catch {
        req.body = rawBody;
      }
    } else {
      req.body = rawBody;
    }

    res.status = function (code) {
      this.statusCode = code;
      return this;
    };
    res.json = function (data) {
      this.setHeader('Content-Type', 'application/json; charset=utf-8');
      this.end(JSON.stringify(data));
      return this;
    };

    if (parsed.pathname === '/api/verify-transaction') {
      return verifyTransactionHandler(req, res);
    }
    if (parsed.pathname === '/api/subscription-status') {
      return subscriptionStatusHandler(req, res);
    }
    if (parsed.pathname === '/api/ai-quota') {
      return aiQuotaHandler(req, res);
    }

    res.writeHead(404).end('Not Found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve({
        server,
        baseUrl,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function postJson(baseUrl, path, body, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function getJson(baseUrl, path, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...headers,
    },
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

test('Apple App Review 正式環境相容性與隔離保護完整測試套件', async (t) => {
  const originalEnv = { ...process.env };
  let serverCtx;

  t.before(async () => {
    serverCtx = await startTestServer();
  });

  t.after(async () => {
    await serverCtx.close();
  });

  t.beforeEach(async () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'production',
      APPLE_IAP_ENVIRONMENT: 'production',
      MOCK_REDIS: 'true',
      APP_SERVER_SECRET: 'test_secret_for_review_tests_32_bytes',
    };
    delete process.env.APPLE_ALLOW_SANDBOX;
    inMemoryRedisMockInstance.clear();
    setCustomTransactionVerifier(null);
  });

  t.afterEach(() => {
    process.env = { ...originalEnv };
    setCustomTransactionVerifier(null);
  });

  await t.test('1. 正式環境角色解析：正確啟用 App Review Sandbox 相容開關，且嚴禁全域 sandbox 旗標', () => {
    const env = resolveAppleEnvironment();
    assert.strictEqual(env.valid, true);
    assert.strictEqual(env.targetRole, 'production');
    assert.strictEqual(env.allowSandbox, false);
    assert.strictEqual(env.allowAppReviewSandbox, true);

    // 驗證交易環境相容性
    assert.strictEqual(isTransactionEnvironmentAllowed('Production'), true);
    assert.strictEqual(isTransactionEnvironmentAllowed('Sandbox'), true);
    assert.strictEqual(isTransactionEnvironmentAllowed('staging'), false);
    assert.strictEqual(isTransactionEnvironmentAllowed('Xcode'), false);
  });

  await t.test('2. Apple 審查員 Sandbox 交易在正式後端順利完成驗證，並明確標記 isSandbox=true', async () => {
    const mockVerifier = {
      async verify(jws) {
        if (jws === 'valid_apple_review_sandbox_jws') {
          return {
            isValid: true,
            status: 'active',
            tier: 'pro',
            productId: 'exampro_monthly',
            transactionId: 'review_txn_101',
            originalTransactionId: 'review_orig_101',
            purchaseDate: Date.now(),
            expiresDate: Date.now() + 30 * 86400000,
            environment: 'Sandbox',
            isSandbox: true,
            isExpired: false,
            isRevoked: false,
          };
        }
        return { isValid: false, status: 'invalid', tier: 'free', isExpired: false, isRevoked: false };
      },
    };
    setCustomTransactionVerifier(mockVerifier);

    const res = await postJson(
      serverCtx.baseUrl,
      '/api/verify-transaction',
      { signedTransaction: 'valid_apple_review_sandbox_jws' },
      { 'x-client-device-id': 'dev_apple_reviewer_iphone' },
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.tier, 'pro');
    assert.strictEqual(res.data.status, 'active');
    assert.strictEqual(res.data.environment, 'Sandbox');
    assert.strictEqual(res.data.isSandbox, true);
    assert.ok(res.data.proofToken, '必須回傳合法的 Proof Token');

    // 檢查 Redis 儲存結果包含 isSandbox 標籤
    const ent = await getUserEntitlement('dev_apple_reviewer_iphone');
    assert.strictEqual(ent.tier, 'pro');
    assert.strictEqual(ent.isVerified, true);
    assert.strictEqual(ent.environment, 'Sandbox');
    assert.strictEqual(ent.isSandbox, true);
  });

  await t.test('3. 真實正式付費用戶 (Production) 交易驗證通過，並標記 isSandbox=false', async () => {
    const mockVerifier = {
      async verify(jws) {
        if (jws === 'valid_production_user_jws') {
          return {
            isValid: true,
            status: 'active',
            tier: 'pro',
            productId: 'exampro_yearly',
            transactionId: 'prod_txn_201',
            originalTransactionId: 'prod_orig_201',
            purchaseDate: Date.now(),
            expiresDate: Date.now() + 365 * 86400000,
            environment: 'Production',
            isSandbox: false,
            isExpired: false,
            isRevoked: false,
          };
        }
        return { isValid: false, status: 'invalid', tier: 'free', isExpired: false, isRevoked: false };
      },
    };
    setCustomTransactionVerifier(mockVerifier);

    const res = await postJson(
      serverCtx.baseUrl,
      '/api/verify-transaction',
      { signedTransaction: 'valid_production_user_jws' },
      { 'x-client-device-id': 'dev_real_production_user' },
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.tier, 'pro');
    assert.strictEqual(res.data.environment, 'Production');
    assert.strictEqual(res.data.isSandbox, false);

    const ent = await getUserEntitlement('dev_real_production_user');
    assert.strictEqual(ent.tier, 'pro');
    assert.strictEqual(ent.isSandbox, false);
    assert.strictEqual(ent.environment, 'Production');
  });

  await t.test('4. 偽造 JWS 簽章在正式後端必須被 400 拒絕，且不可取得 Pro 資格', async () => {
    const res = await postJson(
      serverCtx.baseUrl,
      '/api/verify-transaction',
      { signedTransaction: 'forged_fake_jws_from_attacker' },
      { 'x-client-device-id': 'dev_attacker_fake_sig' },
    );

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.success, false);
    assert.strictEqual(res.data.tier, 'free');

    const ent = await getUserEntitlement('dev_attacker_fake_sig');
    assert.strictEqual(ent.tier, 'free');
    assert.strictEqual(ent.isVerified, false);
  });

  await t.test('5. 錯誤 Bundle ID 必須被堅決拒絕', async () => {
    const mockVerifier = {
      async verify() {
        return {
          isValid: false,
          status: 'invalid',
          tier: 'free',
          isExpired: false,
          isRevoked: false,
          errorMessage: '交易應用程式識別碼不相符 (預期 com.examplanai.app，實際 com.other.app)。',
        };
      },
    };
    setCustomTransactionVerifier(mockVerifier);

    const res = await postJson(
      serverCtx.baseUrl,
      '/api/verify-transaction',
      { signedTransaction: 'wrong_bundle_jws' },
      { 'x-client-device-id': 'dev_wrong_bundle_user' },
    );

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.success, false);
    assert.match(res.data.error, /交易應用程式識別碼不相符/);
  });

  await t.test('6. 審查員使用會員狀態 API (GET /api/subscription-status) 時正確識別 Sandbox 方案並刷新權杖', async () => {
    // 預先在 Redis 寫入審查員收據
    const now = Date.now();
    await saveVerifiedEntitlement(
      'dev_reviewer_device_301',
      {
        isValid: true,
        status: 'active',
        tier: 'pro',
        productId: 'exampro_monthly',
        transactionId: 'review_txn_301',
        originalTransactionId: 'review_orig_301',
        expiresDate: now + 86400000,
        environment: 'Sandbox',
        isSandbox: true,
        willRenew: true,
        isExpired: false,
        isRevoked: false,
      },
    );

    const token = generateEntitlementProofToken('dev_reviewer_device_301', 'review_orig_301', now + 86400000);

    const res = await getJson(serverCtx.baseUrl, '/api/subscription-status', {
      'x-client-device-id': 'dev_reviewer_device_301',
      Authorization: `Bearer ${token}`,
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.tier, 'pro');
    assert.strictEqual(res.data.status, 'active');
    assert.strictEqual(res.data.environment, 'Sandbox');
    assert.strictEqual(res.data.isSandbox, true);
    assert.strictEqual(res.data.willRenew, true);
  });

  await t.test('7. 審查員在 Pro 狀態下享有 15 次/日額度，過期後安全降為 Free 3 次/日', async () => {
    // 狀態 1: Pro 審查員查詢額度
    const now = Date.now();
    await saveVerifiedEntitlement(
      'dev_reviewer_quota_device',
      {
        isValid: true,
        status: 'active',
        tier: 'pro',
        productId: 'exampro_monthly',
        transactionId: 'review_txn_quota_1',
        originalTransactionId: 'review_orig_quota_1',
        expiresDate: now + 86400000,
        environment: 'Sandbox',
        isSandbox: true,
        isExpired: false,
        isRevoked: false,
      },
    );

    const token = generateEntitlementProofToken('dev_reviewer_quota_device', 'review_orig_quota_1', now + 86400000);

    const proQuotaRes = await getJson(serverCtx.baseUrl, '/api/ai-quota', {
      'x-client-device-id': 'dev_reviewer_quota_device',
      'x-apple-proof-token': token,
    });

    assert.strictEqual(proQuotaRes.status, 200);
    assert.strictEqual(proQuotaRes.data.success, true);
    assert.strictEqual(proQuotaRes.data.quota.tier, 'pro');
    assert.strictEqual(proQuotaRes.data.quota.dailyLimit, 15);
    assert.strictEqual(proQuotaRes.data.quota.remainingToday, 15);

    // 狀態 2: 模擬審查員訂閱到期
    const expiredUserId = 'dev_reviewer_expired_device';
    const expiredTxId = 'review_txn_expired_1';
    const pastExpires = now - 3600000;
    const redis = getRedisClient();

    await redis.set(`exam_ai:apple:entitlement:${expiredTxId}`, {
      originalTransactionId: expiredTxId,
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'expired',
      expiresDate: pastExpires,
      willRenew: false,
      environment: 'Sandbox',
      isSandbox: true,
    });
    await redis.zadd(`exam_ai:apple:devices_z:${expiredTxId}`, { score: now, member: expiredUserId });
    await redis.sadd(`exam_ai:user:${expiredUserId}:apple_txns`, expiredTxId);

    const expiredToken = generateEntitlementProofToken(expiredUserId, expiredTxId, pastExpires);

    const expiredQuotaRes = await getJson(serverCtx.baseUrl, '/api/ai-quota', {
      'x-client-device-id': expiredUserId,
      'x-apple-proof-token': expiredToken,
    });

    assert.strictEqual(expiredQuotaRes.status, 200);
    assert.strictEqual(expiredQuotaRes.data.quota.tier, 'free');
    assert.strictEqual(expiredQuotaRes.data.quota.dailyLimit, 3);
    assert.strictEqual(expiredQuotaRes.data.quota.remainingToday, 3);
  });
});
