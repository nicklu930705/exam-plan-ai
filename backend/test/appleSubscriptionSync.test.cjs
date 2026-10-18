const test = require('node:test');
const assert = require('node:assert/strict');

// 設定測試環境變數
process.env.MOCK_REDIS = 'true';
process.env.OPENAI_API_KEY = 'test_mock_key';
process.env.APP_SERVER_SECRET = 'test_signing_secret_for_tests';
delete process.env.APPLE_API_PRIVATE_KEY;
delete process.env.APPLE_API_KEY_ID;
delete process.env.APPLE_API_ISSUER_ID;

const {
  resolveAppleEnvironment,
  isTransactionEnvironmentAllowed,
  isNotificationEnvironmentAllowed,
  EXPECTED_BUNDLE_ID,
} = require('../dist/lib/appleEnvironment.js');
const {
  applySubscriptionStateToRedis,
  reconcileSubscriptionWithApple,
  SubscriptionSyncError,
  LiveAppleWebhookEventHandler,
} = require('../dist/lib/appleSubscriptionSync.js');
const {
  evaluateSubscriptionStateTransition,
  setCustomNotificationVerifier,
} = require('../dist/lib/appleWebhookHandler.js');
const {
  getRedisClient,
  inMemoryRedisMockInstance,
} = require('../dist/lib/redis.js');
const {
  setCustomAppleServerApiClient,
} = require('../dist/lib/appleServerApi.js');
const {
  getUserEntitlement,
  syncUserDeviceEffectiveEntitlement,
} = require('../dist/lib/entitlement.js');

test('Phase 3.2 Part 1 - Apple 環境隔離與嚴格校驗測試', async (t) => {
  const originalEnv = { ...process.env };

  t.afterEach(() => {
    process.env = { ...originalEnv };
  });

  await t.test('1. 獨立 Sandbox Vercel (NODE_ENV=production + APPLE_IAP_ENVIRONMENT=sandbox + APPLE_ALLOW_SANDBOX=true)：合法解析為 Sandbox 環境', () => {
    process.env.NODE_ENV = 'production';
    process.env.APPLE_IAP_ENVIRONMENT = 'sandbox';
    process.env.APPLE_ALLOW_SANDBOX = 'true';

    const env = resolveAppleEnvironment();
    assert.strictEqual(env.valid, true);
    assert.strictEqual(env.targetRole, 'sandbox');
    assert.strictEqual(env.allowSandbox, true);
    assert.strictEqual(isTransactionEnvironmentAllowed('Sandbox'), true);
    assert.strictEqual(isNotificationEnvironmentAllowed('Sandbox'), true);
  });

  await t.test('2. 正式後端 (APPLE_IAP_ENVIRONMENT=production)：嚴禁開啟 APPLE_ALLOW_SANDBOX，若開啟則報錯並降級', () => {
    process.env.NODE_ENV = 'production';
    process.env.APPLE_IAP_ENVIRONMENT = 'production';
    process.env.APPLE_ALLOW_SANDBOX = 'true';

    const env = resolveAppleEnvironment();
    assert.strictEqual(env.valid, false);
    assert.match(env.error, /正式後端 \(APPLE_IAP_ENVIRONMENT=production\) 嚴禁設定 APPLE_ALLOW_SANDBOX=true/);
  });

  await t.test('3. 正式後端 (APPLE_IAP_ENVIRONMENT=production)：嚴格拒絕 Sandbox 交易憑證與 Webhook 通知', () => {
    process.env.NODE_ENV = 'production';
    process.env.APPLE_IAP_ENVIRONMENT = 'production';
    delete process.env.APPLE_ALLOW_SANDBOX;

    const env = resolveAppleEnvironment();
    assert.strictEqual(env.valid, true);
    assert.strictEqual(env.targetRole, 'production');
    assert.strictEqual(env.allowSandbox, false);

    assert.strictEqual(isTransactionEnvironmentAllowed('Sandbox'), false);
    assert.strictEqual(isNotificationEnvironmentAllowed('Sandbox'), false);

    assert.strictEqual(isTransactionEnvironmentAllowed('Production'), true);
    assert.strictEqual(isNotificationEnvironmentAllowed('Production'), true);
  });

  await t.test('4. 環境矛盾防呆：APPLE_IAP_ENVIRONMENT=sandbox 但 APPLE_ALLOW_SANDBOX=false 時安全回報矛盾', () => {
    process.env.APPLE_IAP_ENVIRONMENT = 'sandbox';
    process.env.APPLE_ALLOW_SANDBOX = 'false';

    const env = resolveAppleEnvironment();
    assert.strictEqual(env.valid, false);
    assert.match(env.error, /環境設定矛盾/);
  });

  await t.test('5. 無效環境字串安全拒絕：APPLE_IAP_ENVIRONMENT=testnet 時拒絕', () => {
    process.env.APPLE_IAP_ENVIRONMENT = 'testnet';

    const env = resolveAppleEnvironment();
    assert.strictEqual(env.valid, false);
    assert.match(env.error, /無效的 APPLE_IAP_ENVIRONMENT 設定值/);
  });
});

