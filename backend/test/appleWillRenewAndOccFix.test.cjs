const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// 設定測試環境變數
process.env.MOCK_REDIS = 'true';
process.env.OPENAI_API_KEY = 'test_mock_key';
process.env.APP_SERVER_SECRET = 'test_secret_for_willrenew_occ_tests';
process.env.APPLE_WEBHOOK_DRY_RUN = 'false';

const statusModule = require('../dist/api/subscription-status.js');
const verifyTxModule = require('../dist/api/verify-transaction.js');
const {
  EXPECTED_BUNDLE_ID,
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
} = require('../dist/lib/entitlement.js');
const {
  applySubscriptionStateToRedis,
} = require('../dist/lib/appleSubscriptionSync.js');
const {
  acquireWebhookIdempotency,
  completeWebhookIdempotency,
} = require('../dist/lib/appleWebhookHandler.js');

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

function postJson(server, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const reqOptions = {
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    };

    const req = http.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const bodyStr = Buffer.concat(chunks).toString('utf-8');
        let parsed;
        try {
          parsed = JSON.parse(bodyStr);
        } catch {
          parsed = bodyStr;
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });

    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

test('Phase 3.4c-9：Apple IAP willRenew 持久化與 Webhook OCC 競態修復驗證套件 (TC01-TC20)', async (t) => {
  let server;
  const redis = getRedisClient();

  t.before(async () => {
    server = createTestServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  t.after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  t.beforeEach(() => {
    inMemoryRedisMockInstance.clearAll();
  });

  // ───── TC01：首次購買，Webhook 先到達 ─────
  await t.test('TC01：首次購買，Webhook 先到達 -> App 主動驗證絕不清除 willRenew=true', async () => {
    const origTxId = 'tc01_orig_tx';
    const userId = 'user_tc01';
    const now = 1729350000000;
    const expiresDate = now + 30 * 86400 * 1000;

    // 1. Webhook 先到達 (SUBSCRIBED + autoRenewStatus=1)
    const syncRes = await applySubscriptionStateToRedis({
      originalTransactionId: origTxId,
      transition: {
        actionable: true,
        action: 'APPLY_ACTIVE',
        status: 'active',
        tier: 'pro',
        effectiveExpiresDate: expiresDate,
        willRenew: true,
        reason: 'Apple 訂閱購買成功',
      },
      verifiedNotification: {
        isValid: true,
        notificationType: 'SUBSCRIBED',
        subtype: 'INITIAL_BUY',
        notificationUUID: 'uuid_tc01_1',
        signedDate: now,
        transaction: {
          signedDate: now,
          productId: 'exampro_monthly',
          originalTransactionId: origTxId,
          transactionId: 'tx_tc01_1',
          purchaseDate: now,
          expiresDate,
        },
        renewalInfo: {
          signedDate: now,
          autoRenewStatus: 1,
        },
      },
      now,
      isDryRun: false,
    });

    assert.strictEqual(syncRes.success, true);

    const recordAfterWebhook = await getOriginalTransactionEntitlement(origTxId);
    assert.strictEqual(recordAfterWebhook.willRenew, true);
    assert.strictEqual(recordAfterWebhook.status, 'active');

    // 2. 稍後 App 前端發起交易主動驗證 (JWS 只帶交易憑證，無續約資訊)
    const saveRes = await saveVerifiedEntitlement(userId, {
      isValid: true,
      status: 'active',
      tier: 'pro',
      productId: 'exampro_monthly',
      originalTransactionId: origTxId,
      transactionId: 'tx_tc01_1',
      purchaseDate: now,
      expiresDate,
      signedDate: now,
      environment: 'Sandbox',
      isExpired: false,
      isRevoked: false,
    });

    assert.strictEqual(saveRes.effectiveStatus, 'active');
    assert.strictEqual(saveRes.effectiveTier, 'pro');
    assert.strictEqual(saveRes.effectiveWillRenew, true);

    // 3. 驗證 Redis 交易主記錄中的 willRenew 依然穩固保存為 true，未被抹除！
    const finalRecord = await getOriginalTransactionEntitlement(origTxId);
    assert.strictEqual(finalRecord.willRenew, true);
  });

  // ───── TC02：首次購買，App 驗證先到達 ─────
  await t.test('TC02：首次購買，App 驗證先到達 -> 隨後 Webhook 成功補齊 willRenew=true', async () => {
    const origTxId = 'tc02_orig_tx';
    const userId = 'user_tc02';
    const now = 1729350000000;
    const expiresDate = now + 30 * 86400 * 1000;

    // 1. App 驗證先到達 (無 renewalInfo，willRenew 保持 undefined)
    const saveRes = await saveVerifiedEntitlement(userId, {
      isValid: true,
      status: 'active',
      tier: 'pro',
      productId: 'exampro_monthly',
      originalTransactionId: origTxId,
      transactionId: 'tx_tc02_1',
      purchaseDate: now,
      expiresDate,
      signedDate: now,
      environment: 'Sandbox',
      isExpired: false,
      isRevoked: false,
    });

    assert.strictEqual(saveRes.effectiveStatus, 'active');
    assert.strictEqual(saveRes.effectiveWillRenew, undefined); // 尚未取得 Apple 權威續訂偏好時保持 undefined

    // 2. 隨後 Apple Webhook 到達 (SUBSCRIBED + autoRenewStatus=1)
    const syncRes = await applySubscriptionStateToRedis({
      originalTransactionId: origTxId,
      transition: {
        actionable: true,
        action: 'APPLY_ACTIVE',
        status: 'active',
        tier: 'pro',
        effectiveExpiresDate: expiresDate,
        willRenew: true,
        reason: 'Apple 訂閱購買成功',
      },
      verifiedNotification: {
        isValid: true,
        notificationType: 'SUBSCRIBED',
        subtype: 'INITIAL_BUY',
        notificationUUID: 'uuid_tc02_1',
        signedDate: now + 1000,
        transaction: {
          signedDate: now,
          productId: 'exampro_monthly',
          originalTransactionId: origTxId,
          transactionId: 'tx_tc02_1',
          purchaseDate: now,
          expiresDate,
        },
        renewalInfo: {
          signedDate: now + 1000,
          autoRenewStatus: 1,
        },
      },
      now: now + 1000,
      isDryRun: false,
    });

    assert.strictEqual(syncRes.success, true);

    // 3. 驗證 Redis 記錄已成功補齊 willRenew: true
    const finalRecord = await getOriginalTransactionEntitlement(origTxId);
    assert.strictEqual(finalRecord.willRenew, true);
    assert.strictEqual(finalRecord.status, 'active');
  });

  // ───── TC03：Webhook 和 App 驗證同時發生 (並行安全) ─────
  await t.test('TC03：Webhook 和 App 驗證同時並行寫入 -> OCC 確保無資料損壞且最終一致', async () => {
    const origTxId = 'tc03_orig_tx';
    const userId = 'user_tc03';
    const now = 1729350000000;
    const expiresDate = now + 30 * 86400 * 1000;

    const p1 = applySubscriptionStateToRedis({
      originalTransactionId: origTxId,
      transition: {
        actionable: true,
        action: 'APPLY_ACTIVE',
        status: 'active',
        tier: 'pro',
        effectiveExpiresDate: expiresDate,
        willRenew: true,
        reason: 'Apple 訂閱購買成功',
      },
      verifiedNotification: {
        isValid: true,
        notificationType: 'SUBSCRIBED',
        signedDate: now,
        transaction: { signedDate: now, productId: 'exampro_monthly', expiresDate, purchaseDate: now },
        renewalInfo: { signedDate: now, autoRenewStatus: 1 },
      },
      now,
      isDryRun: false,
    });

    const p2 = saveVerifiedEntitlement(userId, {
      isValid: true,
      status: 'active',
      tier: 'pro',
      productId: 'exampro_monthly',
      originalTransactionId: origTxId,
      transactionId: 'tx_tc03_1',
      purchaseDate: now,
      expiresDate,
      signedDate: now,
      environment: 'Sandbox',
      isExpired: false,
      isRevoked: false,
    });

    await Promise.all([p1, p2]);

    const finalRecord = await getOriginalTransactionEntitlement(origTxId);
    assert.strictEqual(finalRecord.status, 'active');
    assert.strictEqual(finalRecord.productId, 'exampro_monthly');
    assert.strictEqual(finalRecord.tier, 'pro');
  });

  // ───── TC04：關閉自動續訂後 willRenew=false ─────
  await t.test('TC04：收到 DID_CHANGE_RENEWAL_STATUS (AUTO_RENEW_DISABLED) -> willRenew 儲存為 false', async () => {
    const origTxId = 'tc04_orig_tx';
    const now = 1729350000000;
    const expiresDate = now + 20 * 86400 * 1000;

    // 初始狀態為有效訂閱且 willRenew=true
    await redis.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      lastTransactionId: 'tx_tc04_1',
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      purchaseDate: now - 10 * 86400 * 1000,
      expiresDate,
      willRenew: true,
      verifiedAt: now - 10 * 86400 * 1000,
      lastAppleSignedDate: now - 10 * 86400 * 1000,
      lastRenewalSignedDate: now - 10 * 86400 * 1000,
      environment: 'Sandbox',
    });

    // 使用者在 iPhone 設定中關閉自動續約
    const disableDate = now + 1000;
    const syncRes = await applySubscriptionStateToRedis({
      originalTransactionId: origTxId,
      transition: {
        actionable: true,
        action: 'UPDATE_RENEWAL_INFO',
        status: 'active',
        tier: 'pro',
        effectiveExpiresDate: expiresDate,
        willRenew: false,
        reason: '使用者自動續訂狀態已變更為 關閉。',
      },
      verifiedNotification: {
        isValid: true,
        notificationType: 'DID_CHANGE_RENEWAL_STATUS',
        subtype: 'AUTO_RENEW_DISABLED',
        notificationUUID: 'uuid_tc04_disable',
        signedDate: disableDate,
        transaction: {
          signedDate: now - 10 * 86400 * 1000, // 交易時間仍為原始購買時間
          productId: 'exampro_monthly',
          expiresDate,
        },
        renewalInfo: {
          signedDate: disableDate,
          autoRenewStatus: 0,
        },
      },
      now: disableDate,
      isDryRun: false,
    });

    assert.strictEqual(syncRes.success, true);

    const record = await getOriginalTransactionEntitlement(origTxId);
    assert.strictEqual(record.status, 'active');
    assert.strictEqual(record.willRenew, false);
    assert.strictEqual(record.lastRenewalSignedDate, disableDate);
  });

  // ───── TC05：關閉續訂但未到期時維持 Pro ─────
  await t.test('TC05：關閉自動續訂但尚未到期時 -> 會員權限維持 Pro 有效 (不提前收回)', async () => {
    const origTxId = 'tc05_orig_tx';
    const userId = 'user_tc05';
    const now = Date.now();
    const expiresDate = now + 15 * 86400 * 1000;

    await redis.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      expiresDate,
      willRenew: false, // 已取消續訂
      verifiedAt: now,
      environment: 'Sandbox',
    });
    await redis.sadd(`exam_ai:user:${userId}:apple_txns`, origTxId);
    await syncUserDeviceEffectiveEntitlement(userId, origTxId);

    const userEntitlement = await getUserEntitlement(userId);
    assert.strictEqual(userEntitlement.status, 'active');
    assert.strictEqual(userEntitlement.tier, 'pro');
    assert.strictEqual(userEntitlement.isVerified, true);
    assert.strictEqual(userEntitlement.willRenew, false);
  });

  // ───── TC06：App 重新查詢後 willRenew=false 不消失 ─────
  await t.test('TC06：App 發送 subscription-status 查詢 -> willRenew=false 正確回傳且保持在 Redis', async () => {
    const origTxId = 'tc06_orig_tx';
    const userId = 'user_tc06';
    const now = Date.now();
    const expiresDate = now + 15 * 86400 * 1000;

    await redis.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      expiresDate,
      willRenew: false,
      verifiedAt: now,
      environment: 'Sandbox',
    });
    await redis.sadd(`exam_ai:user:${userId}:apple_txns`, origTxId);
    await syncUserDeviceEffectiveEntitlement(userId, origTxId);

    const token = generateEntitlementProofToken(userId, origTxId, expiresDate);

    const res = await postJson(server, '/api/subscription-status', { deviceId: userId }, {
      'X-Client-Device-Id': userId,
      Authorization: `Bearer ${token}`,
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.tier, 'pro');
    assert.strictEqual(res.body.status, 'active');
    assert.strictEqual(res.body.willRenew, false); // 絕不被硬編碼成 true！
  });

  // ───── TC07：再次使用舊 JWS 驗證，不得恢復 true ─────
  await t.test('TC07：關閉續約後 App 發送舊購買 JWS 重新驗證 -> 絕不能將 willRenew 覆蓋回 true', async () => {
    const origTxId = 'tc07_orig_tx';
    const userId = 'user_tc07';
    const buyTime = 1729350000000;
    const cancelTime = buyTime + 5000;
    const expiresDate = buyTime + 30 * 86400 * 1000;

    // 既有 Redis 已被 Webhook 標記為 willRenew: false
    await redis.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      lastTransactionId: 'tx_tc07_1',
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      purchaseDate: buyTime,
      expiresDate,
      willRenew: false,
      verifiedAt: cancelTime,
      lastAppleSignedDate: buyTime,
      lastRenewalSignedDate: cancelTime,
      environment: 'Sandbox',
    });

    // App 發起恢復購買或重送購買收據 (signedDate 為舊購買時間 buyTime)
    const saveRes = await saveVerifiedEntitlement(userId, {
      isValid: true,
      status: 'active',
      tier: 'pro',
      productId: 'exampro_monthly',
      originalTransactionId: origTxId,
      transactionId: 'tx_tc07_1',
      purchaseDate: buyTime,
      expiresDate,
      signedDate: buyTime,
      environment: 'Sandbox',
      isExpired: false,
      isRevoked: false,
    });

    assert.strictEqual(saveRes.effectiveStatus, 'active');
    assert.strictEqual(saveRes.effectiveWillRenew, false); // 保持為 false！

    const finalRecord = await getOriginalTransactionEntitlement(origTxId);
    assert.strictEqual(finalRecord.willRenew, false); // Redis 中仍然為 false！
  });

  // ───── TC08：重新開啟自動續訂 ─────
  await t.test('TC08：收到 AUTO_RENEW_ENABLED 通知 -> willRenew 正確更新回 true', async () => {
    const origTxId = 'tc08_orig_tx';
    const now = 1729350000000;
    const expiresDate = now + 25 * 86400 * 1000;

    await redis.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      expiresDate,
      willRenew: false, // 之前已關閉
      lastRenewalSignedDate: now,
      environment: 'Sandbox',
    });

    const reEnableTime = now + 10000;
    const syncRes = await applySubscriptionStateToRedis({
      originalTransactionId: origTxId,
      transition: {
        actionable: true,
        action: 'UPDATE_RENEWAL_INFO',
        status: 'active',
        tier: 'pro',
        effectiveExpiresDate: expiresDate,
        willRenew: true,
        reason: '使用者自動續訂狀態已變更為 開啟。',
      },
      verifiedNotification: {
        isValid: true,
        notificationType: 'DID_CHANGE_RENEWAL_STATUS',
        subtype: 'AUTO_RENEW_ENABLED',
        signedDate: reEnableTime,
        renewalInfo: {
          signedDate: reEnableTime,
          autoRenewStatus: 1,
        },
      },
      now: reEnableTime,
      isDryRun: false,
    });

    assert.strictEqual(syncRes.success, true);

    const record = await getOriginalTransactionEntitlement(origTxId);
    assert.strictEqual(record.willRenew, true);
    assert.strictEqual(record.lastRenewalSignedDate, reEnableTime);
  });

  // ───── TC09：自動續訂成功並更新到期日 ─────
  await t.test('TC09：收到 DID_RENEW 通知 -> 更新最新到期日且維持 willRenew=true', async () => {
    const origTxId = 'tc09_orig_tx';
    const now = 1729350000000;
    const oldExpiresDate = now + 86400 * 1000;
    const newExpiresDate = oldExpiresDate + 30 * 86400 * 1000;

    await redis.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      lastTransactionId: 'tx_old',
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      expiresDate: oldExpiresDate,
      willRenew: true,
      lastAppleSignedDate: now - 29 * 86400 * 1000,
      environment: 'Sandbox',
    });

    const renewTime = oldExpiresDate - 3600 * 1000;
    const syncRes = await applySubscriptionStateToRedis({
      originalTransactionId: origTxId,
      transition: {
        actionable: true,
        action: 'APPLY_RENEWAL',
        status: 'active',
        tier: 'pro',
        effectiveExpiresDate: newExpiresDate,
        willRenew: true,
        reason: 'Apple 自動續訂扣款成功。',
      },
      verifiedNotification: {
        isValid: true,
        notificationType: 'DID_RENEW',
        signedDate: renewTime,
        transaction: {
          signedDate: renewTime,
          transactionId: 'tx_new_renewed',
          originalTransactionId: origTxId,
          expiresDate: newExpiresDate,
          purchaseDate: renewTime,
        },
        renewalInfo: {
          signedDate: renewTime,
          autoRenewStatus: 1,
        },
      },
      now: renewTime,
      isDryRun: false,
    });

    assert.strictEqual(syncRes.success, true);

    const record = await getOriginalTransactionEntitlement(origTxId);
    assert.strictEqual(record.expiresDate, newExpiresDate);
    assert.strictEqual(record.lastTransactionId, 'tx_new_renewed');
    assert.strictEqual(record.willRenew, true);
  });

  // ───── TC10：正常到期降級 ─────
  await t.test('TC10：收到 EXPIRED 通知 -> 正確降級為 expired 並更新 Redis', async () => {
    const origTxId = 'tc10_orig_tx';
    const userId = 'user_tc10';
    const now = 1729350000000;
    const expiredTime = now - 1000;

    await redis.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      expiresDate: expiredTime,
      lastAppleSignedDate: now - 30 * 86400 * 1000,
      environment: 'Sandbox',
    });
    await redis.sadd(`exam_ai:user:${userId}:apple_txns`, origTxId);
    await syncUserDeviceEffectiveEntitlement(userId, origTxId);

    const syncRes = await applySubscriptionStateToRedis({
      originalTransactionId: origTxId,
      transition: {
        actionable: true,
        action: 'APPLY_EXPIRED',
        status: 'expired',
        tier: 'free',
        effectiveExpiresDate: expiredTime,
        reason: '訂閱方案已到期終止。',
      },
      verifiedNotification: {
        isValid: true,
        notificationType: 'EXPIRED',
        signedDate: now,
        expiresDate: expiredTime,
      },
      now,
      isDryRun: false,
    });

    assert.strictEqual(syncRes.success, true);

    const record = await getOriginalTransactionEntitlement(origTxId);
    assert.strictEqual(record.status, 'expired');

    const userEntitlement = await getUserEntitlement(userId);
    assert.strictEqual(userEntitlement.tier, 'free');
    assert.strictEqual(userEntitlement.isVerified, false);
    assert.ok(userEntitlement.status === 'expired' || userEntitlement.status === 'none');
  });

  // ───── TC11：退款或撤銷後防止舊交易復活 ─────
  await t.test('TC11：交易已被 Apple 退款/撤銷 -> 舊 active JWS 絕不能重新啟用 Pro', async () => {
    const origTxId = 'tc11_orig_tx';
    const userId = 'user_tc11';
    const now = 1729350000000;

    // 先由 Webhook 標記為 revoked
    await redis.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'revoked',
      purchaseDate: now - 5000,
      revocationDate: now,
      lastAppleSignedDate: now,
      environment: 'Sandbox',
    });

    // 惡意用戶或慢速裝置發送舊的有效 JWS (status: active, purchaseDate: now - 5000)
    const saveRes = await saveVerifiedEntitlement(userId, {
      isValid: true,
      status: 'active',
      tier: 'pro',
      productId: 'exampro_monthly',
      originalTransactionId: origTxId,
      transactionId: 'tx_old_active',
      purchaseDate: now - 5000,
      signedDate: now - 5000,
      environment: 'Sandbox',
      isExpired: false,
      isRevoked: false,
    });

    assert.strictEqual(saveRes.effectiveStatus, 'revoked');
    assert.strictEqual(saveRes.effectiveTier, 'free');

    const record = await getOriginalTransactionEntitlement(origTxId);
    assert.strictEqual(record.status, 'revoked');
  });

  // ───── TC12：重複 Apple Webhook UUID 冪等性 ─────
  await t.test('TC12：重複 Apple Webhook UUID -> 冪等鎖直接回傳已完成，不重複處理', async () => {
    const uuid = 'notif_uuid_idempotent_test_999';

    // 第一次處理前取得鎖
    const lock1 = await acquireWebhookIdempotency(uuid, { isDryRun: false });
    assert.strictEqual(lock1.acquired, true);

    // 完成處理
    await completeWebhookIdempotency(uuid, { isDryRun: false });

    // 第二次相同 UUID 到達
    const lock2 = await acquireWebhookIdempotency(uuid, { isDryRun: false });
    assert.strictEqual(lock2.acquired, false);
    assert.strictEqual(lock2.state, 'completed');
  });

  // ───── TC13：Apple Webhook 亂序到達 ─────
  await t.test('TC13：亂序到達的過期通知 (已有較新有效續訂) -> OCC 阻止降級保持 active', async () => {
    const origTxId = 'tc13_orig_tx';
    const now = 1729350000000;
    const newerExpiry = now + 45 * 86400 * 1000;
    const staleExpiry = now + 15 * 86400 * 1000;

    await redis.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      expiresDate: newerExpiry,
      lastAppleSignedDate: now,
      environment: 'Sandbox',
    });

    const syncRes = await applySubscriptionStateToRedis({
      originalTransactionId: origTxId,
      transition: {
        actionable: true,
        action: 'APPLY_EXPIRED',
        status: 'expired',
        tier: 'free',
        effectiveExpiresDate: staleExpiry, // 比現有到期日更早
        reason: '亂序過期通知',
      },
      verifiedNotification: {
        isValid: true,
        notificationType: 'EXPIRED',
        signedDate: now - 10000,
        expiresDate: staleExpiry,
      },
      now,
      isDryRun: false,
    });

    assert.strictEqual(syncRes.success, true);
    // 應被 OCC 或狀態評估器阻擋，保持 active
    const record = await getOriginalTransactionEntitlement(origTxId);
    assert.strictEqual(record.status, 'active');
    assert.strictEqual(record.expiresDate, newerExpiry);
  });

  // ───── TC14：相同及缺失 signedDate 處理 ─────
  await t.test('TC14：簽名時間戳記相同但一筆為退款 -> 退款具優先權絕不被 active 覆蓋', async () => {
    const origTxId = 'tc14_orig_tx';
    const now = 1729350000000;

    await redis.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'revoked',
      lastAppleSignedDate: now,
      revocationDate: now,
      environment: 'Sandbox',
    });

    // 相同時間戳記之 active 嘗試寫入
    const incomingData = {
      originalTransactionId: origTxId,
      lastTransactionId: 'tx_conflict',
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      lastAppleSignedDate: now,
      environment: 'Sandbox',
    };

    const occRes = await redis.eval(
      SAVE_ENTITLEMENT_OCC_LUA,
      [`exam_ai:apple:entitlement:${origTxId}`],
      [JSON.stringify(incomingData), String(now), '86400'],
    );

    assert.strictEqual(occRes[0], 'REVOKED_LOCK');
  });

  // ───── TC15：多裝置同時驗證 ─────
  await t.test('TC15：5 台裝置同時發起交易驗證 -> 均正確綁定且不互相干擾', async () => {
    const origTxId = 'tc15_orig_tx';
    const now = Date.now();
    const expiresDate = now + 30 * 86400 * 1000;

    const devices = ['dev_tc15_1', 'dev_tc15_2', 'dev_tc15_3', 'dev_tc15_4', 'dev_tc15_5'];

    await Promise.all(
      devices.map((devId) =>
        saveVerifiedEntitlement(devId, {
          isValid: true,
          status: 'active',
          tier: 'pro',
          productId: 'exampro_monthly',
          originalTransactionId: origTxId,
          transactionId: 'tx_multi_dev',
          purchaseDate: now,
          expiresDate,
          signedDate: now,
          environment: 'Sandbox',
          isExpired: false,
          isRevoked: false,
        }),
      ),
    );

    const linkedCount = await redis.zcard(`exam_ai:apple:devices_z:${origTxId}`);
    assert.strictEqual(linkedCount, 5);

    for (const devId of devices) {
      const uEnt = await getUserEntitlement(devId);
      assert.strictEqual(uEnt.status, 'active');
      assert.strictEqual(uEnt.tier, 'pro');
    }
  });

  // ───── TC16：Lifetime 權益優先權 ─────
  await t.test('TC16：Lifetime 終身方案不具備 willRenew 且不可被訂閱過期通知降級', async () => {
    const origTxId = 'tc16_lifetime_tx';
    const userId = 'user_tc16';
    const now = 1729350000000;

    // 購買 Lifetime
    const saveRes = await saveVerifiedEntitlement(userId, {
      isValid: true,
      status: 'active',
      tier: 'lifetime',
      productId: 'exampro_lifetime',
      originalTransactionId: origTxId,
      transactionId: 'tx_lifetime_1',
      purchaseDate: now,
      signedDate: now,
      environment: 'Sandbox',
      isExpired: false,
      isRevoked: false,
    });

    assert.strictEqual(saveRes.effectiveTier, 'lifetime');
    assert.strictEqual(saveRes.effectiveWillRenew, undefined); // 終身買斷絕無 willRenew

    const record = await getOriginalTransactionEntitlement(origTxId);
    assert.strictEqual(record.willRenew, undefined);

    // 企圖以一般月訂閱過期通知覆寫同一個 mainKey
    const staleMonthly = {
      originalTransactionId: origTxId,
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'expired',
      lastAppleSignedDate: now + 5000,
    };

    const occRes = await redis.eval(
      SAVE_ENTITLEMENT_OCC_LUA,
      [`exam_ai:apple:entitlement:${origTxId}`],
      [JSON.stringify(staleMonthly), String(now + 5000), '86400'],
    );

    assert.strictEqual(occRes[0], 'LIFETIME_PROTECTED');

    // 主記錄仍為 Lifetime
    const finalRecord = await getOriginalTransactionEntitlement(origTxId);
    assert.strictEqual(finalRecord.tier, 'lifetime');
    assert.strictEqual(finalRecord.status, 'active');
  });

  // ───── TC17：舊 Redis 資料沒有 willRenew 相容性 ─────
  await t.test('TC17：舊 Redis 資料缺失 willRenew 欄位 -> 查詢時保留未知狀態 (undefined) 且絕不擅自預設為 true，同時維持 Pro 權益', async () => {
    const origTxId = 'tc17_legacy_tx';
    const userId = 'user_tc17';
    const now = Date.now();
    const expiresDate = now + 15 * 86400 * 1000;

    // 刻意寫入舊版 JSON 結構 (無 willRenew 欄位)
    await redis.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      lastTransactionId: 'tx_legacy',
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      purchaseDate: now - 86400 * 1000,
      expiresDate,
      verifiedAt: now,
      environment: 'Sandbox',
    });
    await redis.sadd(`exam_ai:user:${userId}:apple_txns`, origTxId);
    await syncUserDeviceEffectiveEntitlement(userId, origTxId);

    const token = generateEntitlementProofToken(userId, origTxId, expiresDate);

    const res = await postJson(server, '/api/subscription-status', { deviceId: userId }, {
      'X-Client-Device-Id': userId,
      Authorization: `Bearer ${token}`,
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.tier, 'pro');
    assert.strictEqual(res.body.status, 'active');
    assert.strictEqual(res.body.isVerified, true);
    assert.strictEqual(res.body.willRenew, undefined); // 未知狀態保留 undefined，絕不擅自預設為 true！
  });

  // ───── TC18：subscription-status 端到端三態驗證 (true, false, undefined) 與 Lifetime 差異 ─────
  await t.test('TC18：subscription-status 端到端三態驗證：精確反映 willRenew=true、false、未知 (undefined) 與 Lifetime 差異', async () => {
    const subTxIdFalse = 'tc18_sub_tx_false';
    const subTxIdTrue = 'tc18_sub_tx_true';
    const subTxIdUnknown = 'tc18_sub_tx_unknown';
    const lifeTxId = 'tc18_life_tx';

    const userFalse = 'user_tc18_false';
    const userTrue = 'user_tc18_true';
    const userUnknown = 'user_tc18_unknown';
    const userLife = 'user_tc18_life';

    const now = Date.now();
    const expDate = now + 10 * 86400 * 1000;

    // 1. 訂閱已關閉續約 (willRenew: false)
    await redis.set(`exam_ai:apple:entitlement:${subTxIdFalse}`, {
      originalTransactionId: subTxIdFalse,
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      expiresDate: expDate,
      willRenew: false,
      environment: 'Sandbox',
    });
    await redis.sadd(`exam_ai:user:${userFalse}:apple_txns`, subTxIdFalse);
    await syncUserDeviceEffectiveEntitlement(userFalse, subTxIdFalse);
    const tokenFalse = generateEntitlementProofToken(userFalse, subTxIdFalse, expDate);

    const resFalse = await postJson(server, '/api/subscription-status', {}, {
      'X-Client-Device-Id': userFalse,
      Authorization: `Bearer ${tokenFalse}`,
    });
    assert.strictEqual(resFalse.body.status, 'active');
    assert.strictEqual(resFalse.body.tier, 'pro');
    assert.strictEqual(resFalse.body.isVerified, true);
    assert.strictEqual(resFalse.body.willRenew, false);

    // 2. 訂閱正常自動續約中 (willRenew: true)
    await redis.set(`exam_ai:apple:entitlement:${subTxIdTrue}`, {
      originalTransactionId: subTxIdTrue,
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      expiresDate: expDate,
      willRenew: true,
      environment: 'Sandbox',
    });
    await redis.sadd(`exam_ai:user:${userTrue}:apple_txns`, subTxIdTrue);
    await syncUserDeviceEffectiveEntitlement(userTrue, subTxIdTrue);
    const tokenTrue = generateEntitlementProofToken(userTrue, subTxIdTrue, expDate);

    const resTrue = await postJson(server, '/api/subscription-status', {}, {
      'X-Client-Device-Id': userTrue,
      Authorization: `Bearer ${tokenTrue}`,
    });
    assert.strictEqual(resTrue.body.status, 'active');
    assert.strictEqual(resTrue.body.tier, 'pro');
    assert.strictEqual(resTrue.body.isVerified, true);
    assert.strictEqual(resTrue.body.willRenew, true);

    // 3. 訂閱續約資訊未知 (willRenew: undefined)
    await redis.set(`exam_ai:apple:entitlement:${subTxIdUnknown}`, {
      originalTransactionId: subTxIdUnknown,
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      expiresDate: expDate,
      environment: 'Sandbox',
    });
    await redis.sadd(`exam_ai:user:${userUnknown}:apple_txns`, subTxIdUnknown);
    await syncUserDeviceEffectiveEntitlement(userUnknown, subTxIdUnknown);
    const tokenUnknown = generateEntitlementProofToken(userUnknown, subTxIdUnknown, expDate);

    const resUnknown = await postJson(server, '/api/subscription-status', {}, {
      'X-Client-Device-Id': userUnknown,
      Authorization: `Bearer ${tokenUnknown}`,
    });
    assert.strictEqual(resUnknown.body.status, 'active');
    assert.strictEqual(resUnknown.body.tier, 'pro');
    assert.strictEqual(resUnknown.body.isVerified, true);
    assert.strictEqual(resUnknown.body.willRenew, undefined); // 必須保留未知狀態，絕不擅自填為 true

    // 4. 終身方案 (Lifetime)
    await redis.set(`exam_ai:apple:entitlement:${lifeTxId}`, {
      originalTransactionId: lifeTxId,
      productId: 'exampro_lifetime',
      tier: 'lifetime',
      status: 'active',
      environment: 'Sandbox',
    });
    await redis.sadd(`exam_ai:user:${userLife}:apple_txns`, lifeTxId);
    await syncUserDeviceEffectiveEntitlement(userLife, lifeTxId);
    const tokenLife = generateEntitlementProofToken(userLife, lifeTxId);

    const resLife = await postJson(server, '/api/subscription-status', {}, {
      'X-Client-Device-Id': userLife,
      Authorization: `Bearer ${tokenLife}`,
    });
    assert.strictEqual(resLife.body.tier, 'lifetime');
    assert.strictEqual(resLife.body.status, 'active');
    assert.strictEqual(resLife.body.isVerified, true);
    assert.strictEqual(resLife.body.willRenew, undefined);
  });

  // ───── TC19：Redis Lua 腳本與 Mock 行為一致 ─────
  await t.test('TC19：Redis Lua 腳本與 InMemoryRedisMock 行為一致性校驗', async () => {
    const origTxId = 'tc19_mock_test';
    const now = 1729350000000;

    // 初始記錄
    await redis.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      lastAppleSignedDate: now,
      willRenew: true,
      environment: 'Sandbox',
    });

    // 1. 舊時間戳記寫入 -> 回傳 STALE
    const staleData = {
      originalTransactionId: origTxId,
      lastAppleSignedDate: now - 5000,
      status: 'active',
    };
    const staleRes = await redis.eval(
      SAVE_ENTITLEMENT_OCC_LUA,
      [`exam_ai:apple:entitlement:${origTxId}`],
      [JSON.stringify(staleData), String(now - 5000), '86400'],
    );
    assert.strictEqual(staleRes[0], 'STALE');

    // 2. 既有為 revoked 時 active 寫入 -> 回傳 REVOKED_LOCK
    await redis.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      status: 'revoked',
      revocationDate: now,
      lastAppleSignedDate: now,
      environment: 'Sandbox',
    });
    const revLockRes = await redis.eval(
      SAVE_ENTITLEMENT_OCC_LUA,
      [`exam_ai:apple:entitlement:${origTxId}`],
      [JSON.stringify({ status: 'active', purchaseDate: now - 1000 }), String(now + 1000), '86400'],
    );
    assert.strictEqual(revLockRes[0], 'REVOKED_LOCK');
  });

  // ───── TC20：不相關的較新 Apple 交易事件不應阻擋合法的續訂偏好更新 ─────
  await t.test('TC20：續約資訊獨立更新不受舊交易 signedDate 阻擋 (DID_CHANGE_RENEWAL_STATUS)', async () => {
    const origTxId = 'tc20_tx';
    const buyTime = 1729350000000;
    const cancelTime = buyTime + 5000;

    // 初始記錄：交易簽章時間為 buyTime
    await redis.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      lastTransactionId: 'tx_buy',
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      purchaseDate: buyTime,
      lastAppleSignedDate: buyTime,
      lastRenewalSignedDate: buyTime,
      willRenew: true,
      environment: 'Sandbox',
    });

    // DID_CHANGE_RENEWAL_STATUS 通知：其內層 transaction 仍為舊的 buyTime，但 renewalInfo 為 cancelTime
    const syncRes = await applySubscriptionStateToRedis({
      originalTransactionId: origTxId,
      transition: {
        actionable: true,
        action: 'UPDATE_RENEWAL_INFO',
        status: 'active',
        tier: 'pro',
        willRenew: false,
        reason: '使用者關閉續訂',
      },
      verifiedNotification: {
        isValid: true,
        notificationType: 'DID_CHANGE_RENEWAL_STATUS',
        subtype: 'AUTO_RENEW_DISABLED',
        signedDate: cancelTime,
        transaction: {
          signedDate: buyTime, // 舊交易時間戳記
          productId: 'exampro_monthly',
        },
        renewalInfo: {
          signedDate: cancelTime, // 新續約時間戳記
          autoRenewStatus: 0,
        },
      },
      now: cancelTime,
      isDryRun: false,
    });

    assert.strictEqual(syncRes.success, true);

    const record = await getOriginalTransactionEntitlement(origTxId);
    assert.strictEqual(record.willRenew, false);
    assert.strictEqual(record.lastRenewalSignedDate, cancelTime);
  });
});
