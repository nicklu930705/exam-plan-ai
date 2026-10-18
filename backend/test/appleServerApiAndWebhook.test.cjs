const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// 設定測試環境變數
process.env.MOCK_REDIS = 'true';
process.env.OPENAI_API_KEY = 'test_mock_key';
process.env.APP_SERVER_SECRET = 'test_signing_secret_for_tests';
delete process.env.APPLE_API_PRIVATE_KEY;
delete process.env.APPLE_API_KEY_ID;
delete process.env.APPLE_API_ISSUER_ID;

const webhookApiModule = require('../dist/api/apple-webhook.js');
const verifyTxModule = require('../dist/api/verify-transaction.js');
const {
  getAppleServerApiClient,
  setCustomAppleServerApiClient,
  AppleServerApiClientWrapper,
  AppleServerApiNotConfiguredError,
} = require('../dist/lib/appleServerApi.js');
const {
  AppleNotificationVerifier,
  setCustomNotificationVerifier,
  acquireWebhookIdempotency,
  completeWebhookIdempotency,
  releaseWebhookIdempotency,
  evaluateSubscriptionStateTransition,
  setCustomAppleWebhookEventHandler,
  getAppleWebhookEventHandler,
  DryRunAppleWebhookEventHandler,
} = require('../dist/lib/appleWebhookHandler.js');
const {
  inMemoryRedisMockInstance,
} = require('../dist/lib/redis.js');
const {
  EXPECTED_BUNDLE_ID,
  EXPECTED_APP_APPLE_ID,
} = require('../dist/lib/appleIap.js');

