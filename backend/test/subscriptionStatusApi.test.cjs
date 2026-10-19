const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// 設定測試環境變數
process.env.MOCK_REDIS = 'true';
process.env.OPENAI_API_KEY = 'test_mock_key';
process.env.APP_SERVER_SECRET = 'test_signing_secret_for_status_tests';
process.env.APPLE_WEBHOOK_DRY_RUN = 'false';

const statusModule = require('../dist/api/subscription-status.js');
const verifyTxModule = require('../dist/api/verify-transaction.js');
const {
  setCustomTransactionVerifier,
  EXPECTED_BUNDLE_ID,
} = require('../dist/lib/appleIap.js');
const {
  inMemoryRedisMockInstance,
  SAVE_ENTITLEMENT_OCC_LUA,
} = require('../dist/lib/redis.js');
const {
  generateEntitlementProofToken,
  verifyEntitlementProofToken,
  saveVerifiedEntitlement,
  getOriginalTransactionEntitlement,
} = require('../dist/lib/entitlement.js');
const {
  applySubscriptionStateToRedis,
} = require('../dist/lib/appleSubscriptionSync.js');

const statusHandler = typeof statusModule === 'function' ? statusModule : statusModule.default;
const verifyHandler = typeof verifyTxModule === 'function' ? verifyTxModule : verifyTxModule.default;

// 建立本機 HTTP 測試伺服器
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
      if (req.url && req.url.startsWith('/api/subscription-status')) {
        await statusHandler(req, res);
      } else if (req.url && req.url.startsWith('/api/verify-transaction')) {
        await verifyHandler(req, res);
      } else {
        res.status(404).json({ error: 'Not Found' });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return server;
}

function makeRequest(server, options, payload) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const reqOptions = {
      hostname: '127.0.0.1',
      port: addr.port,
      path: options.path || '/api/subscription-status',
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
        const bodyStr = Buffer.concat(chunks).toString('utf-8');
        let body;
        try {
          body = JSON.parse(bodyStr);
        } catch {
          body = bodyStr;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body,
        });
      });
    });

    req.on('error', reject);
    if (payload) {
      req.write(typeof payload === 'string' ? payload : JSON.stringify(payload));
    }
    req.end();
  });
}

