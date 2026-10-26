/**
 * 考試計畫 AI - Phase 3.4b: Apple Webhook Live Mode 本機端到端整合驗收測試
 *
 * 【測試邊界與 Mock 聲明】：
 * 1. 本檔案專注於驗證「端到端業務流轉管線」：
 *    模擬通知進入 -> HTTP 路由 -> 冪等鎖狀態機 -> 狀態流轉引擎 -> Redis OCC 原子寫入 -> 多裝置權益重算 -> 最終 HTTP 回應。
 * 2. 關於 Apple JWS 簽名驗證邊界：
 *    - 本測試使用 Mock Verifier 模擬解碼後的各類極端 Apple 通知物件。
 *    - 【重要邊界限制】：本機 Mock 測試「無法且不可」取代真實 Apple 官方 Root CA 密碼學憑證鏈檢驗。
 *    - 真實 Apple Root CA 簽章驗證已於 Phase 3.3c/d 透過官方真實 Sandbox TEST Notification 驗證通過
 *      (Apple 官方回傳 sendAttemptResult=SUCCESS，Webhook 成功驗簽並回傳 200)。
 * 3. 測試環境隔離保證：
 *    - 強制啟用 MOCK_REDIS='true'，所有資料讀寫嚴格侷限於 InMemoryRedisMock，絕不接觸任何遠端真實 Redis。
 *    - 移除所有真實 Apple API Private Key，絕不對外發送真實網路請求。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// 1. 設定測試環境變數（嚴格限制僅在本地 Mock 環境，絕不連線外部真實服務）
process.env.MOCK_REDIS = 'true';
process.env.OPENAI_API_KEY = 'test_mock_key';
process.env.APP_SERVER_SECRET = 'test_signing_secret_for_tests';
process.env.APPLE_IAP_ENVIRONMENT = 'sandbox';
process.env.APPLE_ALLOW_SANDBOX = 'true';
process.env.APPLE_WEBHOOK_DRY_RUN = 'false'; // 關鍵：測試 Live 寫入模式！

delete process.env.APPLE_API_PRIVATE_KEY;
delete process.env.APPLE_API_KEY_ID;
delete process.env.APPLE_API_ISSUER_ID;

const webhookApiModule = require('../dist/api/apple-webhook.js');
const {
  setCustomNotificationVerifier,
  getAppleNotificationVerifier,
} = require('../dist/lib/appleWebhookHandler.js');
const {
  reconcileSubscriptionWithApple,
  applySubscriptionStateToRedis,
} = require('../dist/lib/appleSubscriptionSync.js');
const {
  inMemoryRedisMockInstance,
} = require('../dist/lib/redis.js');
const {
  setCustomAppleServerApiClient,
} = require('../dist/lib/appleServerApi.js');
const {
  syncUserDeviceEffectiveEntitlement,
  getUserEntitlement,
} = require('../dist/lib/entitlement.js');
const {
  EXPECTED_BUNDLE_ID,
  EXPECTED_APP_APPLE_ID,
} = require('../dist/lib/appleIap.js');

const webhookHandler = typeof webhookApiModule === 'function' ? webhookApiModule : webhookApiModule.default;

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
      if (req.url && req.url.startsWith('/api/apple-webhook')) {
        await webhookHandler(req, res);
      } else {
        res.status(404).json({ error: 'Not Found' });
      }
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err?.message || 'Server error' }));
      }
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((cb) => server.close(cb)),
      });
    });
  });
}

async function postWebhook(baseUrl, body, headers = {}) {
  const res = await fetch(`${baseUrl}/api/apple-webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, headers: res.headers, data };
}

test('Phase 3.4b: Apple Webhook Live Mode 本機端到端整合驗收 (15 組情境完整驗證)', async (t) => {
  let testServerObj;
  let baseUrl;
  let currentMockNotification = null;
  let baseNow = Date.now();

  t.before(async () => {
    testServerObj = await createTestServer();
    baseUrl = testServerObj.baseUrl;

    // 注入可控 Mock Verifier，供端到端 HTTP Webhook 流程驗證
    setCustomNotificationVerifier({
      verifyAndDecode: async (signedPayload) => {
        if (currentMockNotification) {
          return currentMockNotification;
        }
        return {
          isValid: true,
          notificationType: 'TEST',
          notificationUUID: 'default_test_uuid',
          signedDate: baseNow,
        };
      },
      verifyAndDecodeTransaction: async (signedTx) => {
        return typeof signedTx === 'object' ? signedTx : JSON.parse(signedTx);
      },
      verifyAndDecodeRenewalInfo: async (signedRenewal) => {
        return typeof signedRenewal === 'object' ? signedRenewal : JSON.parse(signedRenewal);
      },
    });
  });

  t.after(async () => {
    if (testServerObj) {
      await testServerObj.close();
    }
    setCustomNotificationVerifier(null);
  });

  t.beforeEach(() => {
    inMemoryRedisMockInstance.clear();
    setCustomAppleServerApiClient(null);
    currentMockNotification = null;
    process.env.APPLE_WEBHOOK_DRY_RUN = 'false';
    baseNow = Date.now();
  });

  // ───── 情境 1: 初始購買 Pro -> 設備獲得 Pro 權益 ─────
  await t.test('1. 初始購買 Pro (INITIAL_BUY)：端到端驗證設備取得 Pro 權益與主記錄寫入', async () => {
    const origTxId = 'orig_sub_e2e_001';
    const deviceId = 'dev_user_e2e_001';
    const expiresDate = baseNow + 30 * 86400 * 1000;

    // 預先註冊設備與交易關聯 (模擬 App 結帳時綁定)
    await inMemoryRedisMockInstance.zadd(`exam_ai:apple:devices_z:${origTxId}`, { score: baseNow, member: deviceId });
    await inMemoryRedisMockInstance.sadd(`exam_ai:user:${deviceId}:apple_txns`, origTxId);

    currentMockNotification = {
      isValid: true,
      notificationType: 'SUBSCRIBED',
      subtype: 'INITIAL_BUY',
      notificationUUID: 'uuid_e2e_init_buy_001',
      signedDate: baseNow,
      originalTransactionId: origTxId,
      transactionId: 'tx_e2e_001',
      productId: 'exampro_monthly',
      purchaseDate: baseNow,
      originalPurchaseDate: baseNow,
      expiresDate,
      environment: 'Sandbox',
      bundleId: EXPECTED_BUNDLE_ID,
      transaction: {
        originalTransactionId: origTxId,
        transactionId: 'tx_e2e_001',
        productId: 'exampro_monthly',
        purchaseDate: baseNow,
        expiresDate,
        signedDate: baseNow,
        environment: 'Sandbox',
      },
    };

    const res = await postWebhook(baseUrl, { signedPayload: 'payload_e2e_1' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.action, 'APPLY_ACTIVE');

    // 驗證 Redis 主記錄
    const mainRecord = await inMemoryRedisMockInstance.get(`exam_ai:apple:entitlement:${origTxId}`);
    assert.ok(mainRecord);
    assert.strictEqual(mainRecord.status, 'active');
    assert.strictEqual(mainRecord.tier, 'pro');
    assert.strictEqual(mainRecord.productId, 'exampro_monthly');
    assert.strictEqual(mainRecord.expiresDate, expiresDate);
    assert.strictEqual(mainRecord.lastAppleSignedDate, baseNow);

    // 驗證設備即時快取
    const devCache = await inMemoryRedisMockInstance.get(`exam_ai:user:${deviceId}:entitlement`);
    assert.ok(devCache);
    assert.strictEqual(devCache.tier, 'pro');
    assert.strictEqual(devCache.originalTransactionId, origTxId);
    assert.strictEqual(devCache.expiresAt, expiresDate);
  });

  // ───── 情境 2: 續訂成功 (DID_RENEW) -> 到期日正確展延 ─────
  await t.test('2. 續訂成功 (DID_RENEW)：端到端驗證到期日正確展延且設備快取同步更新', async () => {
    const origTxId = 'orig_sub_e2e_002';
    const deviceId = 'dev_user_e2e_002';
    const oldExpiry = baseNow + 2 * 86400 * 1000;
    const newExpiry = baseNow + 32 * 86400 * 1000;
    const renewSignedDate = baseNow + 2 * 86400 * 1000;

    // 預先寫入既有即將到期之記錄
    await inMemoryRedisMockInstance.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      lastTransactionId: 'tx_old_002',
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      purchaseDate: baseNow - 28 * 86400 * 1000,
      expiresDate: oldExpiry,
      verifiedAt: baseNow - 28 * 86400 * 1000,
      lastAppleSignedDate: baseNow - 28 * 86400 * 1000,
      environment: 'Sandbox',
      willRenew: true,
    });
    await inMemoryRedisMockInstance.zadd(`exam_ai:apple:devices_z:${origTxId}`, { score: baseNow, member: deviceId });
    await inMemoryRedisMockInstance.sadd(`exam_ai:user:${deviceId}:apple_txns`, origTxId);
    await syncUserDeviceEffectiveEntitlement(deviceId, origTxId);

    // Apple 發送 DID_RENEW
    currentMockNotification = {
      isValid: true,
      notificationType: 'DID_RENEW',
      notificationUUID: 'uuid_e2e_renew_002',
      signedDate: renewSignedDate,
      originalTransactionId: origTxId,
      transactionId: 'tx_renewed_002',
      productId: 'exampro_monthly',
      purchaseDate: renewSignedDate,
      expiresDate: newExpiry,
      environment: 'Sandbox',
      bundleId: EXPECTED_BUNDLE_ID,
      transaction: {
        originalTransactionId: origTxId,
        transactionId: 'tx_renewed_002',
        productId: 'exampro_monthly',
        purchaseDate: renewSignedDate,
        expiresDate: newExpiry,
        signedDate: renewSignedDate,
        environment: 'Sandbox',
      },
    };

    const res = await postWebhook(baseUrl, { signedPayload: 'payload_e2e_2' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.action, 'APPLY_RENEWAL');

    const mainRecord = await inMemoryRedisMockInstance.get(`exam_ai:apple:entitlement:${origTxId}`);
    assert.strictEqual(mainRecord.expiresDate, newExpiry);
    assert.strictEqual(mainRecord.lastAppleSignedDate, renewSignedDate);

    const devCache = await inMemoryRedisMockInstance.get(`exam_ai:user:${deviceId}:entitlement`);
    assert.strictEqual(devCache.expiresAt, newExpiry);
  });

  // ───── 情境 3: 取消自動續訂 (AUTO_RENEW_DISABLED) -> 維持 Pro 直到到期日 ─────
  await t.test('3. 取消自動續訂 (AUTO_RENEW_DISABLED)：維持 Pro 會員資格直到到期日，不提前收回', async () => {
    const origTxId = 'orig_sub_e2e_003';
    const deviceId = 'dev_user_e2e_003';
    const futureExpiry = baseNow + 20 * 86400 * 1000;

    await inMemoryRedisMockInstance.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      lastTransactionId: 'tx_sub_003',
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      purchaseDate: baseNow - 10 * 86400 * 1000,
      expiresDate: futureExpiry,
      verifiedAt: baseNow - 10 * 86400 * 1000,
      lastAppleSignedDate: baseNow - 10 * 86400 * 1000,
      environment: 'Sandbox',
      willRenew: true,
    });
    await inMemoryRedisMockInstance.zadd(`exam_ai:apple:devices_z:${origTxId}`, { score: baseNow, member: deviceId });
    await inMemoryRedisMockInstance.sadd(`exam_ai:user:${deviceId}:apple_txns`, origTxId);
    await syncUserDeviceEffectiveEntitlement(deviceId, origTxId);

    currentMockNotification = {
      isValid: true,
      notificationType: 'DID_CHANGE_RENEWAL_STATUS',
      subtype: 'AUTO_RENEW_DISABLED',
      notificationUUID: 'uuid_e2e_cancel_renew_003',
      signedDate: baseNow + 1000,
      originalTransactionId: origTxId,
      productId: 'exampro_monthly',
      expiresDate: futureExpiry,
      renewalInfo: {
        autoRenewStatus: 0,
      },
    };

    const res = await postWebhook(baseUrl, { signedPayload: 'payload_e2e_3' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.action, 'UPDATE_RENEWAL_INFO');

    // 驗證：Pro 權益依然穩固存在且未過期
    const mainRecord = await inMemoryRedisMockInstance.get(`exam_ai:apple:entitlement:${origTxId}`);
    assert.strictEqual(mainRecord.status, 'active');
    assert.strictEqual(mainRecord.tier, 'pro');
    assert.strictEqual(mainRecord.expiresDate, futureExpiry);

    const devCache = await inMemoryRedisMockInstance.get(`exam_ai:user:${deviceId}:entitlement`);
    assert.ok(devCache);
    assert.strictEqual(devCache.tier, 'pro');
  });

  // ───── 情境 4: 扣款失敗 (DID_FAIL_TO_RENEW) 進入 Billing Retry 與 Grace Period ─────
  await t.test('4. 扣款失敗 (DID_FAIL_TO_RENEW)：正確處理寬限期 (Grace Period) 與帳單重試期，維持 Pro 權益', async () => {
    // 4A: 寬限期 Grace Period
    const origGraceTx = 'orig_sub_e2e_004_grace';
    const devGrace = 'dev_user_e2e_004_grace';
    const graceExpiry = baseNow + 16 * 86400 * 1000;

    await inMemoryRedisMockInstance.set(`exam_ai:apple:entitlement:${origGraceTx}`, {
      originalTransactionId: origGraceTx,
      lastTransactionId: 'tx_grace_prev',
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      purchaseDate: baseNow - 30 * 86400 * 1000,
      expiresDate: baseNow,
      verifiedAt: baseNow,
      lastAppleSignedDate: baseNow,
      environment: 'Sandbox',
      willRenew: true,
    });
    await inMemoryRedisMockInstance.zadd(`exam_ai:apple:devices_z:${origGraceTx}`, { score: baseNow, member: devGrace });
    await inMemoryRedisMockInstance.sadd(`exam_ai:user:${devGrace}:apple_txns`, origGraceTx);

    currentMockNotification = {
      isValid: true,
      notificationType: 'DID_FAIL_TO_RENEW',
      subtype: 'GRACE_PERIOD',
      notificationUUID: 'uuid_grace_004',
      signedDate: baseNow + 500,
      originalTransactionId: origGraceTx,
      productId: 'exampro_monthly',
      expiresDate: graceExpiry,
      renewalInfo: {
        autoRenewStatus: 1,
        gracePeriodExpiresDate: graceExpiry,
      },
      rawPayload: {
        data: {
          status: 4, // in grace period
        },
      },
    };

    const resGrace = await postWebhook(baseUrl, { signedPayload: 'payload_grace_4a' });
    assert.strictEqual(resGrace.status, 200);
    assert.strictEqual(resGrace.data.action, 'UPDATE_RENEWAL_INFO');

    const devGraceCache = await inMemoryRedisMockInstance.get(`exam_ai:user:${devGrace}:entitlement`);
    assert.ok(devGraceCache);
    assert.strictEqual(devGraceCache.tier, 'pro');

    // 4B: 一般帳單重試期（未過期）
    const origRetryTx = 'orig_sub_e2e_004_retry';
    const devRetry = 'dev_user_e2e_004_retry';
    const retryExpiry = baseNow + 5 * 86400 * 1000;

    await inMemoryRedisMockInstance.set(`exam_ai:apple:entitlement:${origRetryTx}`, {
      originalTransactionId: origRetryTx,
      lastTransactionId: 'tx_retry_prev',
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      purchaseDate: baseNow - 25 * 86400 * 1000,
      expiresDate: retryExpiry,
      verifiedAt: baseNow - 25 * 86400 * 1000,
      lastAppleSignedDate: baseNow - 25 * 86400 * 1000,
      environment: 'Sandbox',
      willRenew: true,
    });
    await inMemoryRedisMockInstance.zadd(`exam_ai:apple:devices_z:${origRetryTx}`, { score: baseNow, member: devRetry });
    await inMemoryRedisMockInstance.sadd(`exam_ai:user:${devRetry}:apple_txns`, origRetryTx);

    currentMockNotification = {
      isValid: true,
      notificationType: 'DID_FAIL_TO_RENEW',
      subtype: 'BILLING_RETRY',
      notificationUUID: 'uuid_retry_004',
      signedDate: baseNow + 1000,
      originalTransactionId: origRetryTx,
      productId: 'exampro_monthly',
      expiresDate: retryExpiry,
      renewalInfo: {
        autoRenewStatus: 1,
      },
      rawPayload: {
        data: {
          status: 2,
        },
      },
    };

    const resRetry = await postWebhook(baseUrl, { signedPayload: 'payload_retry_4b' });
    assert.strictEqual(resRetry.status, 200);
    assert.strictEqual(resRetry.data.action, 'UPDATE_RENEWAL_INFO');

    const mainRetryRecord = await inMemoryRedisMockInstance.get(`exam_ai:apple:entitlement:${origRetryTx}`);
    assert.strictEqual(mainRetryRecord.status, 'active');
    assert.strictEqual(mainRetryRecord.tier, 'pro');
    assert.strictEqual(mainRetryRecord.willRenew, true);
  });

  // ───── 情境 5: 訂閱過期 (EXPIRED) -> 降級為 Free ─────
  await t.test('5. 訂閱過期 (EXPIRED)：端到端驗證降級為 Free 且安全清除使用者快取', async () => {
    const origTxId = 'orig_sub_e2e_005';
    const deviceId = 'dev_user_e2e_005';
    const expiredTime = baseNow - 1000;

    await inMemoryRedisMockInstance.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      lastTransactionId: 'tx_sub_005',
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      purchaseDate: baseNow - 30 * 86400 * 1000,
      expiresDate: expiredTime,
      verifiedAt: baseNow - 30 * 86400 * 1000,
      lastAppleSignedDate: baseNow - 30 * 86400 * 1000,
      environment: 'Sandbox',
    });
    await inMemoryRedisMockInstance.zadd(`exam_ai:apple:devices_z:${origTxId}`, { score: baseNow, member: deviceId });
    await inMemoryRedisMockInstance.sadd(`exam_ai:user:${deviceId}:apple_txns`, origTxId);
    await syncUserDeviceEffectiveEntitlement(deviceId, origTxId);

    currentMockNotification = {
      isValid: true,
      notificationType: 'EXPIRED',
      subtype: 'VOLUNTARY',
      notificationUUID: 'uuid_e2e_expired_005',
      signedDate: baseNow,
      originalTransactionId: origTxId,
      productId: 'exampro_monthly',
      expiresDate: expiredTime,
    };

    const res = await postWebhook(baseUrl, { signedPayload: 'payload_e2e_5' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.action, 'APPLY_EXPIRED');

    const mainRecord = await inMemoryRedisMockInstance.get(`exam_ai:apple:entitlement:${origTxId}`);
    assert.strictEqual(mainRecord.status, 'expired');
    assert.strictEqual(mainRecord.tier, 'pro');

    const devCache = await inMemoryRedisMockInstance.get(`exam_ai:user:${deviceId}:entitlement`);
    assert.strictEqual(devCache, null); // 快取已被清除，解析為 Free
  });

  // ───── 情境 6: 退款/撤銷 (REFUND / REVOKE) -> 交易被撤銷、設備快取清除 ─────
  await t.test('6. 退款/撤銷 (REVOKE)：端到端驗證交易標記 revoked 且設備權限立即被收回', async () => {
    const origTxId = 'orig_sub_e2e_006';
    const deviceId = 'dev_user_e2e_006';

    await inMemoryRedisMockInstance.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      lastTransactionId: 'tx_sub_006',
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      purchaseDate: baseNow - 5 * 86400 * 1000,
      expiresDate: baseNow + 25 * 86400 * 1000,
      verifiedAt: baseNow - 5 * 86400 * 1000,
      lastAppleSignedDate: baseNow - 5 * 86400 * 1000,
      environment: 'Sandbox',
    });
    await inMemoryRedisMockInstance.zadd(`exam_ai:apple:devices_z:${origTxId}`, { score: baseNow, member: deviceId });
    await inMemoryRedisMockInstance.sadd(`exam_ai:user:${deviceId}:apple_txns`, origTxId);
    await syncUserDeviceEffectiveEntitlement(deviceId, origTxId);

    currentMockNotification = {
      isValid: true,
      notificationType: 'REVOKE',
      notificationUUID: 'uuid_e2e_revoke_006',
      signedDate: baseNow,
      originalTransactionId: origTxId,
      productId: 'exampro_monthly',
      revocationDate: baseNow,
    };

    const res = await postWebhook(baseUrl, { signedPayload: 'payload_e2e_6' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.action, 'APPLY_REVOKED');

    const mainRecord = await inMemoryRedisMockInstance.get(`exam_ai:apple:entitlement:${origTxId}`);
    assert.strictEqual(mainRecord.status, 'revoked');
    assert.strictEqual(mainRecord.revocationDate, baseNow);

    const devCache = await inMemoryRedisMockInstance.get(`exam_ai:user:${deviceId}:entitlement`);
    assert.strictEqual(devCache, null);
  });

  // ───── 情境 7: 終身方案 (Lifetime) 與 Pro 並存 -> Pro 退款或過期不影響 Lifetime ─────
  await t.test('7. Lifetime 與 Pro 雙方案並存：Pro 退款撤銷時，使用者終身權限依然不受影響', async () => {
    const origLifetime = 'orig_lifetime_e2e_007';
    const origPro = 'orig_pro_e2e_007';
    const deviceId = 'dev_dual_owner_007';

    // 1. 寫入 Lifetime 交易
    await inMemoryRedisMockInstance.set(`exam_ai:apple:entitlement:${origLifetime}`, {
      originalTransactionId: origLifetime,
      lastTransactionId: 'tx_lifetime_007',
      productId: 'exampro_lifetime',
      tier: 'lifetime',
      status: 'active',
      purchaseDate: baseNow - 100 * 86400 * 1000,
      verifiedAt: baseNow - 100 * 86400 * 1000,
      lastAppleSignedDate: baseNow - 100 * 86400 * 1000,
      environment: 'Sandbox',
    });

    // 2. 寫入 Pro 訂閱交易
    await inMemoryRedisMockInstance.set(`exam_ai:apple:entitlement:${origPro}`, {
      originalTransactionId: origPro,
      lastTransactionId: 'tx_pro_007',
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      purchaseDate: baseNow - 5 * 86400 * 1000,
      expiresDate: baseNow + 25 * 86400 * 1000,
      verifiedAt: baseNow - 5 * 86400 * 1000,
      lastAppleSignedDate: baseNow - 5 * 86400 * 1000,
      environment: 'Sandbox',
    });

    // 設備綁定兩筆交易
    await inMemoryRedisMockInstance.zadd(`exam_ai:apple:devices_z:${origLifetime}`, { score: baseNow, member: deviceId });
    await inMemoryRedisMockInstance.zadd(`exam_ai:apple:devices_z:${origPro}`, { score: baseNow, member: deviceId });
    await inMemoryRedisMockInstance.sadd(`exam_ai:user:${deviceId}:apple_txns`, origLifetime, origPro);
    await syncUserDeviceEffectiveEntitlement(deviceId, origPro);

    // 3. Apple 發送 Pro 訂閱退款/撤銷通知
    currentMockNotification = {
      isValid: true,
      notificationType: 'REVOKE',
      notificationUUID: 'uuid_e2e_revoke_pro_007',
      signedDate: baseNow,
      originalTransactionId: origPro,
      productId: 'exampro_monthly',
      revocationDate: baseNow,
    };

    const res = await postWebhook(baseUrl, { signedPayload: 'payload_e2e_7' });
    assert.strictEqual(res.status, 200);

    // Pro 交易已被撤銷
    const proRecord = await inMemoryRedisMockInstance.get(`exam_ai:apple:entitlement:${origPro}`);
    assert.strictEqual(proRecord.status, 'revoked');

    // 關鍵驗證：設備的即時快取依然穩固維持為 Lifetime！
    const devCache = await inMemoryRedisMockInstance.get(`exam_ai:user:${deviceId}:entitlement`);
    assert.ok(devCache);
    assert.strictEqual(devCache.tier, 'lifetime');
    assert.strictEqual(devCache.originalTransactionId, origLifetime);
  });

  // ───── 情境 8: 過期通知或亂序抵達 (Stale JWS) -> 不覆蓋最新有效狀態 ─────
  await t.test('8. 亂序與過期舊通知抵達 (Stale JWS)：OCC 成功攔截，不覆蓋較新之有效續訂', async () => {
    const origTxId = 'orig_sub_e2e_008';
    const deviceId = 'dev_user_e2e_008';
    const latestSigned = baseNow;
    const latestExpiry = baseNow + 30 * 86400 * 1000;

    await inMemoryRedisMockInstance.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      lastTransactionId: 'tx_latest_008',
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      purchaseDate: latestSigned,
      expiresDate: latestExpiry,
      verifiedAt: latestSigned,
      lastAppleSignedDate: latestSigned,
      environment: 'Sandbox',
      willRenew: true,
    });
    await inMemoryRedisMockInstance.zadd(`exam_ai:apple:devices_z:${origTxId}`, { score: baseNow, member: deviceId });
    await inMemoryRedisMockInstance.sadd(`exam_ai:user:${deviceId}:apple_txns`, origTxId);
    await syncUserDeviceEffectiveEntitlement(deviceId, origTxId);

    // 模擬網路延遲抵達的舊 EXPIRED 通知 (signedDate 在最新續訂之前)
    currentMockNotification = {
      isValid: true,
      notificationType: 'EXPIRED',
      subtype: 'VOLUNTARY',
      notificationUUID: 'uuid_stale_expired_008',
      signedDate: baseNow - 50000,
      originalTransactionId: origTxId,
      productId: 'exampro_monthly',
      expiresDate: baseNow - 50000,
    };

    const res = await postWebhook(baseUrl, { signedPayload: 'payload_e2e_8' });
    assert.strictEqual(res.status, 200);

    // 驗證主記錄未被降級
    const mainRecord = await inMemoryRedisMockInstance.get(`exam_ai:apple:entitlement:${origTxId}`);
    assert.strictEqual(mainRecord.status, 'active');
    assert.strictEqual(mainRecord.expiresDate, latestExpiry);

    // 設備快取依然為有效 Pro
    const devCache = await inMemoryRedisMockInstance.get(`exam_ai:user:${deviceId}:entitlement`);
    assert.ok(devCache);
    assert.strictEqual(devCache.tier, 'pro');
  });

  // ───── 情境 9: 重複通知抵達 (notificationUUID 相同) -> 冪等性防護 ─────
  await t.test('9. 重複通知抵達 (Idempotency)：相同 notificationUUID 安全回傳 duplicate: true，不重複處理', async () => {
    const origTxId = 'orig_sub_e2e_009';
    const uuid = 'uuid_idempotent_e2e_009';

    currentMockNotification = {
      isValid: true,
      notificationType: 'DID_RENEW',
      notificationUUID: uuid,
      signedDate: baseNow,
      originalTransactionId: origTxId,
      productId: 'exampro_monthly',
      purchaseDate: baseNow,
      expiresDate: baseNow + 30 * 86400 * 1000,
    };

    // 第一次呼叫：正常處理
    const res1 = await postWebhook(baseUrl, { signedPayload: 'payload_idempotent_1' });
    assert.strictEqual(res1.status, 200);
    assert.strictEqual(res1.data.success, true);
    assert.strictEqual(res1.data.duplicate, undefined);

    // 第二次呼叫：相同 UUID 觸發冪等快取防護
    const res2 = await postWebhook(baseUrl, { signedPayload: 'payload_idempotent_2' });
    assert.strictEqual(res2.status, 200);
    assert.strictEqual(res2.data.success, true);
    assert.strictEqual(res2.data.duplicate, true);
    assert.strictEqual(res2.data.state, 'completed');
  });

  // ───── 情境 10: 多設備關聯時部分同步失敗 -> Webhook 返回 500，釋放鎖定，重試時自癒 ─────
  await t.test('10. 多設備同步暫態失敗與重試自癒：Webhook 返回 500 並釋放鎖定，Apple 重試時完全修復', async () => {
    const origTxId = 'orig_sub_e2e_010';
    const devA = 'dev_10_A';
    const devB = 'dev_10_B';
    const uuid = 'uuid_partial_fail_010';
    const newExpiry = baseNow + 30 * 86400 * 1000;

    await inMemoryRedisMockInstance.zadd(`exam_ai:apple:devices_z:${origTxId}`, { score: baseNow, member: devA });
    await inMemoryRedisMockInstance.zadd(`exam_ai:apple:devices_z:${origTxId}`, { score: baseNow + 1, member: devB });
    await inMemoryRedisMockInstance.sadd(`exam_ai:user:${devA}:apple_txns`, origTxId);
    await inMemoryRedisMockInstance.sadd(`exam_ai:user:${devB}:apple_txns`, origTxId);

    currentMockNotification = {
      isValid: true,
      notificationType: 'DID_RENEW',
      notificationUUID: uuid,
      signedDate: baseNow,
      originalTransactionId: origTxId,
      productId: 'exampro_monthly',
      purchaseDate: baseNow,
      expiresDate: newExpiry,
    };

    // 模擬第一次呼叫時，寫入 devB 快取發生暫時性例外
    const origSet = inMemoryRedisMockInstance.set.bind(inMemoryRedisMockInstance);
    const origDel = inMemoryRedisMockInstance.del.bind(inMemoryRedisMockInstance);
    let failTriggered = false;
    inMemoryRedisMockInstance.set = async function (key, value, opts) {
      if (key.includes(devB) && !failTriggered) {
        failTriggered = true;
        throw new Error('模擬裝置 B 快取瞬斷寫入失敗');
      }
      return origSet(key, value, opts);
    };
    inMemoryRedisMockInstance.del = async function (...keys) {
      if (keys.some((k) => k.includes(devB)) && !failTriggered) {
        failTriggered = true;
        throw new Error('模擬裝置 B 快取瞬斷刪除失敗');
      }
      return origDel(...keys);
    };

    // 第一次呼叫：發生錯誤，回傳 500 並釋放鎖定
    const resFail = await postWebhook(baseUrl, { signedPayload: 'payload_retry_10_fail' });
    assert.strictEqual(resFail.status, 500);
    assert.strictEqual(resFail.data.code, 'PROCESSING_FAILED');

    // 恢復正常 Redis 行為
    inMemoryRedisMockInstance.set = origSet;
    inMemoryRedisMockInstance.del = origDel;

    // 第二次呼叫 (Apple 重試)：鎖定已釋放，應能順利進入並成功同步所有設備
    const resSuccess = await postWebhook(baseUrl, { signedPayload: 'payload_retry_10_retry' });
    assert.strictEqual(resSuccess.status, 200);
    assert.strictEqual(resSuccess.data.success, true);

    // 驗證兩台設備均已成功更新為 Pro
    const cacheA = await inMemoryRedisMockInstance.get(`exam_ai:user:${devA}:entitlement`);
    const cacheB = await inMemoryRedisMockInstance.get(`exam_ai:user:${devB}:entitlement`);
    assert.ok(cacheA);
    assert.strictEqual(cacheA.tier, 'pro');
    assert.strictEqual(cacheA.expiresAt, newExpiry);
    assert.ok(cacheB);
    assert.strictEqual(cacheB.tier, 'pro');
    assert.strictEqual(cacheB.expiresAt, newExpiry);
  });

  // ───── 情境 11: Apple API 短暫無法連線 -> 調和機制安全失敗，不破壞 Redis 資料 ─────
  await t.test('11. 主動調和補查時 Apple API 短暫斷線：安全降級回報失敗，絕不破壞既有 Redis 紀錄', async () => {
    const origTxId = 'orig_sub_e2e_011';
    const futureExpiry = baseNow + 15 * 86400 * 1000;

    await inMemoryRedisMockInstance.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      lastTransactionId: 'tx_sub_011',
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      purchaseDate: baseNow - 15 * 86400 * 1000,
      expiresDate: futureExpiry,
      verifiedAt: baseNow - 15 * 86400 * 1000,
      lastAppleSignedDate: baseNow - 15 * 86400 * 1000,
      environment: 'Sandbox',
      willRenew: true,
    });

    // 注入會拋出網路異常的 Mock Client
    const failingClient = {
      isConfigured: () => true,
      getStatus: () => ({ isConfigured: true, environment: 'sandbox', bundleId: EXPECTED_BUNDLE_ID }),
      getAllSubscriptionStatuses: async () => {
        const err = new Error('getaddrinfo EAI_AGAIN api.storekit-sandbox.itunes.apple.com');
        err.code = 'ETIMEDOUT';
        throw err;
      },
      getTransactionInfo: async () => {
        throw new Error('Connection reset');
      },
      getTransactionHistory: async () => ({}),
      getRefundHistory: async () => ({ hasMore: false, signedTransactions: [] }),
    };
    setCustomAppleServerApiClient(failingClient);

    const reconcileRes = await reconcileSubscriptionWithApple(origTxId, { forceLive: true, now: baseNow });
    assert.strictEqual(reconcileRes.success, false);
    assert.strictEqual(reconcileRes.error, 'APPLE_API_CALL_FAILED');

    // 既有 Redis 記錄完好如初
    const preservedRecord = await inMemoryRedisMockInstance.get(`exam_ai:apple:entitlement:${origTxId}`);
    assert.ok(preservedRecord);
    assert.strictEqual(preservedRecord.status, 'active');
    assert.strictEqual(preservedRecord.expiresDate, futureExpiry);
  });

  // ───── 情境 12: 舊版缺少 lastAppleSignedDate 的 Redis 記錄相容性 ─────
  await t.test('12. 舊版無 lastAppleSignedDate 記錄相容性：OCC 正確回退至 purchaseDate 判定先後', async () => {
    const origTxId = 'orig_legacy_012';
    const deviceId = 'dev_legacy_012';

    // 模擬歷史舊資料：完全沒有 lastAppleSignedDate，僅有 purchaseDate
    await inMemoryRedisMockInstance.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      lastTransactionId: 'tx_legacy_prev',
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      purchaseDate: baseNow - 10000,
      expiresDate: baseNow + 10000,
      verifiedAt: baseNow + 999999, // 即使伺服器 verifiedAt 曾被刷新為很大，也不會被誤用！
      environment: 'Sandbox',
    });
    await inMemoryRedisMockInstance.zadd(`exam_ai:apple:devices_z:${origTxId}`, { score: baseNow, member: deviceId });
    await inMemoryRedisMockInstance.sadd(`exam_ai:user:${deviceId}:apple_txns`, origTxId);

    // 傳入更新的續訂事件 (lastAppleSignedDate > legacy.purchaseDate)
    const newExpiry = baseNow + 40 * 86400 * 1000;
    currentMockNotification = {
      isValid: true,
      notificationType: 'DID_RENEW',
      notificationUUID: 'uuid_legacy_update_012',
      signedDate: baseNow + 1000,
      originalTransactionId: origTxId,
      productId: 'exampro_monthly',
      purchaseDate: baseNow + 1000,
      expiresDate: newExpiry,
    };

    const res = await postWebhook(baseUrl, { signedPayload: 'payload_legacy_12' });
    assert.strictEqual(res.status, 200);

    const updated = await inMemoryRedisMockInstance.get(`exam_ai:apple:entitlement:${origTxId}`);
    assert.strictEqual(updated.expiresDate, newExpiry);
    assert.strictEqual(updated.lastAppleSignedDate, baseNow + 1000);
  });

  // ───── 情境 13: 相同 SignedDate 時的事件衝突解決 (撤銷優先於活躍) ─────
  await t.test('13. 相同 SignedDate 衝突防護：退款撤銷具最高優先級，不可被同時間戳記之 active 逆向覆蓋', async () => {
    const origTxId = 'orig_conflict_013';
    const conflictTimestamp = baseNow;

    // 既有為已退款 (revoked)
    await inMemoryRedisMockInstance.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      lastTransactionId: 'tx_revoked_013',
      productId: 'exampro_monthly',
      tier: 'free',
      status: 'revoked',
      purchaseDate: conflictTimestamp - 1000,
      revocationDate: conflictTimestamp,
      lastAppleSignedDate: conflictTimestamp,
      verifiedAt: conflictTimestamp,
      environment: 'Sandbox',
    });

    // 收到相同時間戳記之 active 續訂事件
    currentMockNotification = {
      isValid: true,
      notificationType: 'DID_RENEW',
      notificationUUID: 'uuid_conflict_active_013',
      signedDate: conflictTimestamp,
      originalTransactionId: origTxId,
      productId: 'exampro_monthly',
      purchaseDate: conflictTimestamp,
      expiresDate: conflictTimestamp + 30 * 86400 * 1000,
    };

    const res = await postWebhook(baseUrl, { signedPayload: 'payload_conflict_13' });
    assert.strictEqual(res.status, 200);

    // 驗證：依然維持 revoked，退款未被覆蓋！
    const mainRecord = await inMemoryRedisMockInstance.get(`exam_ai:apple:entitlement:${origTxId}`);
    assert.strictEqual(mainRecord.status, 'revoked');
  });

  // ───── 情境 14: 會員快取過期時間 (TTL) 與主交易記錄 TTL 的正確性 ─────
  await t.test('14. TTL 生命週期精確度驗證：月訂閱動態 TTL、終身版永久保存、退款 30 天緩衝', async () => {
    const origMonthly = 'orig_ttl_monthly_014';
    const devMonthly = 'dev_ttl_monthly_014';
    const diffSec = 20 * 86400;
    const monthlyExpiry = Date.now() + diffSec * 1000;

    await inMemoryRedisMockInstance.zadd(`exam_ai:apple:devices_z:${origMonthly}`, { score: Date.now(), member: devMonthly });
    await inMemoryRedisMockInstance.sadd(`exam_ai:user:${devMonthly}:apple_txns`, origMonthly);

    currentMockNotification = {
      isValid: true,
      notificationType: 'DID_RENEW',
      notificationUUID: 'uuid_ttl_monthly_014',
      signedDate: Date.now(),
      originalTransactionId: origMonthly,
      productId: 'exampro_monthly',
      purchaseDate: Date.now(),
      expiresDate: monthlyExpiry,
    };

    await postWebhook(baseUrl, { signedPayload: 'payload_ttl_14' });

    // 驗證月訂閱主記錄 TTL (約 20 天 + 30 天緩衝 = 50 天)
    const mainMonthlyTtl = await inMemoryRedisMockInstance.ttl(`exam_ai:apple:entitlement:${origMonthly}`);
    assert.ok(mainMonthlyTtl > 45 * 86400 && mainMonthlyTtl <= 51 * 86400);

    // 驗證月訂閱使用者快取 TTL (約 20 天)
    const cacheMonthlyTtl = await inMemoryRedisMockInstance.ttl(`exam_ai:user:${devMonthly}:entitlement`);
    assert.ok(cacheMonthlyTtl > 15 * 86400 && cacheMonthlyTtl <= 21 * 86400);

    // 驗證 Lifetime 終身版：無 TTL (-1)
    const origLifetime = 'orig_ttl_lifetime_014';
    const devLifetime = 'dev_ttl_lifetime_014';
    await inMemoryRedisMockInstance.zadd(`exam_ai:apple:devices_z:${origLifetime}`, { score: Date.now(), member: devLifetime });
    await inMemoryRedisMockInstance.sadd(`exam_ai:user:${devLifetime}:apple_txns`, origLifetime);

    currentMockNotification = {
      isValid: true,
      notificationType: 'SUBSCRIBED',
      subtype: 'INITIAL_BUY',
      notificationUUID: 'uuid_ttl_lifetime_014',
      signedDate: Date.now(),
      originalTransactionId: origLifetime,
      productId: 'exampro_lifetime',
      purchaseDate: Date.now(),
    };

    await postWebhook(baseUrl, { signedPayload: 'payload_ttl_14_lifetime' });
    const mainLifetimeTtl = await inMemoryRedisMockInstance.ttl(`exam_ai:apple:entitlement:${origLifetime}`);
    assert.strictEqual(mainLifetimeTtl, -1); // 永久保存無過期

    const cacheLifetimeTtl = await inMemoryRedisMockInstance.ttl(`exam_ai:user:${devLifetime}:entitlement`);
    assert.strictEqual(cacheLifetimeTtl, -1); // 永久保存無過期
  });

  // ───── 情境 15: TEST 通知不影響現有會員資料 ─────
  await t.test('15. Apple TEST 通知防護：連線探測通知安全略過，不變更任何現有會員權益', async () => {
    const origTxId = 'orig_existing_015';
    const deviceId = 'dev_existing_015';
    const futureExpiry = baseNow + 25 * 86400 * 1000;

    await inMemoryRedisMockInstance.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      lastTransactionId: 'tx_sub_015',
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      purchaseDate: baseNow - 5 * 86400 * 1000,
      expiresDate: futureExpiry,
      verifiedAt: baseNow - 5 * 86400 * 1000,
      lastAppleSignedDate: baseNow - 5 * 86400 * 1000,
      environment: 'Sandbox',
      willRenew: true,
    });
    await inMemoryRedisMockInstance.zadd(`exam_ai:apple:devices_z:${origTxId}`, { score: baseNow, member: deviceId });
    await inMemoryRedisMockInstance.sadd(`exam_ai:user:${deviceId}:apple_txns`, origTxId);
    await syncUserDeviceEffectiveEntitlement(deviceId, origTxId);

    // Apple 發送 TEST 測試通知
    currentMockNotification = {
      isValid: true,
      notificationType: 'TEST',
      notificationUUID: 'uuid_test_conn_015',
      signedDate: baseNow,
      bundleId: EXPECTED_BUNDLE_ID,
      environment: 'Sandbox',
    };

    const res = await postWebhook(baseUrl, { signedPayload: 'payload_test_notification' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.action, 'IGNORE_TEST_NOTIFICATION');

    // 驗證：現有會員資料毫髮無損
    const mainRecord = await inMemoryRedisMockInstance.get(`exam_ai:apple:entitlement:${origTxId}`);
    assert.ok(mainRecord);
    assert.strictEqual(mainRecord.status, 'active');
    assert.strictEqual(mainRecord.expiresDate, futureExpiry);

    const devCache = await inMemoryRedisMockInstance.get(`exam_ai:user:${deviceId}:entitlement`);
    assert.ok(devCache);
    assert.strictEqual(devCache.tier, 'pro');
  });
});