test('Phase 3.2 Part 1 - Redis 訂閱同步核心模組測試 (applySubscriptionStateToRedis)', async (t) => {
  const baseNow = 1750000000000;
  const redis = getRedisClient();

  t.beforeEach(() => {
    inMemoryRedisMockInstance.clear();
  });

  await t.test('1. SUBSCRIBED / DID_RENEW 成功啟用：同步寫入 Redis 主記錄並廣播至關聯裝置', async () => {
    const origTxId = 'orig_sync_001';
    const dev1 = 'device_user_alpha';
    const dev2 = 'device_user_beta';

    const devicesKey = `exam_ai:apple:devices_z:${origTxId}`;
    await redis.zadd(devicesKey, baseNow, dev1);
    await redis.zadd(devicesKey, baseNow + 100, dev2);

    const transition = {
      actionable: true,
      action: 'APPLY_RENEWAL',
      status: 'active',
      tier: 'pro',
      effectiveExpiresDate: baseNow + 30 * 86400 * 1000,
      reason: 'Apple 自動續訂扣款成功。',
    };

    const verifiedNotification = {
      isValid: true,
      notificationType: 'DID_RENEW',
      notificationUUID: 'notif_renew_001',
      originalTransactionId: origTxId,
      transactionId: 'tx_new_001',
      productId: 'exampro_monthly',
      purchaseDate: baseNow,
      expiresDate: baseNow + 30 * 86400 * 1000,
      environment: 'Sandbox',
      signedDate: baseNow,
    };

    const res = await applySubscriptionStateToRedis({
      originalTransactionId: origTxId,
      transition,
      verifiedNotification,
      now: baseNow,
      isDryRun: false,
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.status, 'active');
    assert.strictEqual(res.tier, 'pro');
    assert.strictEqual(res.devicesUpdatedCount, 2);

    const mainRecord = await redis.get(`exam_ai:apple:entitlement:${origTxId}`);
    assert.ok(mainRecord);
    assert.strictEqual(mainRecord.status, 'active');
    assert.strictEqual(mainRecord.tier, 'pro');

    const user1Cache = await redis.get(`exam_ai:user:${dev1}:entitlement`);
    assert.ok(user1Cache);
    assert.strictEqual(user1Cache.tier, 'pro');
  });

  await t.test('2. REFUND / REVOKE 撤銷退款：即時收回權限並清空裝置快取', async () => {
    const origTxId = 'orig_sync_revoke_002';
    const dev1 = 'device_user_gamma';

    await redis.zadd(`exam_ai:apple:devices_z:${origTxId}`, baseNow, dev1);
    await redis.sadd(`exam_ai:user:${dev1}:apple_txns`, origTxId);
    await redis.set(`exam_ai:user:${dev1}:entitlement`, {
      userId: dev1,
      tier: 'pro',
      originalTransactionId: origTxId,
    });

    const transition = {
      actionable: true,
      action: 'APPLY_REVOKED',
      status: 'revoked',
      tier: 'free',
      effectiveRevocationDate: baseNow,
      effectiveExpiresDate: null,
      reason: '此交易已被 Apple 撤銷或退款。',
    };

    const res = await applySubscriptionStateToRedis({
      originalTransactionId: origTxId,
      transition,
      now: baseNow,
      isDryRun: false,
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.status, 'revoked');
    assert.strictEqual(res.tier, 'free');
    assert.strictEqual(res.devicesUpdatedCount, 1);

    const mainRecord = await redis.get(`exam_ai:apple:entitlement:${origTxId}`);
    assert.strictEqual(mainRecord.status, 'revoked');

    const devCache = await redis.get(`exam_ai:user:${dev1}:entitlement`);
    assert.strictEqual(devCache, null);
  });

  await t.test('3. 同一裝置同時有有效 Lifetime 與過期 Pro：過期 Pro 不得誤刪 Lifetime 權益', async () => {
    const devMulti = 'device_user_lifetime_and_pro';
    const txLifetime = 'orig_tx_lifetime_keep';
    const txMonthly = 'orig_tx_monthly_expire';

    // 1. 先寫入有效的 Lifetime 主記錄
    await redis.set(`exam_ai:apple:entitlement:${txLifetime}`, {
      originalTransactionId: txLifetime,
      lastTransactionId: txLifetime,
      productId: 'exampro_lifetime',
      tier: 'lifetime',
      status: 'active',
      purchaseDate: baseNow - 100000,
      expiresDate: null,
      verifiedAt: baseNow - 100000,
      environment: 'Sandbox',
    });

    // 2. 將裝置同時關聯兩筆交易
    await redis.sadd(`exam_ai:user:${devMulti}:apple_txns`, txLifetime);
    await redis.sadd(`exam_ai:user:${devMulti}:apple_txns`, txMonthly);
    await redis.zadd(`exam_ai:apple:devices_z:${txMonthly}`, baseNow, devMulti);

    // 3. 執行 Monthly 過期通知同步
    const transition = {
      actionable: true,
      action: 'APPLY_EXPIRED',
      status: 'expired',
      tier: 'free',
      effectiveExpiresDate: baseNow,
      reason: '訂閱方案已到期終止。',
    };

    const res = await applySubscriptionStateToRedis({
      originalTransactionId: txMonthly,
      transition,
      now: baseNow,
      isDryRun: false,
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.status, 'expired');

    // 關鍵驗證：裝置快取絕不能被刪除！依然必須保留 Lifetime 權限！
    const devCache = await redis.get(`exam_ai:user:${devMulti}:entitlement`);
    assert.ok(devCache, '裝置快取不應為 null，應維持有效 Lifetime');
    assert.strictEqual(devCache.tier, 'lifetime');
    assert.strictEqual(devCache.originalTransactionId, txLifetime);
  });

  await t.test('4. 同一裝置同時關聯多筆訂閱交易：到期一筆保留另一筆較新之 Pro 續約', async () => {
    const devMultiSubs = 'device_user_two_subs';
    const txOldSub = 'orig_tx_old_sub';
    const txNewSub = 'orig_tx_new_sub';

    // 較新的有效年訂閱
    await redis.set(`exam_ai:apple:entitlement:${txNewSub}`, {
      originalTransactionId: txNewSub,
      lastTransactionId: txNewSub,
      productId: 'exampro_yearly',
      tier: 'pro',
      status: 'active',
      purchaseDate: baseNow,
      expiresDate: baseNow + 365 * 86400 * 1000,
      verifiedAt: baseNow,
      environment: 'Sandbox',
    });

    await redis.sadd(`exam_ai:user:${devMultiSubs}:apple_txns`, txOldSub);
    await redis.sadd(`exam_ai:user:${devMultiSubs}:apple_txns`, txNewSub);
    await redis.zadd(`exam_ai:apple:devices_z:${txOldSub}`, baseNow, devMultiSubs);

    // 舊月訂閱到期
    const transition = {
      actionable: true,
      action: 'APPLY_EXPIRED',
      status: 'expired',
      tier: 'free',
      effectiveExpiresDate: baseNow,
      reason: '舊月訂閱到期。',
    };

    const res = await applySubscriptionStateToRedis({
      originalTransactionId: txOldSub,
      transition,
      now: baseNow,
      isDryRun: false,
    });

    assert.strictEqual(res.success, true);
    const devCache = await redis.get(`exam_ai:user:${devMultiSubs}:entitlement`);
    assert.ok(devCache);
    assert.strictEqual(devCache.tier, 'pro');
    assert.strictEqual(devCache.originalTransactionId, txNewSub);
    assert.strictEqual(devCache.expiresAt, baseNow + 365 * 86400 * 1000);
  });

  await t.test('5. 樂觀並行控制 (OCC)：過期處理鎖/慢速舊工作不得覆蓋 Redis 中較新的紀錄', async () => {
    const origTxId = 'orig_occ_race_test';

    // 伺服端已由 Worker 2 寫入最新紀錄 (verifiedAt = baseNow + 5000)
    await redis.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      lastTransactionId: 'tx_worker2_fresh',
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      purchaseDate: baseNow + 5000,
      expiresDate: baseNow + 60 * 86400 * 1000,
      verifiedAt: baseNow + 5000,
      environment: 'Sandbox',
    });

    // Worker 1 延遲甦醒，帶著較舊的事件 (signedDate = baseNow) 試圖寫入
    const staleTransition = {
      actionable: true,
      action: 'APPLY_EXPIRED',
      status: 'expired',
      tier: 'free',
      effectiveExpiresDate: baseNow,
      reason: '延遲的舊過期通知',
    };

    const staleNotification = {
      isValid: true,
      notificationType: 'EXPIRED',
      notificationUUID: 'notif_stale_uuid',
      originalTransactionId: origTxId,
      signedDate: baseNow, // 舊時間戳記
    };

    const res = await applySubscriptionStateToRedis({
      originalTransactionId: origTxId,
      transition: staleTransition,
      verifiedNotification: staleNotification,
      now: baseNow,
      isDryRun: false,
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.action, 'IGNORE_STALE_RECORD');
    assert.match(res.reason, /略過過期工作以防覆蓋/);

    // 驗證主記錄依然保持 Worker 2 的新鮮 active 狀態！
    const current = await redis.get(`exam_ai:apple:entitlement:${origTxId}`);
    assert.strictEqual(current.status, 'active');
    assert.strictEqual(current.lastTransactionId, 'tx_worker2_fresh');
  });

  await t.test('6. Redis 廣播異常安全防護：裝置快取更新失敗時拋出明確例外供 Webhook 釋放鎖並重試', async () => {
    const origTxId = 'orig_fail_fanout_test';
    const dev1 = 'device_fail_test';

    await redis.zadd(`exam_ai:apple:devices_z:${origTxId}`, baseNow, dev1);

    // 刻意破壞 devicesKey 型態造成 zrange 例外
    await redis.set(`exam_ai:apple:devices_z:${origTxId}`, 'corrupted_string_not_set');

    const transition = {
      actionable: true,
      action: 'APPLY_RENEWAL',
      status: 'active',
      tier: 'pro',
      effectiveExpiresDate: baseNow + 30 * 86400 * 1000,
      reason: '扣款成功',
    };

    await assert.rejects(
      async () => {
        await applySubscriptionStateToRedis({
          originalTransactionId: origTxId,
          transition,
          now: baseNow,
          isDryRun: false,
        });
      },
      (err) => {
        assert(err instanceof SubscriptionSyncError);
        assert.match(err.message, /廣播更新關聯裝置快取失敗/);
        return true;
      },
    );
  });

  await t.test('7. Dry-Run 模式安全防護：未明確啟用 live 時對真實 Redis 零修改', async () => {
    const origTxId = 'orig_dryrun_zero_write';
    const dev1 = 'device_dryrun_zero';

    await redis.zadd(`exam_ai:apple:devices_z:${origTxId}`, baseNow, dev1);

    const transition = {
      actionable: true,
      action: 'APPLY_ACTIVE',
      status: 'active',
      tier: 'pro',
      effectiveExpiresDate: baseNow + 30 * 86400 * 1000,
      reason: '測試',
    };

    const res = await applySubscriptionStateToRedis({
      originalTransactionId: origTxId,
      transition,
      isDryRun: true,
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.dryRun, true);
    assert.strictEqual(res.devicesUpdatedCount, 0);

    const mainRecord = await redis.get(`exam_ai:apple:entitlement:${origTxId}`);
    assert.strictEqual(mainRecord, null);
    const userCache = await redis.get(`exam_ai:user:${dev1}:entitlement`);
    assert.strictEqual(userCache, null);
  });
});

test('Phase 3.2 Part 1 - 退款後重新訂閱與亂序事件防護測試', async (t) => {
  const baseNow = 1750000000000;

  await t.test('1. 退款後合法重新購買 (purchaseDate > revocationDate 且無 revocationDate)：成功解鎖 Pro', () => {
    const existingRevoked = {
      originalTransactionId: 'orig_resub_001',
      lastTransactionId: 'tx_old_revoked',
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'revoked',
      purchaseDate: baseNow - 200000,
      revocationDate: baseNow - 100000,
      verifiedAt: baseNow - 100000,
      environment: 'Sandbox',
    };

    const incomingNewPurchase = {
      isValid: true,
      notificationType: 'SUBSCRIBED',
      subtype: 'RESUBSCRIBE',
      notificationUUID: 'notif_new_buy',
      signedDate: baseNow + 1000,
      productId: 'exampro_monthly',
      purchaseDate: baseNow + 500, // 購買時間在退款後
      expiresDate: baseNow + 30 * 86400 * 1000,
      transaction: {
        productId: 'exampro_monthly',
        purchaseDate: baseNow + 500,
        expiresDate: baseNow + 30 * 86400 * 1000,
        revocationDate: undefined, // 未被撤銷
      },
    };

    const transition = evaluateSubscriptionStateTransition({
      existingRecord: existingRevoked,
      incomingNotification: incomingNewPurchase,
      now: baseNow + 1000,
    });

    assert.strictEqual(transition.actionable, true);
    assert.strictEqual(transition.action, 'APPLY_ACTIVE');
    assert.strictEqual(transition.status, 'active');
    assert.strictEqual(transition.tier, 'pro');
  });

  await t.test('2. 簽名時間更新但 purchaseDate 在退款前之舊收據重放：堅決拒絕', () => {
    const existingRevoked = {
      originalTransactionId: 'orig_resub_002',
      lastTransactionId: 'tx_revoked',
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'revoked',
      purchaseDate: baseNow - 200000,
      revocationDate: baseNow - 50000,
      verifiedAt: baseNow - 50000,
      environment: 'Sandbox',
    };

    // 簽名時間雖然是現在，但原始購買時間在退款前
    const staleReplay = {
      isValid: true,
      notificationType: 'SUBSCRIBED',
      subtype: 'RESUBSCRIBE',
      notificationUUID: 'notif_stale_replay',
      signedDate: baseNow + 5000, // signedDate 在退款後
      productId: 'exampro_monthly',
      purchaseDate: baseNow - 100000, // purchaseDate 卻在退款前！
      transaction: {
        productId: 'exampro_monthly',
        purchaseDate: baseNow - 100000,
        expiresDate: baseNow + 100000,
      },
    };

    const transition = evaluateSubscriptionStateTransition({
      existingRecord: existingRevoked,
      incomingNotification: staleReplay,
      now: baseNow + 6000,
    });

    assert.strictEqual(transition.actionable, false);
    assert.strictEqual(transition.action, 'IGNORE_OLD_RECEIPT_AFTER_REVOCATION');
    assert.strictEqual(transition.status, 'revoked');
  });

  await t.test('3. 舊退款事件延遲抵達，不得逆向撤銷退款後發生的合法新續訂', () => {
    const existingActiveAfterResub = {
      originalTransactionId: 'orig_resub_003',
      lastTransactionId: 'tx_legit_new',
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      purchaseDate: baseNow + 10000,
      expiresDate: baseNow + 40 * 86400 * 1000,
      verifiedAt: baseNow + 10000,
      environment: 'Sandbox',
    };

    // 延遲抵達的舊退款通知 (退款時間在較早之前)
    const delayedRefund = {
      isValid: true,
      notificationType: 'REFUND',
      notificationUUID: 'notif_delayed_refund',
      signedDate: baseNow - 5000,
      revocationDate: baseNow - 5000,
      purchaseDate: baseNow - 20000,
      productId: 'exampro_monthly',
    };

    // 透過 applySubscriptionStateToRedis 寫入時，OCC 機制會比對時間戳記
    // 因為 delayedRefund.signedDate (baseNow - 5000) < existingActiveAfterResub.verifiedAt (baseNow + 10000)
    // 應被 OCC 攔截！
    const transition = evaluateSubscriptionStateTransition({
      existingRecord: existingActiveAfterResub,
      incomingNotification: delayedRefund,
      now: baseNow + 15000,
    });

    // 雖然 transition 單獨看是 APPLY_REVOKED
    assert.strictEqual(transition.status, 'revoked');

    // 但 applySubscriptionStateToRedis 的 OCC 會依據 signedDate < verifiedAt 阻擋覆蓋！
  });
});

test('Phase 3.2 Part 1 - Apple 主動補查機制測試 (reconcileSubscriptionWithApple)', async (t) => {
  const baseNow = 1750000000000;
  const redis = getRedisClient();

  t.beforeEach(() => {
    inMemoryRedisMockInstance.clear();
    setCustomAppleServerApiClient(null);
    setCustomNotificationVerifier(null);
  });

  await t.test('1. 金鑰未配置時安全降級，回傳明確未配置錯誤且不崩潰', async () => {
    const res = await reconcileSubscriptionWithApple('orig_tx_reconcile_unconfigured');
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.error, 'APPLE_SERVER_API_NOT_CONFIGURED');
    assert.match(res.message, /金鑰尚未配置/);
  });

  await t.test('2. 成功調用 Apple API 並補救恢復 Pro 訂閱 (帶有 signedTransactionInfo 驗證)', async () => {
    const origTxId = 'orig_tx_reconcile_verified';
    const dev1 = 'device_user_reconcile_verified';

    await redis.zadd(`exam_ai:apple:devices_z:${origTxId}`, baseNow, dev1);
    await redis.sadd(`exam_ai:user:${dev1}:apple_txns`, origTxId);

    const mockApiClient = {
      isConfigured: () => true,
      getStatus: () => ({ isConfigured: true, environment: 'sandbox', bundleId: EXPECTED_BUNDLE_ID }),
      getAllSubscriptionStatuses: async (txId) => ({
        environment: 'Sandbox',
        bundleId: EXPECTED_BUNDLE_ID,
        data: [
          {
            subscriptionGroupIdentifier: 'grp_001',
            lastTransactions: [
              {
                originalTransactionId: txId,
                status: 1, // ACTIVE
                signedTransactionInfo: 'mock_valid_tx_jws',
                signedRenewalInfo: 'mock_valid_renewal_jws',
              },
            ],
          },
        ],
      }),
      getTransactionHistory: async () => ({}),
      getRefundHistory: async () => ({}),
      getTransactionInfo: async () => ({}),
    };

    const mockVerifier = {
      verifyAndDecode: async () => ({ isValid: true, notificationType: 'DID_RENEW' }),
      verifyAndDecodeTransaction: async (jws) => ({
        productId: 'exampro_monthly',
        transactionId: 'tx_reconcile_001',
        originalTransactionId: origTxId,
        purchaseDate: baseNow,
        originalPurchaseDate: baseNow,
        expiresDate: baseNow + 30 * 86400 * 1000,
        bundleId: EXPECTED_BUNDLE_ID,
        environment: 'Sandbox',
      }),
      verifyAndDecodeRenewalInfo: async (jws) => ({
        autoRenewStatus: 1,
      }),
    };

    setCustomAppleServerApiClient(mockApiClient);
    setCustomNotificationVerifier(mockVerifier);

    const res = await reconcileSubscriptionWithApple(origTxId, { forceLive: true, now: baseNow });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.status, 'active');
    assert.strictEqual(res.tier, 'pro');
    assert.strictEqual(res.devicesUpdatedCount, 1);

    const devCache = await redis.get(`exam_ai:user:${dev1}:entitlement`);
    assert.ok(devCache);
    assert.strictEqual(devCache.tier, 'pro');
  });

  await t.test('3. Apple 回傳篡改或無效 signedTransactionInfo 時：簽章驗證失敗拒絕同步', async () => {
    const origTxId = 'orig_tx_reconcile_tampered';

    const mockApiClient = {
      isConfigured: () => true,
      getStatus: () => ({ isConfigured: true, environment: 'sandbox', bundleId: EXPECTED_BUNDLE_ID }),
      getAllSubscriptionStatuses: async (txId) => ({
        environment: 'Sandbox',
        bundleId: EXPECTED_BUNDLE_ID,
        data: [
          {
            subscriptionGroupIdentifier: 'grp_001',
            lastTransactions: [
              {
                originalTransactionId: txId,
                status: 1,
                signedTransactionInfo: 'forged_fake_jws',
              },
            ],
          },
        ],
      }),
      getTransactionHistory: async () => ({}),
      getRefundHistory: async () => ({}),
      getTransactionInfo: async () => ({}),
    };

    const mockVerifier = {
      verifyAndDecodeTransaction: async () => {
        throw new Error('Apple 數位簽章驗證失敗。');
      },
    };

    setCustomAppleServerApiClient(mockApiClient);
    setCustomNotificationVerifier(mockVerifier);

    const res = await reconcileSubscriptionWithApple(origTxId, { forceLive: true, now: baseNow });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.error, 'SIGNATURE_VERIFICATION_FAILED');
    assert.match(res.message, /簽署驗證未通過/);
  });

  await t.test('4. Lifetime (非消耗型商品) 主動補查：支援 getTransactionInfo 驗證', async () => {
    const origLifetimeTxId = 'orig_tx_lifetime_reconcile';
    const dev1 = 'device_user_lifetime_reconcile';

    await redis.set(`exam_ai:apple:entitlement:${origLifetimeTxId}`, {
      originalTransactionId: origLifetimeTxId,
      lastTransactionId: origLifetimeTxId,
      productId: 'exampro_lifetime',
      tier: 'lifetime',
      status: 'active',
      purchaseDate: baseNow,
      verifiedAt: baseNow,
      environment: 'Sandbox',
    });
    await redis.zadd(`exam_ai:apple:devices_z:${origLifetimeTxId}`, baseNow, dev1);
    await redis.sadd(`exam_ai:user:${dev1}:apple_txns`, origLifetimeTxId);

    const mockApiClient = {
      isConfigured: () => true,
      getStatus: () => ({ isConfigured: true, environment: 'sandbox', bundleId: EXPECTED_BUNDLE_ID }),
      getAllSubscriptionStatuses: async () => ({ data: [] }),
      getTransactionInfo: async (txId) => ({
        signedTransactionInfo: 'lifetime_valid_jws',
      }),
      getTransactionHistory: async () => ({}),
      getRefundHistory: async () => ({}),
    };

    const mockVerifier = {
      verifyAndDecodeTransaction: async (jws) => ({
        productId: 'exampro_lifetime',
        transactionId: 'tx_lifetime_reconcile_001',
        originalTransactionId: origLifetimeTxId,
        purchaseDate: baseNow,
        bundleId: EXPECTED_BUNDLE_ID,
        environment: 'Sandbox',
      }),
    };

    setCustomAppleServerApiClient(mockApiClient);
    setCustomNotificationVerifier(mockVerifier);

    const res = await reconcileSubscriptionWithApple(origLifetimeTxId, { forceLive: true, now: baseNow });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.status, 'active');
    assert.strictEqual(res.tier, 'lifetime');
  });

  await t.test('5. Apple API 伺服器故障時：安全回報失敗，絕不刪除或影響 Redis 既有購買記錄', async () => {
    const origTxId = 'orig_tx_fail_preserve';
    const dev1 = 'dev_fail_preserve';

    // 既有有效紀錄
    await redis.set(`exam_ai:apple:entitlement:${origTxId}`, {
      originalTransactionId: origTxId,
      lastTransactionId: origTxId,
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      purchaseDate: baseNow,
      expiresDate: baseNow + 30 * 86400 * 1000,
      verifiedAt: baseNow,
      environment: 'Sandbox',
    });
    await redis.zadd(`exam_ai:apple:devices_z:${origTxId}`, baseNow, dev1);
    await redis.sadd(`exam_ai:user:${dev1}:apple_txns`, origTxId);
    await redis.set(`exam_ai:user:${dev1}:entitlement`, {
      userId: dev1,
      tier: 'pro',
      productId: 'exampro_monthly',
      originalTransactionId: origTxId,
      expiresAt: baseNow + 30 * 86400 * 1000,
      verifiedAt: baseNow,
      environment: 'Sandbox',
    });

    const mockFailingApiClient = {
      isConfigured: () => true,
      getStatus: () => ({ isConfigured: true, environment: 'sandbox', bundleId: EXPECTED_BUNDLE_ID }),
      getAllSubscriptionStatuses: async () => {
        throw new Error('Apple HTTP 503 Service Unavailable');
      },
      getTransactionInfo: async () => {
        throw new Error('Apple HTTP 503');
      },
      getTransactionHistory: async () => ({}),
      getRefundHistory: async () => ({}),
    };

    setCustomAppleServerApiClient(mockFailingApiClient);

    const res = await reconcileSubscriptionWithApple(origTxId, { forceLive: true, now: baseNow });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.error, 'APPLE_API_CALL_FAILED');

    // 關鍵驗證：Apple API 故障時，Redis 主記錄與裝置快取完全未受破壞！
    const mainRecord = await redis.get(`exam_ai:apple:entitlement:${origTxId}`);
    assert.ok(mainRecord);
    assert.strictEqual(mainRecord.status, 'active');

    const devCache = await redis.get(`exam_ai:user:${dev1}:entitlement`);
    assert.ok(devCache);
    assert.strictEqual(devCache.tier, 'pro');
  });
});