test('會員狀態查詢 API (subscription-status) 與 Redis OCC 安全測試套件', async (t) => {
  let server;

  t.before(() => {
    return new Promise((resolve) => {
      server = createTestServer();
      server.listen(0, '127.0.0.1', resolve);
    });
  });

  t.after(() => {
    return new Promise((resolve) => {
      server.close(resolve);
    });
  });

  t.beforeEach(() => {
    inMemoryRedisMockInstance.clear();
  });

  await t.test('1. OPTIONS 預檢請求：回傳 200 與完整 CORS 標頭', async () => {
    const res = await makeRequest(server, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.com',
      },
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.ok(res.headers['access-control-allow-methods'].includes('POST'));
    assert.ok(res.headers['access-control-allow-methods'].includes('GET'));
  });

  await t.test('2. 正常查詢：持有有效 Proof Token 查詢 Pro 月訂閱狀態', async () => {
    const userId = 'dev_pro_user_01';
    const originalTransactionId = 'orig_tx_pro_1001';
    const expiresAt = Date.now() + 15 * 86400 * 1000; // 15 天後到期

    // 在 Redis 寫入有效交易紀錄
    await saveVerifiedEntitlement(userId, {
      isValid: true,
      tier: 'pro',
      status: 'active',
      productId: 'exampro_monthly',
      transactionId: 'tx_1001',
      originalTransactionId,
      purchaseDate: Date.now() - 86400 * 1000,
      expiresDate: expiresAt,
      environment: 'Sandbox',
      bundleId: EXPECTED_BUNDLE_ID,
    });

    const token = generateEntitlementProofToken(userId, originalTransactionId, expiresAt);

    const res = await makeRequest(
      server,
      {
        method: 'POST',
        headers: {
          'X-Client-Device-Id': userId,
          Authorization: `Bearer ${token}`,
        },
      },
      { deviceId: userId },
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.tier, 'pro');
    assert.equal(res.body.status, 'active');
    assert.equal(res.body.productId, 'exampro_monthly');
    assert.equal(res.body.originalTransactionId, originalTransactionId);
    assert.equal(res.body.expiresAt, expiresAt);
    assert.equal(res.body.willRenew, true);
    assert.equal(res.body.isVerified, true);
    assert.ok(res.body.proofToken);
  });

  await t.test('3. 正常查詢：持有有效 Proof Token 查詢 Lifetime 終身方案狀態', async () => {
    const userId = 'dev_lifetime_user_02';
    const originalTransactionId = 'orig_tx_life_2001';

    await saveVerifiedEntitlement(userId, {
      isValid: true,
      tier: 'lifetime',
      status: 'active',
      productId: 'exampro_lifetime',
      transactionId: 'tx_life_2001',
      originalTransactionId,
      purchaseDate: Date.now() - 86400 * 1000,
      environment: 'Sandbox',
      bundleId: EXPECTED_BUNDLE_ID,
    });

    const token = generateEntitlementProofToken(userId, originalTransactionId, null);

    const res = await makeRequest(
      server,
      {
        method: 'GET',
        headers: {
          'X-Client-Device-Id': userId,
          'X-Apple-Proof-Token': token,
        },
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.tier, 'lifetime');
    assert.equal(res.body.status, 'active');
    assert.equal(res.body.productId, 'exampro_lifetime');
    assert.equal(res.body.isVerified, true);
  });

  await t.test('4. 自我修復：Proof Token 過期但攜帶有效 Apple JWS，伺服端自動續期簽發新 Token', async () => {
    const userId = 'dev_healing_user_03';
    const originalTransactionId = 'orig_tx_renew_3001';
    const futureExpires = Date.now() + 20 * 86400 * 1000;

    // 建立自訂 Mock Verifier
    setCustomTransactionVerifier({
      async verify(jws) {
        if (jws === 'valid_storekit2_renewed_jws') {
          return {
            isValid: true,
            tier: 'pro',
            status: 'active',
            productId: 'exampro_annual',
            transactionId: 'tx_3002',
            originalTransactionId,
            purchaseDate: Date.now() - 365 * 86400 * 1000,
            expiresDate: futureExpires,
            environment: 'Sandbox',
            bundleId: EXPECTED_BUNDLE_ID,
          };
        }
        return { isValid: false, errorMessage: '無效簽署' };
      },
    });

    // 傳送過期的 Proof Token
    const expiredToken = generateEntitlementProofToken(userId, originalTransactionId, Date.now() - 10000);

    const res = await makeRequest(
      server,
      {
        method: 'POST',
        headers: {
          'X-Client-Device-Id': userId,
          Authorization: `Bearer ${expiredToken}`,
          'X-Apple-JWS': 'valid_storekit2_renewed_jws',
        },
      },
      {
        signedTransaction: 'valid_storekit2_renewed_jws',
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.tier, 'pro');
    assert.equal(res.body.status, 'active');
    assert.equal(res.body.productId, 'exampro_annual');
    assert.ok(res.body.proofToken);
    assert.notEqual(res.body.proofToken, expiredToken); // 成功簽發全新 Token
  });

  await t.test('5. 偽造與無憑證防冒充：僅宣告 X-Client-Device-Id 但無 Token/JWS，僅回傳 Free 方案', async () => {
    const victimUserId = 'dev_victim_user_04';
    const originalTransactionId = 'orig_tx_victim_4001';

    // 受害人在 Redis 中具有有效 Pro 權益
    await saveVerifiedEntitlement(victimUserId, {
      isValid: true,
      tier: 'pro',
      status: 'active',
      productId: 'exampro_monthly',
      transactionId: 'tx_4001',
      originalTransactionId,
      expiresDate: Date.now() + 10 * 86400 * 1000,
      environment: 'Sandbox',
      bundleId: EXPECTED_BUNDLE_ID,
    });

    // 攻擊者僅宣告相同的 Device ID，未附帶任何簽名憑證
    const res = await makeRequest(
      server,
      {
        method: 'POST',
        headers: {
          'X-Client-Device-Id': victimUserId,
        },
      },
      {},
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.tier, 'free');
    assert.equal(res.body.status, 'none');
    assert.equal(res.body.isVerified, false);
    assert.equal(res.body.originalTransactionId, undefined); // 絕不洩漏他人交易 ID
  });

  await t.test('6. 拒絕未經授權之單獨 originalTransactionId 查詢', async () => {
    const res = await makeRequest(
      server,
      {
        method: 'POST',
        headers: {
          'X-Client-Device-Id': 'attacker_random_device',
          'X-Original-Transaction-Id': '1000000000000000',
        },
      },
      { originalTransactionId: '1000000000000000' },
    );

    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'UNAUTHORIZED_TRANSACTION_QUERY');
    assert.equal(res.body.tier, 'free');
  });

  await t.test('7. 跨用戶交易探測防禦：持 User A 的有效 Token 企圖指定查詢 User B 的交易被 403 拒絕', async () => {
    const userA = 'dev_user_A';
    const txA = 'orig_tx_user_A';
    const txB = 'orig_tx_user_B';

    await saveVerifiedEntitlement(userA, {
      isValid: true,
      tier: 'pro',
      status: 'active',
      productId: 'exampro_monthly',
      transactionId: 'tx_A',
      originalTransactionId: txA,
      expiresDate: Date.now() + 5 * 86400 * 1000,
      environment: 'Sandbox',
      bundleId: EXPECTED_BUNDLE_ID,
    });

    const tokenA = generateEntitlementProofToken(userA, txA, Date.now() + 5 * 86400 * 1000);

    const res = await makeRequest(
      server,
      {
        method: 'POST',
        headers: {
          'X-Client-Device-Id': userA,
          Authorization: `Bearer ${tokenA}`,
          'X-Original-Transaction-Id': txB, // 惡意帶入非本人的交易 B
        },
      },
      { originalTransactionId: txB },
    );

    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'FORBIDDEN_TRANSACTION');
  });

  await t.test('8. 多交易裝置隔離：撤銷一筆月訂閱後，該裝置之 Lifetime 權益依然穩固存在', async () => {
    const userId = 'dev_multi_tx_user_05';
    const lifeTx = 'orig_multi_life_5001';
    const monthlyTx = 'orig_multi_month_5002';

    // 先購買 Lifetime
    await saveVerifiedEntitlement(userId, {
      isValid: true,
      tier: 'lifetime',
      status: 'active',
      productId: 'exampro_lifetime',
      transactionId: 'tx_life',
      originalTransactionId: lifeTx,
      environment: 'Sandbox',
      bundleId: EXPECTED_BUNDLE_ID,
    });

    // 後購買月訂閱
    await saveVerifiedEntitlement(userId, {
      isValid: true,
      tier: 'pro',
      status: 'active',
      productId: 'exampro_monthly',
      transactionId: 'tx_month',
      originalTransactionId: monthlyTx,
      expiresDate: Date.now() + 10 * 86400 * 1000,
      environment: 'Sandbox',
      bundleId: EXPECTED_BUNDLE_ID,
    });

    // 撤銷月訂閱
    await saveVerifiedEntitlement(userId, {
      isValid: true,
      tier: 'pro',
      status: 'revoked',
      productId: 'exampro_monthly',
      transactionId: 'tx_month_rev',
      originalTransactionId: monthlyTx,
      revocationDate: Date.now(),
      environment: 'Sandbox',
      bundleId: EXPECTED_BUNDLE_ID,
    });

    // 產生 Lifetime 的 Proof Token 查詢
    const lifeToken = generateEntitlementProofToken(userId, lifeTx, null);

    const res = await makeRequest(
      server,
      {
        method: 'POST',
        headers: {
          'X-Client-Device-Id': userId,
          Authorization: `Bearer ${lifeToken}`,
        },
      },
      { deviceId: userId },
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.tier, 'lifetime');
    assert.equal(res.body.status, 'active');
  });

  await t.test('9. 速率限制 (Rate Limit)：每分鐘超過 30 次請求回傳 429 RATE_LIMIT_EXCEEDED', async () => {
    const spammerId = 'dev_spammer_user_06';

    // 連續發送 30 次正常請求
    for (let i = 0; i < 30; i++) {
      const r = await makeRequest(
        server,
        {
          method: 'POST',
          headers: {
            'X-Client-Device-Id': spammerId,
          },
        },
        {},
      );
      assert.equal(r.status, 200);
    }

    // 第 31 次請求應被 Rate Limit 攔截
    const blockedRes = await makeRequest(
      server,
      {
        method: 'POST',
        headers: {
          'X-Client-Device-Id': spammerId,
        },
      },
      {},
    );

    assert.equal(blockedRes.status, 429);
    assert.equal(blockedRes.body.code, 'RATE_LIMIT_EXCEEDED');
  });

  await t.test('10. Redis OCC 原子防覆蓋：慢速/過期工作絕不能覆蓋較新之 Apple 交易記錄', async () => {
    const originalTransactionId = 'orig_tx_occ_test_7001';
    const now = Date.now();

    // 先寫入一筆時間戳記為 now + 10000 的最新記錄
    await applySubscriptionStateToRedis({
      originalTransactionId,
      transition: {
        actionable: true,
        action: 'UPDATE_ACTIVE',
        status: 'active',
        tier: 'pro',
        effectiveExpiresDate: now + 30 * 86400 * 1000,
        reason: '初始有效記錄',
      },
      now: now + 10000,
      isDryRun: false,
    });

    const recordAfterFirstWrite = await getOriginalTransactionEntitlement(originalTransactionId);
    assert.ok(recordAfterFirstWrite);
    assert.equal(recordAfterFirstWrite.status, 'active');

    // 模擬並行或延遲到達之過期事件 (時間戳記較舊，例如 now - 5000) 企圖寫入 expired
    const staleResult = await applySubscriptionStateToRedis({
      originalTransactionId,
      transition: {
        actionable: true,
        action: 'APPLY_EXPIRED',
        status: 'expired',
        tier: 'free',
        effectiveExpiresDate: now - 5000,
        reason: '過期舊通知',
      },
      now: now - 5000,
      isDryRun: false,
    });

    assert.equal(staleResult.action, 'IGNORE_STALE_RECORD');

    // 檢查 Redis 中的主記錄：狀態依然為 active，未被過期請求覆蓋！
    const finalRecord = await getOriginalTransactionEntitlement(originalTransactionId);
    assert.equal(finalRecord.status, 'active');
    assert.equal(finalRecord.tier, 'pro');
  });

  await t.test('11. 已退款 Lifetime 舊 JWS 重放防禦：Redis 已記錄為 revoked 時，舊 active JWS 絕不能重新開通', async () => {
    const userId = 'dev_revoked_lifetime_user';
    const originalTransactionId = 'orig_refunded_lifetime_8001';

    // 1. Redis 主記錄已被標記為 revoked
    await saveVerifiedEntitlement(userId, {
      isValid: true,
      tier: 'lifetime',
      status: 'revoked',
      productId: 'exampro_lifetime',
      transactionId: 'tx_refunded',
      originalTransactionId,
      revocationDate: Date.now() - 86400 * 1000,
      environment: 'Sandbox',
      bundleId: EXPECTED_BUNDLE_ID,
    });

    // 2. 模擬攻擊者提交當初購買時收到的舊 active JWS
    setCustomTransactionVerifier({
      async verify(jws) {
        if (jws === 'stale_active_lifetime_jws') {
          return {
            isValid: true,
            tier: 'lifetime',
            status: 'active',
            productId: 'exampro_lifetime',
            transactionId: 'tx_original_purchase',
            originalTransactionId,
            purchaseDate: Date.now() - 30 * 86400 * 1000,
            environment: 'Sandbox',
            bundleId: EXPECTED_BUNDLE_ID,
          };
        }
        return { isValid: false, errorMessage: '無效簽章' };
      },
    });

    const res = await makeRequest(
      server,
      {
        method: 'POST',
        headers: {
          'X-Client-Device-Id': userId,
          'X-Apple-JWS': 'stale_active_lifetime_jws',
        },
      },
      {
        signedTransaction: 'stale_active_lifetime_jws',
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.tier, 'free');
    assert.equal(res.body.status, 'revoked');
    assert.equal(res.body.isVerified, false);
    assert.equal(res.body.proofToken, undefined); // 絕不簽發有效 Proof Token
  });

  await t.test('12. Redis 無主記錄時提交歷史 JWS：Apple Server API 確認已撤銷時正確阻斷', async () => {
    const userId = 'dev_no_record_user';
    const originalTransactionId = 'orig_unknown_server_check_9001';

    // 模擬 Apple Server API 查出該交易已被 Apple 撤銷 (status 5)
    const { setCustomAppleServerApiClient } = require('../dist/lib/appleServerApi.js');
    const { setCustomAppleNotificationVerifier } = require('../dist/lib/appleWebhookHandler.js');

    setCustomAppleServerApiClient({
      isConfigured: () => true,
      getStatus: () => ({ isConfigured: true, environment: 'sandbox', bundleId: EXPECTED_BUNDLE_ID }),
      getAllSubscriptionStatuses: async () => ({
        data: [
          {
            subscriptionGroupIdentifier: 'grp_01',
            lastTransactions: [
              {
                status: 5, // REVOKED
                originalTransactionId,
                signedTransactionInfo: 'mock_signed_revoked_info',
              },
            ],
          },
        ],
      }),
      getTransactionInfo: async () => ({
        signedTransactionInfo: 'mock_signed_revoked_info',
      }),
    });

    setCustomAppleNotificationVerifier({
      verifyAndDecodeTransaction: async () => ({
        originalTransactionId,
        transactionId: 'tx_rev_apple',
        productId: 'exampro_monthly',
        revocationDate: Date.now() - 5000,
        bundleId: EXPECTED_BUNDLE_ID,
        environment: 'Sandbox',
      }),
      verifyAndDecodeRenewalInfo: async () => ({}),
      verifyAndDecodeNotificationPayload: async () => ({}),
    });

    setCustomTransactionVerifier({
      async verify() {
        return {
          isValid: true,
          tier: 'pro',
          status: 'active',
          productId: 'exampro_monthly',
          transactionId: 'tx_old_active',
          originalTransactionId,
          expiresDate: Date.now() + 86400 * 1000,
          environment: 'Sandbox',
          bundleId: EXPECTED_BUNDLE_ID,
        };
      },
    });

    const res = await makeRequest(
      server,
      {
        method: 'POST',
        headers: {
          'X-Client-Device-Id': userId,
          'X-Apple-JWS': 'mock_client_presented_jws',
        },
      },
      {
        signedTransaction: 'mock_client_presented_jws',
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.tier, 'free');
    assert.equal(res.body.status, 'revoked');
    assert.equal(res.body.isVerified, false);

    // 清理自訂 Server API 與 Verifier 注入
    setCustomAppleServerApiClient(null);
    setCustomAppleNotificationVerifier(null);
  });

  await t.test('13. Proof Token 過期且攜帶偽造/損毀 JWS：被 400 拒絕且維持 isVerified: false', async () => {
    const userId = 'dev_forged_jws_user';
    const expiredToken = generateEntitlementProofToken(userId, 'orig_fake_tx', Date.now() - 10000);

    setCustomTransactionVerifier({
      async verify() {
        return {
          isValid: false,
          status: 'invalid',
          tier: 'free',
          errorMessage: '數位簽章驗證失敗 (憑證損毀)',
        };
      },
    });

    const res = await makeRequest(
      server,
      {
        method: 'POST',
        headers: {
          'X-Client-Device-Id': userId,
          Authorization: `Bearer ${expiredToken}`,
          'X-Apple-JWS': 'forged_fake_jws_content',
        },
      },
      {
        signedTransaction: 'forged_fake_jws_content',
      },
    );

    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INVALID_TRANSACTION');
    assert.equal(res.body.isVerified, false);
    assert.equal(res.body.tier, 'free');
  });

  await t.test('14. Redis 裝置快取遺失或部分寫入失敗：getUserEntitlement 自動自我聚合修復', async () => {
    const userId = 'dev_cache_failure_user';
    const originalTransactionId = 'orig_tx_auto_heal';

    // 建立交易主記錄與用戶關聯集合
    await saveVerifiedEntitlement(userId, {
      isValid: true,
      tier: 'lifetime',
      status: 'active',
      productId: 'exampro_lifetime',
      transactionId: 'tx_heal',
      originalTransactionId,
      environment: 'Sandbox',
      bundleId: EXPECTED_BUNDLE_ID,
    });

    // 刻意手動刪除使用者即時快取 (模擬快取寫入部分失敗或 Redis 記憶體回收)
    const redis = require('../dist/lib/redis.js').getRedisClient();
    await redis.del(`exam_ai:user:${userId}:entitlement`);

    // 驗證快取已被清除
    const cachedBefore = await redis.get(`exam_ai:user:${userId}:entitlement`);
    assert.equal(cachedBefore, null);

    // 呼叫 getUserEntitlement 查詢
    const { getUserEntitlement } = require('../dist/lib/entitlement.js');
    const healed = await getUserEntitlement(userId);

    assert.equal(healed.tier, 'lifetime');
    assert.equal(healed.status, 'active');
    assert.equal(healed.isVerified, true);

    // 確認使用者快取已自動被自我修復寫回！
    const cachedAfter = await redis.get(`exam_ai:user:${userId}:entitlement`);
    assert.ok(cachedAfter);
    assert.equal(cachedAfter.tier, 'lifetime');
  });

  await t.test('15. Lifetime 購買後 Proof Token 過期不影響終身權益：查詢時自動續簽全新 Token', async () => {
    const userId = 'dev_lifetime_token_expiry_user';
    const originalTransactionId = 'orig_tx_lifetime_perm_001';

    // 建立永久 Lifetime 主記錄與裝置關聯
    await saveVerifiedEntitlement(userId, {
      isValid: true,
      tier: 'lifetime',
      status: 'active',
      productId: 'exampro_lifetime',
      transactionId: 'tx_perm_001',
      originalTransactionId,
      environment: 'Sandbox',
      bundleId: EXPECTED_BUNDLE_ID,
    });

    // 1. 驗證 Redis 中的裝置會員資格永久有效 (不隨 Token 到期失效)
    const { getUserEntitlement } = require('../dist/lib/entitlement.js');
    const entitlement = await getUserEntitlement(userId);
    assert.equal(entitlement.tier, 'lifetime');
    assert.equal(entitlement.status, 'active');
    assert.equal(entitlement.isVerified, true);

    // 2. 簽發一個過期的 Proof Token (模擬 8 天後過期)
    const expiredToken = generateEntitlementProofToken(userId, originalTransactionId, Date.now() - 86400 * 1000);
    const tokenCheck = await verifyEntitlementProofToken(expiredToken, userId);
    assert.equal(tokenCheck.valid, false);
    assert.match(tokenCheck.reason, /逾期/);

    // 3. 用戶端 StoreKit 2 於 Token 過期時自動攜帶本機 JWS 向伺服端換發新 Token
    setCustomTransactionVerifier({
      async verify(jws) {
        if (jws === 'valid_storekit2_lifetime_jws') {
          return {
            isValid: true,
            tier: 'lifetime',
            status: 'active',
            productId: 'exampro_lifetime',
            transactionId: 'tx_perm_001',
            originalTransactionId,
            purchaseDate: Date.now() - 365 * 86400 * 1000,
            environment: 'Sandbox',
            bundleId: EXPECTED_BUNDLE_ID,
          };
        }
        return { isValid: false, errorMessage: '無效簽署' };
      },
    });

    const res = await makeRequest(
      server,
      {
        method: 'POST',
        headers: {
          'X-Client-Device-Id': userId,
          Authorization: `Bearer ${expiredToken}`,
          'X-Apple-JWS': 'valid_storekit2_lifetime_jws',
        },
      },
      {
        signedTransaction: 'valid_storekit2_lifetime_jws',
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.tier, 'lifetime');
    assert.equal(res.body.status, 'active');
    assert.equal(res.body.isVerified, true);
    assert.ok(res.body.proofToken);
    assert.notEqual(res.body.proofToken, expiredToken);

    // 驗證新換發的 Token 有效性
    const newTokenCheck = await verifyEntitlementProofToken(res.body.proofToken, userId);
    assert.equal(newTokenCheck.valid, true);
    assert.equal(newTokenCheck.originalTransactionId, originalTransactionId);
  });

  await t.test('16. Lifetime 退款/撤銷後：舊 Proof Token 絕不能繼續授予 Lifetime 權限', async () => {
    const userId = 'dev_lifetime_revoked_token_user';
    const originalTransactionId = 'orig_tx_lifetime_revoked_002';

    // 先建立正常 Lifetime 並取得有效 Proof Token
    await saveVerifiedEntitlement(userId, {
      isValid: true,
      tier: 'lifetime',
      status: 'active',
      productId: 'exampro_lifetime',
      transactionId: 'tx_perm_002',
      originalTransactionId,
      environment: 'Sandbox',
      bundleId: EXPECTED_BUNDLE_ID,
    });

    const activeProofToken = generateEntitlementProofToken(userId, originalTransactionId, Date.now() + 5 * 86400 * 1000);
    const beforeCheck = await verifyEntitlementProofToken(activeProofToken, userId);
    assert.equal(beforeCheck.valid, true);

    // 隨後 Apple 執行退款，將交易主記錄標記為 revoked
    await saveVerifiedEntitlement(userId, {
      isValid: true,
      tier: 'lifetime',
      status: 'revoked',
      productId: 'exampro_lifetime',
      transactionId: 'tx_revoked_002',
      originalTransactionId,
      revocationDate: Date.now(),
      environment: 'Sandbox',
      bundleId: EXPECTED_BUNDLE_ID,
    });

    // 驗證舊 Proof Token 是否被即時阻斷
    const afterCheck = await verifyEntitlementProofToken(activeProofToken, userId);
    assert.equal(afterCheck.valid, false);
    assert.match(afterCheck.reason, /退款或撤銷/);

    // 嘗試持舊 Token 發送 API 請求
    const res = await makeRequest(
      server,
      {
        method: 'POST',
        headers: {
          'X-Client-Device-Id': userId,
          Authorization: `Bearer ${activeProofToken}`,
        },
      },
      {},
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.tier, 'free');
    assert.equal(res.body.isVerified, false);
    assert.equal(res.body.proofToken, undefined); // 絕不簽發新 Token
  });

  await t.test('17. 裝置快取未更新殘留 active 但主記錄已退款時：getUserEntitlement 主動清除殘留快取並降級', async () => {
    const userId = 'dev_stale_cache_victim_003';
    const originalTransactionId = 'orig_tx_stale_cache_003';
    const redis = require('../dist/lib/redis.js').getRedisClient();

    // 1. 刻意寫入一個狀態為 active 的殘留裝置快取 (模擬快取更新遺失之極端異常情況)
    await redis.set(`exam_ai:user:${userId}:entitlement`, {
      userId,
      tier: 'lifetime',
      productId: 'exampro_lifetime',
      originalTransactionId,
      verifiedAt: Date.now(),
      environment: 'Sandbox',
    });

    // 2. 但交易主記錄已被 Apple 標記為 revoked
    await redis.set(`exam_ai:apple:entitlement:${originalTransactionId}`, {
      originalTransactionId,
      lastTransactionId: 'tx_stale_revoked',
      productId: 'exampro_lifetime',
      tier: 'lifetime',
      status: 'revoked',
      purchaseDate: Date.now() - 100000,
      revocationDate: Date.now(),
      verifiedAt: Date.now(),
      environment: 'Sandbox',
    });

    // 3. 呼叫 getUserEntitlement
    const { getUserEntitlement } = require('../dist/lib/entitlement.js');
    const entitlement = await getUserEntitlement(userId);

    // 驗證：及時偵測到主記錄為 revoked，強制降級為 Free，isVerified 必須為 false！
    assert.equal(entitlement.tier, 'free');
    assert.equal(entitlement.status, 'revoked');
    assert.equal(entitlement.isVerified, false);

    // 驗證殘留的裝置快取已在查詢過程中被安全清除
    const cleanedCache = await redis.get(`exam_ai:user:${userId}:entitlement`);
    assert.equal(cleanedCache, null);
  });
});

