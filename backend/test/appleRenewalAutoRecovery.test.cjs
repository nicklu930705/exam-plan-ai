const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// 設定測試環境變數
process.env.MOCK_REDIS = 'true';
process.env.OPENAI_API_KEY = 'test_mock_key';
process.env.APP_SERVER_SECRET = 'test_secret_for_auto_recovery_phase15';
process.env.APPLE_WEBHOOK_DRY_RUN = 'false';

const statusModule = require('../dist/api/subscription-status.js');
const verifyTxModule = require('../dist/api/verify-transaction.js');
const {
  EXPECTED_BUNDLE_ID,
  setCustomTransactionVerifier,
} = require('../dist/lib/appleIap.js');
const {
  getRedisClient,
  inMemoryRedisMockInstance,
  SAVE_ENTITLEMENT_OCC_LUA,
} = require('../dist/lib/redis.js');
const {
  saveVerifiedEntitlement,
  getOriginalTransactionEntitlement,
  getUserEntitlement,
  syncUserDeviceEffectiveEntitlement,
  generateEntitlementProofToken,
  verifyEntitlementProofToken,
} = require('../dist/lib/entitlement.js');
const {
  applySubscriptionStateToRedis,
} = require('../dist/lib/appleSubscriptionSync.js');

const statusHandler = typeof statusModule === 'function' ? statusModule : statusModule.default;
const verifyHandler = typeof verifyTxModule === 'function' ? verifyTxModule : verifyTxModule.default;

// 建立測試 HTTP 伺服器
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
        req.body = {};
      }
    } else {
      req.body = {};
    }

    const url = new URL(req.url, 'http://localhost');
    req.query = Object.fromEntries(url.searchParams);

    const originalJson = res.json;
    res.json = function (obj) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(obj));
      return res;
    };
    res.status = function (code) {
      res.statusCode = code;
      return res;
    };

    if (url.pathname === '/api/subscription-status') {
      return statusHandler(req, res);
    }
    if (url.pathname === '/api/verify-transaction') {
      return verifyHandler(req, res);
    }

    res.statusCode = 404;
    res.end('Not Found');
  });

  return server;
}

