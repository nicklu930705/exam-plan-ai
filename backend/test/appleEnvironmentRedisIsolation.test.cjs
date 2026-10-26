const test = require('node:test');
const assert = require('node:assert');

// 啟用 Mock Redis
process.env.MOCK_REDIS = 'true';
process.env.NODE_ENV = 'production';
process.env.APPLE_IAP_ENVIRONMENT = 'production';
process.env.APP_SERVER_SECRET = 'test_secret_for_redis_isolation_2026';

const {
  saveVerifiedEntitlement,
  getUserEntitlement,
  getOriginalTransactionEntitlement,
  generateEntitlementProofToken,
  verifyEntitlementProofToken,
  syncUserDeviceEffectiveEntitlement,
} = require('../dist/lib/entitlement.js');

const { applySubscriptionStateToRedis } = require('../dist/lib/appleSubscriptionSync.js');
const { inMemoryRedisMockInstance } = require('../dist/lib/redis.js');

test('Apple Sandbox / Production Redis 與會員權益完整隔離安全性測試套件', async (t) => {
  t.beforeEach(() => {
    inMemoryRedisMockInstance.clearAll();
  });

  await t.test('1. 相同 Original Transaction ID 隔離：Sandbox 交易絕不覆蓋已存在的 Production 交易主記錄', async () => {
    const origId = 'orig_collision_shared_99999';
    const prodUserId = 'dev_real_paying_user';
    const sandboxUserId = 'dev_sandbox_tester';
    const now = Date.now();

    // 1. 真實正式付費用戶建立 Production 交易
    const prodVerification = {
      isValid: true,
      status: 'active',
      tier: 'pro',
      productId: 'exampro_monthly',
      transactionId: 'prod_tx_001',
      originalTransactionId: origId,
      purchaseDate: now - 3600 * 1000,
      expiresDate: now + 30 * 86400 * 1000,
      signedDate: now - 3600 * 1000,
      environment: 'Production',
      isSandbox: false,
      isExpired: false,
      isRevoked: false,
    };
    await saveVerifiedEntitlement(prodUserId, prodVerification);

    // 驗證 Production 主記錄已正確儲存
    const prodRecordBefore = await getOriginalTransactionEntitlement(origId);
    assert.strictEqual(prodRecordBefore.environment, 'Production');
    assert.strictEqual(prodRecordBefore.status, 'active');
    assert.strictEqual(prodRecordBefore.isSandbox, false);

    // 2. 測試員或審查員以相同的 Original Transaction ID 提交 Sandbox 交易 (到期日更短或標記過期)
    const sandboxVerification = {
      isValid: true,
      status: 'expired',
      tier: 'pro',
      productId: 'exampro_monthly',
      transactionId: 'sand_tx_002',
      originalTransactionId: origId,
      purchaseDate: now,
      expiresDate: now - 1000,
      signedDate: now,
      environment: 'Sandbox',
      isSandbox: true,
      isExpired: true,
      isRevoked: false,
    };
    await saveVerifiedEntitlement(sandboxUserId, sandboxVerification);

    // 3. 核心檢驗：主記錄 (Production) 絕不被 Sandbox 覆蓋！
    const prodRecordAfter = await getOriginalTransactionEntitlement(origId);
    assert.strictEqual(prodRecordAfter.environment, 'Production');
    assert.strictEqual(prodRecordAfter.status, 'active', 'Production 交易絕不可被 Sandbox 過期記錄降級！');
    assert.strictEqual(prodRecordAfter.isSandbox, false);

    // 4. 正式用戶之會員權限依然為 active Pro
    const prodUserEnt = await getUserEntitlement(prodUserId);
    assert.strictEqual(prodUserEnt.tier, 'pro');
    assert.strictEqual(prodUserEnt.status, 'active');
    assert.strictEqual(prodUserEnt.environment, 'Production');

    // 5. Sandbox 交易被安全隔離於沙盒空間中
    const sandScopedRecord = await inMemoryRedisMockInstance.get(`exam_ai:apple:entitlement:sandbox:${origId}`);
    assert.ok(sandScopedRecord, 'Sandbox 交易應寫入沙盒隔離 Key');
    assert.strictEqual(sandScopedRecord.environment, 'Sandbox');
  });

  await t.test('2. Webhook 隔離防護：Sandbox Webhook 絕不得更新或撤銷 Production 真實交易', async () => {
    const origId = 'orig_prod_protected_from_webhook_777';
    const userId = 'dev_production_customer_1';
    const now = Date.now();

    // 1. 建立 Production 有效訂閱
    await saveVerifiedEntitlement(userId, {
      isValid: true,
      status: 'active',
      tier: 'pro',
      productId: 'exampro_yearly',
      transactionId: 'prod_tx_777',
      originalTransactionId: origId,
      purchaseDate: now - 86400 * 1000,
      expiresDate: now + 365 * 86400 * 1000,
      signedDate: now - 86400 * 1000,
      environment: 'Production',
      isSandbox: false,
      isExpired: false,
      isRevoked: false,
    });

    // 2. 模擬來自 Apple Sandbox 的退款或撤銷通知 (相同 originalTransactionId)
    const sandboxWebhookResult = await applySubscriptionStateToRedis({
      originalTransactionId: origId,
      transition: {
        action: 'REVOKE',
        status: 'revoked',
        tier: 'free',
        actionable: true,
        reason: 'Apple Sandbox 測試退款通知',
        effectiveRevocationDate: now,
      },
      verifiedNotification: {
        environment: 'Sandbox',
        notificationType: 'REVOKE',
        signedDate: now,
      },
      isDryRun: false,
    });

    // 3. 核心檢驗：Sandbox Webhook 必須被跨環境防護阻斷 (action: ignored_cross_environment)
    assert.strictEqual(sandboxWebhookResult.action, 'ignored_cross_environment');
    assert.match(sandboxWebhookResult.reason, /Sandbox Webhook 嚴格禁止修改 Production/);

    // 4. 檢驗 Production 交易記錄完好無損，未被退款撤銷
    const record = await getOriginalTransactionEntitlement(origId);
    assert.strictEqual(record.status, 'active');
    assert.strictEqual(record.environment, 'Production');

    const userEnt = await getUserEntitlement(userId);
    assert.strictEqual(userEnt.tier, 'pro');
    assert.strictEqual(userEnt.status, 'active');
  });

  await t.test('3. 同一 Device ID 之雙環境訂閱隔離：Production 交易嚴格優先於 Sandbox 測試交易', async () => {
    const deviceId = 'dev_shared_iphone_dual_env';
    const now = Date.now();
    const prodOrigId = 'orig_prod_real_purchase';
    const sandOrigId = 'orig_sand_test_purchase';

    // 1. 該裝置先在 Production 購買了 1 個月 Pro (30 天後到期)
    await saveVerifiedEntitlement(deviceId, {
      isValid: true,
      status: 'active',
      tier: 'pro',
      productId: 'exampro_monthly',
      transactionId: 'tx_prod_01',
      originalTransactionId: prodOrigId,
      purchaseDate: now,
      expiresDate: now + 30 * 86400 * 1000,
      signedDate: now,
      environment: 'Production',
      isSandbox: false,
      isExpired: false,
      isRevoked: false,
    });

    // 2. 隨後在該裝置上進行了 Sandbox 測試，購買了年訂閱 (到期日長達 365 天)
    await saveVerifiedEntitlement(deviceId, {
      isValid: true,
      status: 'active',
      tier: 'pro',
      productId: 'exampro_yearly',
      transactionId: 'tx_sand_02',
      originalTransactionId: sandOrigId,
      purchaseDate: now,
      expiresDate: now + 365 * 86400 * 1000,
      signedDate: now,
      environment: 'Sandbox',
      isSandbox: true,
      isExpired: false,
      isRevoked: false,
    });

    // 3. 核心檢驗：即便 Sandbox 到期日更長，使用者即時權限快取必須堅決綁定至 Production！
    const currentEnt = await getUserEntitlement(deviceId);
    assert.strictEqual(currentEnt.tier, 'pro');
    assert.strictEqual(currentEnt.environment, 'Production', '正式付費用戶身分優先，絕不可被 Sandbox 標籤取代！');
    assert.strictEqual(currentEnt.isSandbox, false);
    assert.strictEqual(currentEnt.originalTransactionId, prodOrigId);

    // 4. 模擬 Sandbox 測試訂閱在 Apple 伺服端退款或被撤銷
    await saveVerifiedEntitlement(deviceId, {
      isValid: true,
      status: 'revoked',
      tier: 'free',
      productId: 'exampro_yearly',
      transactionId: 'tx_sand_02_rev',
      originalTransactionId: sandOrigId,
      revocationDate: now,
      environment: 'Sandbox',
      isSandbox: true,
      isExpired: false,
      isRevoked: true,
    });

    // 5. 核心檢驗：Sandbox 的退款絕不連帶撤銷該裝置的 Production Pro 權益！
    const afterSandboxRevokeEnt = await getUserEntitlement(deviceId);
    assert.strictEqual(afterSandboxRevokeEnt.tier, 'pro');
    assert.strictEqual(afterSandboxRevokeEnt.status, 'active');
    assert.strictEqual(afterSandboxRevokeEnt.originalTransactionId, prodOrigId);
  });

  await t.test('4. Apple 審查員合法 Sandbox 流程：在無 Production 購買之乾淨裝置上順利啟用與過期降級', async () => {
    const reviewerDevice = 'dev_apple_reviewer_ipad';
    const sandOrigId = 'orig_reviewer_sandbox_transaction';
    const now = Date.now();

    // 1. 審查員在乾淨裝置上無任何 Production 訂閱
    const initialEnt = await getUserEntitlement(reviewerDevice);
    assert.strictEqual(initialEnt.tier, 'free');
    assert.strictEqual(initialEnt.status, 'none');

    // 2. 審查員完成 Sandbox 購買 (有效期間 1 小時)
    await saveVerifiedEntitlement(reviewerDevice, {
      isValid: true,
      status: 'active',
      tier: 'pro',
      productId: 'exampro_monthly',
      transactionId: 'tx_reviewer_01',
      originalTransactionId: sandOrigId,
      purchaseDate: now,
      expiresDate: now + 3600 * 1000,
      signedDate: now,
      environment: 'Sandbox',
      isSandbox: true,
      isExpired: false,
      isRevoked: false,
    });

    // 3. 核心檢驗：審查員在無 Production 訂閱時，順利啟用 Pro 權益，並正確標記為 Sandbox
    const reviewerEnt = await getUserEntitlement(reviewerDevice);
    assert.strictEqual(reviewerEnt.tier, 'pro');
    assert.strictEqual(reviewerEnt.status, 'active');
    assert.strictEqual(reviewerEnt.environment, 'Sandbox');
    assert.strictEqual(reviewerEnt.isSandbox, true);

    // 4. 簽發之 Proof Token 亦可成功驗證
    const token = generateEntitlementProofToken(reviewerDevice, sandOrigId, now + 3600 * 1000);
    const tokenCheck = await verifyEntitlementProofToken(token, reviewerDevice);
    assert.strictEqual(tokenCheck.valid, true);
    assert.strictEqual(tokenCheck.isSandbox, true);

    // 5. 模擬審查員訂閱自然到期
    await inMemoryRedisMockInstance.clearAll(); // 清除快取以模擬時間流逝過期
    await inMemoryRedisMockInstance.set(`exam_ai:apple:entitlement:${sandOrigId}`, {
      originalTransactionId: sandOrigId,
      lastTransactionId: 'tx_reviewer_01',
      productId: 'exampro_monthly',
      tier: 'pro',
      status: 'expired',
      expiresDate: now - 1000,
      environment: 'Sandbox',
      isSandbox: true,
    });

    const expiredTokenCheck = await verifyEntitlementProofToken(token, reviewerDevice);
    assert.strictEqual(expiredTokenCheck.valid, false);
    assert.match(expiredTokenCheck.reason, /到期/);
  });

  await t.test('5. Proof Token 跨裝置與身分冒用防禦', async () => {
    const legitimateUser = 'dev_legitimate_pro_owner';
    const attackerUser = 'dev_malicious_attacker';
    const now = Date.now();
    const origId = 'orig_tx_anti_hijack';

    await saveVerifiedEntitlement(legitimateUser, {
      isValid: true,
      status: 'active',
      tier: 'pro',
      productId: 'exampro_monthly',
      transactionId: 'tx_anti_hijack',
      originalTransactionId: origId,
      purchaseDate: now,
      expiresDate: now + 86400 * 1000,
      signedDate: now,
      environment: 'Production',
      isSandbox: false,
      isExpired: false,
      isRevoked: false,
    });

    const legitimateToken = generateEntitlementProofToken(legitimateUser, origId, now + 86400 * 1000);

    // 攻擊者盜用合法使用者的 Token 發送自身 Device ID 的請求
    const hijackCheck = await verifyEntitlementProofToken(legitimateToken, attackerUser);
    assert.strictEqual(hijackCheck.valid, false);
    assert.match(hijackCheck.reason, /身分與當前請求裝置不符/);
  });
});