const webhookHandler = typeof webhookApiModule === 'function' ? webhookApiModule : webhookApiModule.default;
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
      if (req.url && req.url.startsWith('/api/apple-webhook')) {
        await webhookHandler(req, res);
      } else if (req.url && req.url.startsWith('/api/verify-transaction')) {
        await verifyHandler(req, res);
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

async function postJson(baseUrl, path, body, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

test('Apple App Store Server API 客戶端封裝與安全降級測試', async (t) => {
  t.beforeEach(() => {
    setCustomAppleServerApiClient(null);
    delete process.env.APPLE_API_PRIVATE_KEY;
    delete process.env.APPLE_API_KEY_ID;
    delete process.env.APPLE_API_ISSUER_ID;
  });

  await t.test('1. 金鑰未配置時安全降級：isConfigured 回傳 false，調用主動查詢拋出安全錯誤且不崩潰', async () => {
    const client = new AppleServerApiClientWrapper();
    assert.strictEqual(client.isConfigured(), false);
    const status = client.getStatus();
    assert.strictEqual(status.isConfigured, false);
    assert.match(status.reason, /缺少必要之環境變數/);

    // 呼叫 API 方法應拋出 AppleServerApiNotConfiguredError
    await assert.rejects(
      async () => {
        await client.getAllSubscriptionStatuses('orig_tx_123');
      },
      (err) => {
        assert(err instanceof AppleServerApiNotConfiguredError);
        assert.match(err.message, /缺少必要之環境變數/);
        return true;
      },
    );
  });

  await t.test('2. 環境動態選擇：APPLE_IAP_ENVIRONMENT=sandbox 時正確識別為 sandbox 環境', async () => {
    process.env.APPLE_IAP_ENVIRONMENT = 'sandbox';
    const client = new AppleServerApiClientWrapper();
    const status = client.getStatus();
    assert.strictEqual(status.environment, 'sandbox');
    delete process.env.APPLE_IAP_ENVIRONMENT;
  });

  await t.test('3. 環境矛盾檢查：APPLE_IAP_ENVIRONMENT=sandbox 且 APPLE_ALLOW_SANDBOX=false 時安全拒絕', async () => {
    process.env.APPLE_IAP_ENVIRONMENT = 'sandbox';
    process.env.APPLE_ALLOW_SANDBOX = 'false';
    const client = new AppleServerApiClientWrapper();
    assert.strictEqual(client.isConfigured(), false);
    const status = client.getStatus();
    assert.match(status.reason, /環境設定矛盾/);
    delete process.env.APPLE_IAP_ENVIRONMENT;
    delete process.env.APPLE_ALLOW_SANDBOX;
  });

  await t.test('4. 無效環境字串檢查：APPLE_IAP_ENVIRONMENT=staging 時安全拒絕', async () => {
    process.env.APPLE_IAP_ENVIRONMENT = 'staging';
    const client = new AppleServerApiClientWrapper();
    assert.strictEqual(client.isConfigured(), false);
    const status = client.getStatus();
    assert.match(status.reason, /無效的 APPLE_IAP_ENVIRONMENT/);
    delete process.env.APPLE_IAP_ENVIRONMENT;
  });

  await t.test('5. 測試注入 Mock Client：能夠自訂回傳訂閱與退款資料', async () => {
    const mockClient = {
      isConfigured: () => true,
      getStatus: () => ({ isConfigured: true, environment: 'sandbox', bundleId: EXPECTED_BUNDLE_ID }),
      getAllSubscriptionStatuses: async (txId) => ({
        environment: 'Sandbox',
        appAppleId: EXPECTED_APP_APPLE_ID,
        bundleId: EXPECTED_BUNDLE_ID,
        data: [{ subscriptionGroupIdentifier: 'grp_1', lastTransactions: [] }],
      }),
      getTransactionHistory: async () => ({}),
      getRefundHistory: async () => ({ hasMore: false, signedTransactions: [] }),
      getTransactionInfo: async () => ({}),
    };

    setCustomAppleServerApiClient(mockClient);
    const active = getAppleServerApiClient();
    assert.strictEqual(active.isConfigured(), true);
    const res = await active.getAllSubscriptionStatuses('test_tx_888');
    assert.strictEqual(res.environment, 'Sandbox');
  });
});

test('Apple Server Notifications V2 冪等狀態機測試 (notificationUUID)', async (t) => {
  t.beforeEach(() => {
    inMemoryRedisMockInstance.clear();
  });

  await t.test('1. 新通知取得 processing 鎖，重複通知正確識別狀態', async () => {
    const uuid = 'notif_uuid_001';

    // 第一次取得：成功 (new)
    const res1 = await acquireWebhookIdempotency(uuid);
    assert.strictEqual(res1.acquired, true);
    assert.strictEqual(res1.state, 'new');

    // 第二次並行取得：被擋下 (processing)
    const res2 = await acquireWebhookIdempotency(uuid);
    assert.strictEqual(res2.acquired, false);
    assert.strictEqual(res2.state, 'processing');

    // 處理完成：標記 completed
    await completeWebhookIdempotency(uuid);

    // 第三次再進來：命中 completed
    const res3 = await acquireWebhookIdempotency(uuid);
    assert.strictEqual(res3.acquired, false);
    assert.strictEqual(res3.state, 'completed');
  });

  await t.test('2. 處理失敗安全重試：釋放 processing 鎖後允許重新進入', async () => {
    const uuid = 'notif_uuid_fail_and_retry';

    // 第一次取得鎖
    const res1 = await acquireWebhookIdempotency(uuid);
    assert.strictEqual(res1.acquired, true);

    // 模擬處理時發生資料庫異常或網路逾時，調用釋放
    await releaseWebhookIdempotency(uuid);

    // 釋放後，Apple 進行重試，應能再次成功取得鎖
    const res2 = await acquireWebhookIdempotency(uuid);
    assert.strictEqual(res2.acquired, true);
    assert.strictEqual(res2.state, 'new');
  });
});

test('Apple 訂閱事件狀態轉換規則引擎 (順序顛倒與防舊覆蓋新)', async (t) => {
  const baseNow = 1750000000000;

  await t.test('1. 退款後合法新購買 (RESUBSCRIBE)：舊退款不得鎖死後續新訂閱', () => {
    const existingRevoked = {
      originalTransactionId: 'orig_sub_100',
      lastTransactionId: 'tx_old_100',
      productId: 'exampro_monthly',
      tier: 'lifetime',
      status: 'revoked',
      purchaseDate: baseNow - 200000,
      revocationDate: baseNow - 100000,
      verifiedAt: baseNow - 100000,
      environment: 'Sandbox',
    };

    // 使用者在退款後重新訂閱
    const incomingResubscribe = {
      isValid: true,
      notificationType: 'SUBSCRIBED',
      subtype: 'RESUBSCRIBE',
      notificationUUID: 'uuid_new_sub',
      signedDate: baseNow + 1000,
      productId: 'exampro_monthly',
      purchaseDate: baseNow + 1000,
      expiresDate: baseNow + 30 * 86400 * 1000,
      transaction: {
        productId: 'exampro_monthly',
        purchaseDate: baseNow + 1000,
        expiresDate: baseNow + 30 * 86400 * 1000,
      },
    };

    const result = evaluateSubscriptionStateTransition({
      existingRecord: existingRevoked,
      incomingNotification: incomingResubscribe,
      now: baseNow + 2000,
    });

    assert.strictEqual(result.actionable, true);
    assert.strictEqual(result.action, 'APPLY_ACTIVE');
    assert.strictEqual(result.status, 'active');
    assert.strictEqual(result.tier, 'pro');
  });

  await t.test('2. 舊收據重放防護：退款前之舊 JWS 不得逆向覆蓋已退款狀態', () => {
    const existingRevoked = {
      originalTransactionId: 'orig_sub_100',
      lastTransactionId: 'tx_old_100',
      productId: 'exampro_monthly',
      tier: 'lifetime',
      status: 'revoked',
      purchaseDate: baseNow - 200000,
      revocationDate: baseNow - 50000,
      verifiedAt: baseNow - 50000,
      environment: 'Sandbox',
    };

    // 舊收據的 purchaseDate 在退款前
    const incomingOldActive = {
      isValid: true,
      notificationType: 'DID_RENEW',
      notificationUUID: 'uuid_old_jws',
      signedDate: baseNow - 100000,
      productId: 'exampro_monthly',
      purchaseDate: baseNow - 100000,
      expiresDate: baseNow + 100000,
      transaction: {
        productId: 'exampro_monthly',
        purchaseDate: baseNow - 100000,
        expiresDate: baseNow + 100000,
      },
    };

    const result = evaluateSubscriptionStateTransition({
      existingRecord: existingRevoked,
      incomingNotification: incomingOldActive,
      now: baseNow,
    });

    assert.strictEqual(result.actionable, false);
    assert.strictEqual(result.action, 'IGNORE_OLD_RECEIPT_AFTER_REVOCATION');
    assert.strictEqual(result.status, 'revoked');
    assert.strictEqual(result.tier, 'free');
  });

  await t.test('3. 亂序過期通知保護：舊 EXPIRED 通知不得降級較新的有效續訂', () => {
    // 伺服端已記錄較新的續訂 (有效至 Day 60)
    const existingActiveRenewal = {
      originalTransactionId: 'orig_sub_200',
      lastTransactionId: 'tx_renew_200',
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      purchaseDate: baseNow,
      expiresDate: baseNow + 60 * 86400 * 1000,
      verifiedAt: baseNow + 1000,
      environment: 'Sandbox',
    };

    // 收到延遲抵達的舊 EXPIRED 通知 (到期日為 Day 30)
    const incomingStaleExpired = {
      isValid: true,
      notificationType: 'EXPIRED',
      subtype: 'VOLUNTARY',
      notificationUUID: 'uuid_stale_expired',
      signedDate: baseNow - 500,
      productId: 'exampro_monthly',
      expiresDate: baseNow + 30 * 86400 * 1000,
      transaction: {
        productId: 'exampro_monthly',
        expiresDate: baseNow + 30 * 86400 * 1000,
      },
    };

    const result = evaluateSubscriptionStateTransition({
      existingRecord: existingActiveRenewal,
      incomingNotification: incomingStaleExpired,
      now: baseNow + 2000,
    });

    assert.strictEqual(result.actionable, false);
    assert.strictEqual(result.action, 'IGNORE_OUT_OF_ORDER');
    assert.strictEqual(result.status, 'active');
    assert.strictEqual(result.tier, 'pro');
  });

  await t.test('4. 取消續約事件 (DID_CHANGE_RENEWAL_STATUS)：維持有效 Pro 至到期日，不提前終止', () => {
    const existingActive = {
      originalTransactionId: 'orig_sub_300',
      lastTransactionId: 'tx_300',
      productId: 'exampro_yearly',
      tier: 'pro',
      status: 'active',
      purchaseDate: baseNow,
      expiresDate: baseNow + 365 * 86400 * 1000,
      verifiedAt: baseNow,
      environment: 'Sandbox',
    };

    const incomingCancelled = {
      isValid: true,
      notificationType: 'DID_CHANGE_RENEWAL_STATUS',
      subtype: 'AUTO_RENEW_DISABLED',
      notificationUUID: 'uuid_turn_off_renew',
      signedDate: baseNow + 10000,
      productId: 'exampro_yearly',
      renewalInfo: {
        autoRenewStatus: 0,
      },
    };

    const result = evaluateSubscriptionStateTransition({
      existingRecord: existingActive,
      incomingNotification: incomingCancelled,
      now: baseNow + 20000,
    });

    assert.strictEqual(result.actionable, true);
    assert.strictEqual(result.action, 'UPDATE_RENEWAL_INFO');
    assert.strictEqual(result.status, 'active');
    assert.strictEqual(result.tier, 'pro');
    assert.strictEqual(result.willRenew, false);
  });

  await t.test('5. 寬限期扣款失敗 (DID_FAIL_TO_RENEW)：處於寬限期內時保留 Pro 資格', () => {
    const existingActive = {
      originalTransactionId: 'orig_sub_400',
      lastTransactionId: 'tx_400',
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'active',
      purchaseDate: baseNow - 30 * 86400 * 1000,
      expiresDate: baseNow + 5 * 86400 * 1000,
      verifiedAt: baseNow,
      environment: 'Sandbox',
    };

    const incomingGrace = {
      isValid: true,
      notificationType: 'DID_FAIL_TO_RENEW',
      subtype: 'GRACE_PERIOD',
      notificationUUID: 'uuid_grace_period',
      productId: 'exampro_monthly',
      rawPayload: {
        data: { status: 4 },
      },
    };

    const result = evaluateSubscriptionStateTransition({
      existingRecord: existingActive,
      incomingNotification: incomingGrace,
      now: baseNow,
    });

    assert.strictEqual(result.actionable, true);
    assert.strictEqual(result.status, 'active');
    assert.strictEqual(result.tier, 'pro');
  });

  await t.test('6. 退款通知 (REFUND)：立即標記 revoked，降為 free 權限', () => {
    const existingActive = {
      originalTransactionId: 'orig_sub_500',
      lastTransactionId: 'tx_500',
      productId: 'exampro_lifetime',
      tier: 'lifetime',
      status: 'active',
      purchaseDate: baseNow,
      verifiedAt: baseNow,
      environment: 'Sandbox',
    };

    const incomingRefund = {
      isValid: true,
      notificationType: 'REFUND',
      notificationUUID: 'uuid_refund_event',
      productId: 'exampro_lifetime',
      signedDate: baseNow + 5000,
      revocationDate: baseNow + 5000,
    };

    const result = evaluateSubscriptionStateTransition({
      existingRecord: existingActive,
      incomingNotification: incomingRefund,
      now: baseNow + 6000,
    });

    assert.strictEqual(result.actionable, true);
    assert.strictEqual(result.action, 'APPLY_REVOKED');
    assert.strictEqual(result.status, 'revoked');
    assert.strictEqual(result.tier, 'free');
  });
});

test('Apple Webhook 端點 HTTP API 完整整合測試 (POST /api/apple-webhook)', async (t) => {
  let serverInstance;
  let baseUrl;

  t.before(async () => {
    serverInstance = await createTestServer();
    baseUrl = serverInstance.baseUrl;
  });

  t.after(async () => {
    if (serverInstance) {
      await serverInstance.close();
    }
  });

  t.beforeEach(() => {
    inMemoryRedisMockInstance.clear();
    setCustomNotificationVerifier(null);
    setCustomAppleWebhookEventHandler(null);
  });

  await t.test('1. 僅允許 POST 方法，GET 請求回傳 405 Method Not Allowed', async () => {
    const res = await fetch(`${baseUrl}/api/apple-webhook`, { method: 'GET' });
    assert.strictEqual(res.status, 405);
    const json = await res.json();
    assert.strictEqual(json.code, 'METHOD_NOT_ALLOWED');
  });

  await t.test('2. 缺少 signedPayload 時回傳 400 Bad Request', async () => {
    const res = await postJson(baseUrl, '/api/apple-webhook', {});
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.code, 'MISSING_SIGNED_PAYLOAD');
  });

  await t.test('3. 偽造或未通過驗證之 Apple 通知：400 拒絕，絕不寫入或賦予會員權限', async () => {
    const mockVerifier = {
      verifyAndDecode: async () => ({
        isValid: false,
        notificationType: 'INVALID',
        notificationUUID: '',
        errorMessage: 'Apple 通知數位簽章驗證失敗。',
      }),
    };
    setCustomNotificationVerifier(mockVerifier);

    const res = await postJson(baseUrl, '/api/apple-webhook', {
      signedPayload: 'fake_forged_jws_payload',
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.code, 'INVALID_NOTIFICATION');
    assert.match(res.data.error, /數位簽章驗證失敗/);
  });

  await t.test('4. 合法通知且為 Phase 3.1 乾跑模式：200 處理成功並記錄 completed', async () => {
    const notifUUID = 'test_valid_uuid_999';
    const mockVerifier = {
      verifyAndDecode: async () => ({
        isValid: true,
        notificationType: 'DID_RENEW',
        notificationUUID: notifUUID,
        bundleId: EXPECTED_BUNDLE_ID,
        productId: 'exampro_monthly',
        expiresDate: Date.now() + 30 * 86400 * 1000,
      }),
    };
    setCustomNotificationVerifier(mockVerifier);

    const res1 = await postJson(baseUrl, '/api/apple-webhook', {
      signedPayload: 'valid_mock_apple_payload',
    });
    assert.strictEqual(res1.status, 200);
    assert.strictEqual(res1.data.success, true);
    assert.strictEqual(res1.data.notificationUUID, notifUUID);

    // 重複通知再次送入：命中 completed 冪等
    const res2 = await postJson(baseUrl, '/api/apple-webhook', {
      signedPayload: 'valid_mock_apple_payload',
    });
    assert.strictEqual(res2.status, 200);
    assert.strictEqual(res2.data.duplicate, true);
    assert.strictEqual(res2.data.state, 'completed');
  });

  await t.test('5. 處理器異常時回傳 500 並釋放 processing 鎖，允許後續重試', async () => {
    const notifUUID = 'test_fail_uuid_777';
    const mockVerifier = {
      verifyAndDecode: async () => ({
        isValid: true,
        notificationType: 'SUBSCRIBED',
        notificationUUID: notifUUID,
        productId: 'exampro_monthly',
      }),
    };
    setCustomNotificationVerifier(mockVerifier);

    let attempt = 0;
    const failingHandler = {
      handle: async () => {
        attempt++;
        if (attempt === 1) {
          throw new Error('模擬資料庫瞬斷異常');
        }
        return { success: true, action: 'APPLY_ACTIVE', reason: '第二次重試成功' };
      },
    };
    setCustomAppleWebhookEventHandler(failingHandler);

    // 第一次呼叫：拋出例外，端點應回傳 500 並釋放鎖
    const res1 = await postJson(baseUrl, '/api/apple-webhook', {
      signedPayload: 'payload_attempt_1',
    });
    assert.strictEqual(res1.status, 500);
    assert.strictEqual(res1.data.code, 'PROCESSING_FAILED');

    // 第二次重試呼叫：鎖已釋放，應能成功重新進入並成功
    const res2 = await postJson(baseUrl, '/api/apple-webhook', {
      signedPayload: 'payload_attempt_2',
    });
    assert.strictEqual(res2.status, 200);
    assert.strictEqual(res2.data.success, true);
    assert.strictEqual(res2.data.action, 'APPLY_ACTIVE');
  });

  await t.test('6. 並行處理安全性：當第一筆仍處於 processing，第二筆請求回傳 503 (附帶 Retry-After)，避免 Apple 誤判成功而停止重送', async () => {
    const notifUUID = 'test_concurrent_uuid_888';
    const mockVerifier = {
      verifyAndDecode: async () => ({
        isValid: true,
        notificationType: 'DID_RENEW',
        notificationUUID: notifUUID,
        bundleId: EXPECTED_BUNDLE_ID,
        productId: 'exampro_monthly',
      }),
    };
    setCustomNotificationVerifier(mockVerifier);

    // 預先在 Redis 中模擬 Request 1 正在 processing
    const isDryRun = process.env.APPLE_WEBHOOK_DRY_RUN !== 'false';
    await acquireWebhookIdempotency(notifUUID, { isDryRun });

    // Request 2 抵達：必須被回傳 503 Service Unavailable (附帶 Retry-After)
    const res = await postJson(baseUrl, '/api/apple-webhook', {
      signedPayload: 'concurrent_request_payload',
    });

    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.data.code, 'CONCURRENT_PROCESSING');
    assert.strictEqual(res.data.state, 'processing');
  });

  await t.test('7. Dry-Run 模式命名空間隔離：完成標記僅寫入 dryrun 命名空間，不污染正式 completed 紀錄', async () => {
    const notifUUID = 'test_dryrun_isolated_uuid_123';
    const mockVerifier = {
      verifyAndDecode: async () => ({
        isValid: true,
        notificationType: 'DID_RENEW',
        notificationUUID: notifUUID,
        bundleId: EXPECTED_BUNDLE_ID,
        productId: 'exampro_monthly',
      }),
    };
    setCustomNotificationVerifier(mockVerifier);

    process.env.APPLE_WEBHOOK_DRY_RUN = 'true';
    const res = await postJson(baseUrl, '/api/apple-webhook', {
      signedPayload: 'valid_mock_dryrun_payload',
    });
    assert.strictEqual(res.status, 200);

    // 驗證 Redis：dryrun 命名空間有 completed
    const dryRunVal = await inMemoryRedisMockInstance.get(`exam_ai:apple:webhook:dryrun:state:${notifUUID}`);
    assert.strictEqual(dryRunVal, 'completed');

    // 驗證 Redis：正式命名空間為空，完全未被污染！
    const liveVal = await inMemoryRedisMockInstance.get(`exam_ai:apple:webhook:state:${notifUUID}`);
    assert.strictEqual(liveVal, null);

    delete process.env.APPLE_WEBHOOK_DRY_RUN;
  });

  await t.test('8. 外層通知與內層交易一致性驗證：Bundle ID 不符時安全拒絕', async () => {
    const verifier = new AppleNotificationVerifier();
    // 使用內部私有方法或模擬外層 bundleId 與內層不一致
    const mockOuterWithMismatchedInner = {
      isValid: false,
      notificationType: 'UNKNOWN',
      notificationUUID: 'uuid_mismatch',
      errorMessage: '外層通知與內層交易之 Bundle ID 不一致 (com.examplanai.app vs com.hacker.fakeapp)。',
    };
    setCustomNotificationVerifier({
      verifyAndDecode: async () => mockOuterWithMismatchedInner,
    });

    const res = await postJson(baseUrl, '/api/apple-webhook', {
      signedPayload: 'mismatched_payload',
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.code, 'INVALID_NOTIFICATION');
    assert.match(res.data.error, /Bundle ID 不一致/);
  });

  await t.test('9. 外層通知與內層交易一致性驗證：Environment (Sandbox vs Production) 不符時安全拒絕', async () => {
    const mockEnvMismatch = {
      isValid: false,
      notificationType: 'UNKNOWN',
      notificationUUID: 'uuid_env_mismatch',
      errorMessage: '外層通知與內層交易之環境不一致 (Sandbox vs Production)。',
    };
    setCustomNotificationVerifier({
      verifyAndDecode: async () => mockEnvMismatch,
    });

    const res = await postJson(baseUrl, '/api/apple-webhook', {
      signedPayload: 'env_mismatched_payload',
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.code, 'INVALID_NOTIFICATION');
    assert.match(res.data.error, /環境不一致/);
  });
});