// 發送 HTTP 請求輔助函式
function postJson(server, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const data = JSON.stringify(body || {});

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        const respChunks = [];
        res.on('data', (c) => respChunks.push(c));
        res.on('end', () => {
          const respBody = Buffer.concat(respChunks).toString('utf-8');
          let parsed = {};
          try {
            parsed = JSON.parse(respBody);
          } catch {
            parsed = { raw: respBody };
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      },
    );

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('Phase 3.4c-15：Apple 自動續訂後 Pro 權益安全恢復與端到端完整測試套件', async (t) => {
  let server;
  const redis = getRedisClient();

  t.before(async () => {
    server = createTestServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  t.after(async () => {
    setCustomTransactionVerifier(null);
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // 每個測試前清空 Mock Redis
  t.beforeEach(() => {
    inMemoryRedisMockInstance.clearAll();
    setCustomTransactionVerifier(null);
  });

  // ───── TC1：過期 Token + Apple 已續約 -> 安全換發新 Token 並回傳 Pro ─────
  await t.test('TC1：過期 Token + Apple 已在雲端續約 -> 換發新 Token，成功恢復 Pro 與新到期日', async () => {
    const userId = 'dev_user_tc1';
    const origTxId = 'orig_tx_tc1';
    const now = Date.now();
    const oldExpiresDate = now - 3600 * 1000; // 1 小時前已過期
    const renewedExpiresDate = now + 86400 * 1000; // Apple 雲端續約至明天

    // 1. 產生內含「舊到期時間」的過期 Proof Token
    const expiredToken = generateEntitlementProofToken(userId, origTxId, oldExpiresDate);

    // 2. 模擬 Apple Webhook 已將 Redis 主記錄推進至最新續訂時間
    await redis.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      lastTransactionId: 'tx_renewed_tc1',
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      purchaseDate: now - 30 * 86400 * 1000,
      originalPurchaseDate: now - 30 * 86400 * 1000,
      expiresDate: renewedExpiresDate,
      willRenew: true,
      verifiedAt: now,
      environment: 'Sandbox',
    });
    await redis.zadd(`exam_ai:apple:devices_z:${origTxId}`, { score: now, member: userId });
    await redis.sadd(`exam_ai:user:${userId}:apple_txns`, origTxId);
    await syncUserDeviceEffectiveEntitlement(userId, origTxId);

    // 3. 呼叫 /api/subscription-status
    const res = await postJson(server, '/api/subscription-status', {}, {
      'X-Client-Device-Id': userId,
      Authorization: `Bearer ${expiredToken}`,
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.tier, 'pro');
    assert.strictEqual(res.body.status, 'active');
    assert.strictEqual(res.body.isVerified, true);
    assert.strictEqual(res.body.expiresAt, renewedExpiresDate);
    assert.strictEqual(res.body.willRenew, true);
    assert.ok(res.body.proofToken, '必須發放全新換發的 Proof Token');
    assert.notStrictEqual(res.body.proofToken, expiredToken, '新 Token 必須與舊過期 Token 不同');

    // 4. 驗證換發的新 Token 是否具備權威有效性
    const tokenVerification = await verifyEntitlementProofToken(res.body.proofToken, userId);
    assert.strictEqual(tokenVerification.valid, true, '換發之新 Token 必須驗證為有效');
    assert.strictEqual(tokenVerification.originalTransactionId, origTxId);
  });

  // ───── TC2：舊 JWS + Redis 已續約 -> 安全保護續約，回傳 Pro 與新到期日 ─────
  await t.test('TC2：持過期舊 JWS 查詢 + Redis 雲端已續約 -> 不得覆蓋有效續訂，發放新 Token 並回傳 Pro', async () => {
    const userId = 'dev_user_tc2';
    const origTxId = 'orig_tx_tc2';
    const now = Date.now();
    const oldExpiresDate = now - 1800 * 1000; // 30 分鐘前到期
    const renewedExpiresDate = now + 86400 * 1000; // Redis 已續約

    // 1. 設定 Mock Verifier 回傳舊過期 JWS 解碼結果
    setCustomTransactionVerifier({
      async verify(jws) {
        if (jws === 'mock_expired_jws_tc2') {
          return {
            isValid: true,
            tier: 'pro',
            status: 'expired',
            productId: 'exampro_monthly',
            transactionId: 'tx_old_tc2',
            originalTransactionId: origTxId,
            purchaseDate: now - 30 * 86400 * 1000,
            originalPurchaseDate: now - 30 * 86400 * 1000,
            expiresDate: oldExpiresDate,
            environment: 'Sandbox',
            bundleId: EXPECTED_BUNDLE_ID,
          };
        }
        return { isValid: false, errorMessage: '無效 JWS' };
      },
    });

    // 2. 模擬 Redis 已存在 Apple Webhook 推進之有效續訂
    await redis.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      lastTransactionId: 'tx_renewed_tc2',
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      purchaseDate: now - 30 * 86400 * 1000,
      originalPurchaseDate: now - 30 * 86400 * 1000,
      expiresDate: renewedExpiresDate,
      willRenew: true,
      verifiedAt: now,
      environment: 'Sandbox',
    });
    await redis.zadd(`exam_ai:apple:devices_z:${origTxId}`, { score: now, member: userId });
    await redis.sadd(`exam_ai:user:${userId}:apple_txns`, origTxId);

    // 3. 呼叫 /api/subscription-status 帶入舊 JWS (無 Token)
    const res = await postJson(server, '/api/subscription-status', {
      signedTransaction: 'mock_expired_jws_tc2',
    }, {
      'X-Client-Device-Id': userId,
      'X-Apple-JWS': 'mock_expired_jws_tc2',
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.tier, 'pro');
    assert.strictEqual(res.body.status, 'active');
    assert.strictEqual(res.body.isVerified, true);
    assert.strictEqual(res.body.expiresAt, renewedExpiresDate, '到期日必須採用 Redis 權威之續訂新到期日');
    assert.ok(res.body.proofToken, '必須為用戶換發全新 Proof Token');

    // 4. 驗證新 Token 有效性
    const tokenCheck = await verifyEntitlementProofToken(res.body.proofToken, userId);
    assert.strictEqual(tokenCheck.valid, true);
  });

  // ───── TC3：全部憑證遺失（無 Token、無 JWS） -> 零信任安全阻斷 ─────
  await t.test('TC3：全部憑證遺失 (僅宣稱 deviceId 或 originalTransactionId) -> 絕不發放 Pro，回傳 Free 或 401', async () => {
    const userId = 'dev_user_tc3';
    const origTxId = 'orig_tx_tc3';
    const now = Date.now();

    // 即使 Redis 中該交易為 active
    await redis.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      expiresDate: now + 86400 * 1000,
      environment: 'Sandbox',
    });

    // 情境 A：僅傳入 originalTransactionId 無任何簽署憑據 -> 401 Unauthorized
    const resA = await postJson(server, '/api/subscription-status', {
      originalTransactionId: origTxId,
    }, {
      'X-Client-Device-Id': userId,
      'X-Original-Transaction-Id': origTxId,
    });
    assert.strictEqual(resA.status, 401);
    assert.strictEqual(resA.body.tier, 'free');
    assert.strictEqual(resA.body.isVerified, false);
    assert.strictEqual(resA.body.proofToken, undefined);

    // 情境 B：完全無憑證純訪客 -> 200 Free (status: none)
    const resB = await postJson(server, '/api/subscription-status', {}, {
      'X-Client-Device-Id': userId,
    });
    assert.strictEqual(resB.status, 200);
    assert.strictEqual(resB.body.tier, 'free');
    assert.strictEqual(resB.body.status, 'none');
    assert.strictEqual(resB.body.isVerified, false);
    assert.strictEqual(resB.body.proofToken, undefined);
  });

  // ───── TC4：訂閱真正到期（Token 到期且 Redis 亦到期未續約） -> 回傳 Free ─────
  await t.test('TC4：真正到期未續約 (Token 與 Redis 主記錄皆已過期) -> 回傳 expired Free，拒絕換發', async () => {
    const userId = 'dev_user_tc4';
    const origTxId = 'orig_tx_tc4';
    const now = Date.now();
    const pastExpires = now - 3600 * 1000;

    const expiredToken = generateEntitlementProofToken(userId, origTxId, pastExpires);

    // Redis 主記錄亦為已過期 (未續約)
    await redis.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'expired',
      expiresDate: pastExpires,
      willRenew: false,
      environment: 'Sandbox',
    });
    await redis.zadd(`exam_ai:apple:devices_z:${origTxId}`, { score: now, member: userId });
    await redis.sadd(`exam_ai:user:${userId}:apple_txns`, origTxId);

    const res = await postJson(server, '/api/subscription-status', {}, {
      'X-Client-Device-Id': userId,
      Authorization: `Bearer ${expiredToken}`,
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.tier, 'free');
    assert.strictEqual(res.body.status, 'expired');
    assert.strictEqual(res.body.isVerified, false);
    assert.strictEqual(res.body.proofToken, undefined, '過期未續約絕不發放新 Token');
  });

  // ───── TC5：退款或撤銷（Token 已過期，但交易已被 Apple 撤銷或退款） -> 絕對阻斷 ─────
  await t.test('TC5：退款/撤銷阻斷 -> 無論 Token 是否過期，Redis 標記為 revoked 時絕對回傳 Free 並拒絕換發', async () => {
    const userId = 'dev_user_tc5';
    const origTxId = 'orig_tx_tc5';
    const now = Date.now();

    const expiredToken = generateEntitlementProofToken(userId, origTxId, now - 1000);

    // 交易已在 Redis 標記為 revoked
    await redis.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'revoked',
      revocationDate: now - 5000,
      expiresDate: now + 86400 * 1000,
      environment: 'Sandbox',
    });
    await redis.zadd(`exam_ai:apple:devices_z:${origTxId}`, { score: now, member: userId });
    await redis.sadd(`exam_ai:user:${userId}:apple_txns`, origTxId);

    const res = await postJson(server, '/api/subscription-status', {}, {
      'X-Client-Device-Id': userId,
      Authorization: `Bearer ${expiredToken}`,
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.tier, 'free');
    assert.strictEqual(res.body.status, 'revoked');
    assert.strictEqual(res.body.isVerified, false);
    assert.strictEqual(res.body.proofToken, undefined, '已撤銷交易絕不發放新 Token');
  });

  // ───── TC6：偽造與竄改 Token -> 簽章校驗阻斷 ─────
  await t.test('TC6：竄改 Token 內文或簽名 -> 簽名不符，安全阻斷降為 Free', async () => {
    const userId = 'dev_user_tc6';
    const origTxId = 'orig_tx_tc6';
    const now = Date.now();

    const legitToken = generateEntitlementProofToken(userId, origTxId, now + 86400 * 1000);
    const [payloadB64, sig] = legitToken.split('.');
    // 惡意竄改 payload (例如更改 userId)
    const tamperedPayload = Buffer.from(`hacker_user:${origTxId}:${now + 86400 * 1000}`).toString('base64url');
    const tamperedToken = `${tamperedPayload}.${sig}`;

    const res = await postJson(server, '/api/subscription-status', {}, {
      'X-Client-Device-Id': 'hacker_user',
      Authorization: `Bearer ${tamperedToken}`,
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.tier, 'free');
    assert.strictEqual(res.body.isVerified, false);
    assert.strictEqual(res.body.proofToken, undefined);
  });

  // ───── TC7：不同裝置或使用者冒用（拿裝置 A 的過期 Token 在裝置 B 請求） -> 拒絕 ─────
  await t.test('TC7：跨裝置冒用 -> 裝置 B 盜用裝置 A 之過期 Token，身分比對不符拒絕換發', async () => {
    const userA = 'device_A_legit';
    const userB = 'device_B_attacker';
    const origTxId = 'orig_tx_tc7';
    const now = Date.now();

    const tokenOfA = generateEntitlementProofToken(userA, origTxId, now - 1000);

    // Redis 主記錄為 active (屬於用戶 A)
    await redis.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      expiresDate: now + 86400 * 1000,
      environment: 'Sandbox',
    });
    await redis.zadd(`exam_ai:apple:devices_z:${origTxId}`, { score: now, member: userA });
    await redis.sadd(`exam_ai:user:${userA}:apple_txns`, origTxId);

    // 裝置 B 帶入裝置 A 的 Token
    const res = await postJson(server, '/api/subscription-status', {}, {
      'X-Client-Device-Id': userB,
      Authorization: `Bearer ${tokenOfA}`,
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.tier, 'free');
    assert.strictEqual(res.body.isVerified, false);
    assert.strictEqual(res.body.proofToken, undefined, '跨裝置冒用絕不發放 Token');
  });

  // ───── TC8：遠古 Token 重放（超過 30 天安全窗口） -> 拒絕換發 ─────
  await t.test('TC8：遠古 Token 重放 (過期大於 30 天) -> 超出安全輪轉窗口，拒絕換發新 Token', async () => {
    const userId = 'dev_user_tc8';
    const origTxId = 'orig_tx_tc8';
    const now = Date.now();
    const veryOldExpires = now - 35 * 86400 * 1000; // 35 天前過期 (超出 30 天窗口)

    const ancientToken = generateEntitlementProofToken(userId, origTxId, veryOldExpires);

    // 即使 Redis 記錄目前是 active
    await redis.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      expiresDate: now + 86400 * 1000,
      environment: 'Sandbox',
    });
    await redis.zadd(`exam_ai:apple:devices_z:${origTxId}`, { score: now, member: userId });
    await redis.sadd(`exam_ai:user:${userId}:apple_txns`, origTxId);

    const res = await postJson(server, '/api/subscription-status', {}, {
      'X-Client-Device-Id': userId,
      Authorization: `Bearer ${ancientToken}`,
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.tier, 'free');
    assert.strictEqual(res.body.isVerified, false);
    assert.strictEqual(res.body.proofToken, undefined, '遠古 Token 拒絕輪轉');
  });

  // ───── TC9：Lifetime 終身買斷版權益受完整保護 ─────
  await t.test('TC9：Lifetime 終身買斷版 -> 7 天滾動 Token 過期時自動換發新 Token，維持 Lifetime 且不被月訂閱覆蓋', async () => {
    const userId = 'dev_user_tc9';
    const origTxId = 'orig_tx_lifetime_tc9';
    const now = Date.now();
    const tokenExp = now - 1000; // 7 天 Token 剛過期

    const expiredLifeToken = generateEntitlementProofToken(userId, origTxId, tokenExp);

    await redis.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      productId: 'exampro_lifetime',
      tier: 'lifetime',
      status: 'active',
      purchaseDate: now - 100 * 86400 * 1000,
      originalPurchaseDate: now - 100 * 86400 * 1000,
      expiresDate: null,
      environment: 'Sandbox',
    });
    await redis.zadd(`exam_ai:apple:devices_z:${origTxId}`, { score: now, member: userId });
    await redis.sadd(`exam_ai:user:${userId}:apple_txns`, origTxId);
    await syncUserDeviceEffectiveEntitlement(userId, origTxId);

    const res = await postJson(server, '/api/subscription-status', {}, {
      'X-Client-Device-Id': userId,
      Authorization: `Bearer ${expiredLifeToken}`,
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.tier, 'lifetime');
    assert.strictEqual(res.body.status, 'active');
    assert.strictEqual(res.body.isVerified, true);
    assert.ok(res.body.proofToken, 'Lifetime 過期 Token 必須成功換發新 Token');

    const check = await verifyEntitlementProofToken(res.body.proofToken, userId);
    assert.strictEqual(check.valid, true);
  });

  // ───── TC10：Webhook 與 API 併發維持資料一致 ─────
  await t.test('TC10：Webhook 寫入與 App 查詢並行競爭 -> OCC 機制保持一致性，不發生狀態錯亂', async () => {
    const userId = 'dev_user_tc10';
    const origTxId = 'orig_tx_tc10';
    const now = Date.now();
    const tokenExp = now - 500;
    const renewedExp = now + 86400 * 1000;

    const expiredToken = generateEntitlementProofToken(userId, origTxId, tokenExp);

    // 先建立初始過期紀錄
    await redis.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      expiresDate: tokenExp,
      environment: 'Sandbox',
    });
    await redis.zadd(`exam_ai:apple:devices_z:${origTxId}`, { score: now, member: userId });
    await redis.sadd(`exam_ai:user:${userId}:apple_txns`, origTxId);

    // 同時發起：1. Webhook 寫入續約  2. App 查詢狀態
    const webhookPromise = applySubscriptionStateToRedis({
      originalTransactionId: origTxId,
      transition: {
        actionable: true,
        action: 'APPLY_RENEWAL',
        status: 'active',
        tier: 'pro',
        willRenew: true,
        effectiveExpiresDate: renewedExp,
        reason: 'Apple DID_RENEW',
      },
      now,
    });

    const statusPromise = postJson(server, '/api/subscription-status', {}, {
      'X-Client-Device-Id': userId,
      Authorization: `Bearer ${expiredToken}`,
    });

    const [webhookRes, statusRes] = await Promise.all([webhookPromise, statusPromise]);

    assert.strictEqual(webhookRes.success, true);
    assert.strictEqual(statusRes.status, 200);

    // 檢查最終 Redis 狀態
    const record = await getOriginalTransactionEntitlement(origTxId);
    assert.strictEqual(record.status, 'active');
    assert.strictEqual(record.expiresDate, renewedExp);
    assert.strictEqual(record.willRenew, true);
  });

  // ───── TC11：前端 Build 6 回傳格式相容性驗證 ─────
  await t.test('TC11：Build 6 格式相容性 -> 回傳欄位完全吻合 AppStore 與 subscriptionSyncService 規格', async () => {
    const userId = 'dev_user_tc11';
    const origTxId = 'orig_tx_tc11';
    const now = Date.now();
    const expDate = now + 86400 * 1000;

    const expiredToken = generateEntitlementProofToken(userId, origTxId, now - 1000);

    await redis.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      expiresDate: expDate,
      willRenew: true,
      environment: 'Sandbox',
    });
    await redis.zadd(`exam_ai:apple:devices_z:${origTxId}`, { score: now, member: userId });
    await redis.sadd(`exam_ai:user:${userId}:apple_txns`, origTxId);

    const res = await postJson(server, '/api/subscription-status', {}, {
      'X-Client-Device-Id': userId,
      Authorization: `Bearer ${expiredToken}`,
    });

    assert.strictEqual(res.status, 200);
    // 嚴格比對 Build 6 subscriptionSyncService 所需的鍵值
    assert.strictEqual(typeof res.body.success, 'boolean');
    assert.strictEqual(res.body.tier, 'pro');
    assert.strictEqual(res.body.status, 'active');
    assert.strictEqual(typeof res.body.productId, 'string');
    assert.strictEqual(typeof res.body.originalTransactionId, 'string');
    assert.strictEqual(typeof res.body.expiresAt, 'number');
    assert.strictEqual(typeof res.body.willRenew, 'boolean');
    assert.strictEqual(typeof res.body.proofToken, 'string');
    assert.strictEqual(res.body.isVerified, true);
    assert.strictEqual(typeof res.body.serverTime, 'number');
  });
});
