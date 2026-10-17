const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// 設定測試環境變數
process.env.MOCK_REDIS = 'true';
process.env.OPENAI_API_KEY = 'test_mock_key';
process.env.APP_SERVER_SECRET = 'test_signing_secret_for_tests';

const verifyTxModule = require('../dist/api/verify-transaction.js');
const studyAdviceModule = require('../dist/api/study-advice.js');
const {
  AppleStoreKitVerifier,
  setCustomTransactionVerifier,
  EXPECTED_BUNDLE_ID,
} = require('../dist/lib/appleIap.js');
const {
  inMemoryRedisMockInstance,
} = require('../dist/lib/redis.js');
const {
  generateEntitlementProofToken,
  verifyEntitlementProofToken,
  getUserEntitlement,
} = require('../dist/lib/entitlement.js');

const verifyHandler = typeof verifyTxModule === 'function' ? verifyTxModule : verifyTxModule.default;
const adviceHandler = typeof studyAdviceModule === 'function' ? studyAdviceModule : studyAdviceModule.default;

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
      if (req.url && req.url.startsWith('/api/verify-transaction')) {
        await verifyHandler(req, res);
      } else if (req.url && req.url.startsWith('/api/study-advice')) {
        await adviceHandler(req, res);
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
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

const OpenAI = require('openai');

const mockAdviceJson = JSON.stringify({
  summary: '以穩健節奏保持複習，弱科優先安排於專注度最高時段。',
  focusSubjects: ['英文閱讀'],
  actionableTips: ['每日安排 30 分鐘弱點練習', '考前兩週維持模擬考手感'],
  estimatedFeasibility: '時間充裕，維持現有進度即可。',
});

test('Apple StoreKit 2 交易驗證與會員系統完整測試套件', async (t) => {
  let serverCtx;
  let restoreOpenAi;

  t.before(async () => {
    serverCtx = await createTestServer();
    const dummy = new OpenAI({ apiKey: 'mock' });
    const completionsProto = Object.getPrototypeOf(dummy.chat.completions);
    const originalCreate = completionsProto.create;
    completionsProto.create = async function () {
      return {
        choices: [{ message: { role: 'assistant', content: mockAdviceJson } }],
        usage: { prompt_tokens: 300, completion_tokens: 150, total_tokens: 450 },
      };
    };
    restoreOpenAi = () => {
      completionsProto.create = originalCreate;
    };
  });

  t.after(async () => {
    if (restoreOpenAi) restoreOpenAi();
    setCustomTransactionVerifier(null);
    if (serverCtx) await serverCtx.close();
  });

  t.beforeEach(() => {
    inMemoryRedisMockInstance.clear();
    setCustomTransactionVerifier(null);
  });

  // ───── 測試 1：有效交易（Pro 月訂閱、Pro 年訂閱、Lifetime 終身版） ─────
  await t.test('1. 有效交易：驗證成功並正確賦予 Pro 月/年訂閱與 Lifetime 權益', async () => {
    const mockVerifier = {
      async verify(jws) {
        if (jws === 'mock_monthly_jws') {
          return {
            isValid: true,
            status: 'active',
            tier: 'pro',
            productId: 'exampro_monthly',
            transactionId: 'txn_monthly_1001',
            originalTransactionId: 'orig_monthly_1001',
            purchaseDate: Date.now() - 3600000,
            originalPurchaseDate: Date.now() - 3600000,
            expiresDate: Date.now() + 30 * 86400 * 1000,
            environment: 'Sandbox',
            isExpired: false,
            isRevoked: false,
          };
        }
        if (jws === 'mock_lifetime_jws') {
          return {
            isValid: true,
            status: 'active',
            tier: 'lifetime',
            productId: 'exampro_lifetime',
            transactionId: 'txn_lifetime_2001',
            originalTransactionId: 'orig_lifetime_2001',
            purchaseDate: Date.now() - 7200000,
            originalPurchaseDate: Date.now() - 7200000,
            environment: 'Production',
            isExpired: false,
            isRevoked: false,
          };
        }
        return { isValid: false, status: 'invalid', tier: 'free', isExpired: false, isRevoked: false };
      },
    };
    setCustomTransactionVerifier(mockVerifier);

    // 月訂閱驗證
    const res1 = await postJson(
      serverCtx.baseUrl,
      '/api/verify-transaction',
      { signedTransaction: 'mock_monthly_jws' },
      { 'x-client-device-id': 'dev_test_device_valid_user_1' },
    );

    assert.equal(res1.status, 200);
    assert.equal(res1.data.success, true);
    assert.equal(res1.data.tier, 'pro');
    assert.equal(res1.data.status, 'active');
    assert.equal(res1.data.productId, 'exampro_monthly');
    assert.equal(res1.data.originalTransactionId, 'orig_monthly_1001');
    assert.ok(res1.data.proofToken, '必須回傳防偽 Proof Token');

    // 檢查 Redis 快取已生效
    const ent1 = await getUserEntitlement('dev_test_device_valid_user_1');
    assert.equal(ent1.tier, 'pro');
    assert.equal(ent1.isVerified, true);

    // 終身版驗證
    const res2 = await postJson(
      serverCtx.baseUrl,
      '/api/verify-transaction',
      { signedTransaction: 'mock_lifetime_jws' },
      { 'x-client-device-id': 'dev_test_device_lifetime_user' },
    );

    assert.equal(res2.status, 200);
    assert.equal(res2.data.success, true);
    assert.equal(res2.data.tier, 'lifetime');
    assert.equal(res2.data.status, 'active');
    assert.equal(res2.data.productId, 'exampro_lifetime');

    const ent2 = await getUserEntitlement('dev_test_device_lifetime_user');
    assert.equal(ent2.tier, 'lifetime');
    assert.equal(ent2.isVerified, true);
  });

  // ───── 測試 2：偽造簽章 ─────
  await t.test('2. 偽造簽章：傳入無效或竄改之 JWS，必須被 400 拒絕且不得解鎖權限', async () => {
    // 使用真實 AppleStoreKitVerifier (未帶自訂 Mock)
    const res = await postJson(
      serverCtx.baseUrl,
      '/api/verify-transaction',
      { signedTransaction: 'forged.signature.jws.content' },
      { 'x-client-device-id': 'dev_attacker_forged_sig' },
    );

    assert.equal(res.status, 400);
    assert.equal(res.data.success, false);
    assert.equal(res.data.code, 'INVALID_TRANSACTION');
    assert.equal(res.data.tier, 'free');

    const ent = await getUserEntitlement('dev_attacker_forged_sig');
    assert.equal(ent.isVerified, false);
    assert.equal(ent.tier, 'free');
  });

  // ───── 測試 3：錯誤 Bundle ID ─────
  await t.test('3. 錯誤 Bundle ID：非本 App (com.examplanai.app) 之交易必須被拒絕', async () => {
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
      { signedTransaction: 'mock_alien_bundle_jws' },
      { 'x-client-device-id': 'dev_alien_bundle_user' },
    );

    assert.equal(res.status, 400);
    assert.equal(res.data.success, false);
    assert.equal(res.data.code, 'INVALID_TRANSACTION');
    assert.match(res.data.error, /com\.examplanai\.app/);

    const ent = await getUserEntitlement('dev_alien_bundle_user');
    assert.equal(ent.isVerified, false);
  });

  // ───── 測試 4：不存在的 Product ID ─────
  await t.test('4. 不存在的 Product ID：非官方已定義之商品必須被拒絕', async () => {
    const mockVerifier = {
      async verify() {
        return {
          isValid: false,
          status: 'invalid',
          tier: 'free',
          isExpired: false,
          isRevoked: false,
          errorMessage: '未知的產品識別碼「unknown_hacked_item」，非合法考試計畫 AI 方案。',
        };
      },
    };
    setCustomTransactionVerifier(mockVerifier);

    const res = await postJson(
      serverCtx.baseUrl,
      '/api/verify-transaction',
      { signedTransaction: 'mock_unknown_product_jws' },
      { 'x-client-device-id': 'dev_unknown_prod_user' },
    );

    assert.equal(res.status, 400);
    assert.equal(res.data.success, false);
    assert.equal(res.data.code, 'INVALID_TRANSACTION');
    assert.match(res.data.error, /unknown_hacked_item/);

    const ent = await getUserEntitlement('dev_unknown_prod_user');
    assert.equal(ent.isVerified, false);
  });

  // ───── 測試 5：過期訂閱 ─────
  await t.test('5. 過期訂閱：已到期之訂閱交易應標記為 expired 並鎖定為 Free 權限', async () => {
    const expiredTimestamp = Date.now() - 86400000; // 昨天已到期
    const mockVerifier = {
      async verify() {
        return {
          isValid: true,
          status: 'expired',
          tier: 'free',
          productId: 'exampro_monthly',
          transactionId: 'txn_expired_1',
          originalTransactionId: 'orig_expired_1',
          purchaseDate: Date.now() - 31 * 86400000,
          expiresDate: expiredTimestamp,
          environment: 'Sandbox',
          isExpired: true,
          isRevoked: false,
          errorMessage: '此訂閱方案已到期。',
        };
      },
    };
    setCustomTransactionVerifier(mockVerifier);

    const res = await postJson(
      serverCtx.baseUrl,
      '/api/verify-transaction',
      { signedTransaction: 'mock_expired_jws' },
      { 'x-client-device-id': 'dev_expired_sub_user' },
    );

    assert.equal(res.status, 200);
    assert.equal(res.data.success, false);
    assert.equal(res.data.code, 'SUBSCRIPTION_EXPIRED');
    assert.equal(res.data.status, 'expired');
    assert.equal(res.data.tier, 'free');

    const ent = await getUserEntitlement('dev_expired_sub_user');
    assert.equal(ent.tier, 'free');
    assert.equal(ent.isVerified, false);
  });

  // ───── 測試 6：退款或撤銷 ─────
  await t.test('6. 退款或撤銷：已被 Apple 撤銷之交易必須標記為 revoked 且不得享有 Pro', async () => {
    const mockVerifier = {
      async verify() {
        return {
          isValid: true,
          status: 'revoked',
          tier: 'free',
          productId: 'exampro_yearly',
          transactionId: 'txn_revoked_1',
          originalTransactionId: 'orig_revoked_1',
          purchaseDate: Date.now() - 10 * 86400000,
          revocationDate: Date.now() - 86400000,
          environment: 'Production',
          isExpired: false,
          isRevoked: true,
          errorMessage: '此交易已被 Apple 撤銷或退款。',
        };
      },
    };
    setCustomTransactionVerifier(mockVerifier);

    const res = await postJson(
      serverCtx.baseUrl,
      '/api/verify-transaction',
      { signedTransaction: 'mock_revoked_jws' },
      { 'x-client-device-id': 'dev_refunded_user' },
    );

    assert.equal(res.status, 200);
    assert.equal(res.data.success, false);
    assert.equal(res.data.code, 'TRANSACTION_REVOKED');
    assert.equal(res.data.status, 'revoked');
    assert.equal(res.data.tier, 'free');

    const ent = await getUserEntitlement('dev_refunded_user');
    assert.equal(ent.tier, 'free');
    assert.equal(ent.isVerified, false);
  });

  // ───── 測試 7：重複交易與冪等處理 ─────
  await t.test('7. 重複請求與冪等處理：傳送相同 idempotencyKey 時直接回傳快取結果', async () => {
    let callCount = 0;
    const mockVerifier = {
      async verify() {
        callCount++;
        return {
          isValid: true,
          status: 'active',
          tier: 'pro',
          productId: 'exampro_monthly',
          transactionId: 'txn_idemp_1',
          originalTransactionId: 'orig_idemp_1',
          expiresDate: Date.now() + 30 * 86400000,
          environment: 'Sandbox',
          isExpired: false,
          isRevoked: false,
        };
      },
    };
    setCustomTransactionVerifier(mockVerifier);

    const idemKey = 'idemp_uuid_test_12345';
    const res1 = await postJson(
      serverCtx.baseUrl,
      '/api/verify-transaction',
      { signedTransaction: 'mock_idemp_jws', idempotencyKey: idemKey },
      { 'x-client-device-id': 'dev_idemp_user' },
    );

    assert.equal(res1.status, 200);
    assert.equal(res1.data.success, true);
    assert.equal(callCount, 1);

    // 重複發送相同請求
    const res2 = await postJson(
      serverCtx.baseUrl,
      '/api/verify-transaction',
      { signedTransaction: 'mock_idemp_jws', idempotencyKey: idemKey },
      { 'x-client-device-id': 'dev_idemp_user' },
    );

    assert.equal(res2.status, 200);
    assert.equal(res2.data.success, true);
    assert.equal(res2.data.cached, true, '第二筆請求應直接從快取回傳');
    assert.equal(callCount, 1, '底層驗證器不應被二次呼叫');
  });

  // ───── 測試 8：Sandbox / Production 環境不一致處理 ─────
  await t.test('8. 環境不一致：當沙盒被明確禁用且收到沙盒收據時，應正確判定環境不符', async () => {
    const mockVerifier = {
      async verify() {
        return {
          isValid: false,
          status: 'invalid',
          tier: 'free',
          isExpired: false,
          isRevoked: false,
          errorMessage: '交易環境不相符 (沙盒/正式環境不一致)。',
        };
      },
    };
    setCustomTransactionVerifier(mockVerifier);

    const res = await postJson(
      serverCtx.baseUrl,
      '/api/verify-transaction',
      { signedTransaction: 'mock_env_mismatch_jws' },
      { 'x-client-device-id': 'dev_env_mismatch_user' },
    );

    assert.equal(res.status, 400);
    assert.equal(res.data.success, false);
    assert.match(res.data.error, /沙盒\/正式環境不一致/);
  });

  // ───── 測試 9：Apple 伺服端暫時不可用 ─────
  await t.test('9. Apple 伺服端異常：發生非預期例外時回傳安全 500 錯誤，不洩漏任何憑證或金鑰', async () => {
    const mockVerifier = {
      async verify() {
        throw new Error('Simulated Apple PKI unreachable with private internal stack trace');
      },
    };
    setCustomTransactionVerifier(mockVerifier);

    const res = await postJson(
      serverCtx.baseUrl,
      '/api/verify-transaction',
      { signedTransaction: 'mock_crash_jws' },
      { 'x-client-device-id': 'dev_crash_user' },
    );

    assert.equal(res.status, 500);
    assert.equal(res.data.success, false);
    assert.equal(res.data.code, 'VERIFICATION_SERVICE_ERROR');
    assert.doesNotMatch(res.data.error, /private internal stack trace/);
  });

  // ───── 測試 10：未付費用戶不得取得付費 AI 額度 ─────
  await t.test('10. 未付費用戶與付費用戶 AI 額度隔離：未驗證用戶嚴格受限於 Free 3 次配額', async () => {
    // 1. 未付費攻擊者嘗試自稱 Pro
    const sampleExam = {
      examName: '多益英語測驗',
      examDate: '2026-11-12',
      dailyAvailableMinutes: 90,
      subjects: [{ name: '英文閱讀', familiarity: 2 }],
    };

    const attackerHeaders = {
      'x-client-device-id': 'dev_attacker_quota_test',
      'x-apple-transaction-id': 'fake_trans_id_99999',
      'x-user-tier': 'pro',
    };

    // 第 1~3 次呼叫成功
    for (let i = 1; i <= 3; i++) {
      const r = await postJson(serverCtx.baseUrl, '/api/study-advice', sampleExam, attackerHeaders);
      assert.equal(r.status, 200, `第 ${i} 次呼叫應成功`);
      assert.equal(r.data.quota.tier, 'free', '未經 JWS 驗證者必須嚴格鎖定為 Free 額度');
    }

    // 第 4 次呼叫被拒絕
    const r4 = await postJson(serverCtx.baseUrl, '/api/study-advice', sampleExam, attackerHeaders);
    assert.equal(r4.status, 429, '第 4 次呼叫必須被 429 DAILY_QUOTA_EXCEEDED 拒絕');
    assert.equal(r4.data.code, 'DAILY_QUOTA_EXCEEDED');

    // 2. 合法付費用戶（透過 JWS 或 Proof Token 驗證）
    const validVerifier = {
      async verify() {
        return {
          isValid: true,
          status: 'active',
          tier: 'pro',
          productId: 'exampro_monthly',
          transactionId: 'txn_legit_pro_999',
          originalTransactionId: 'orig_legit_pro_999',
          expiresDate: Date.now() + 30 * 86400000,
          environment: 'Sandbox',
          isExpired: false,
          isRevoked: false,
        };
      },
    };
    setCustomTransactionVerifier(validVerifier);

    // 先透過 /api/verify-transaction 驗證並綁定
    const verifyRes = await postJson(
      serverCtx.baseUrl,
      '/api/verify-transaction',
      { signedTransaction: 'mock_legit_jws' },
      { 'x-client-device-id': 'dev_legit_pro_user' },
    );
    assert.equal(verifyRes.status, 200);
    assert.equal(verifyRes.data.tier, 'pro');

    // 付費使用者呼叫 /api/study-advice，驗證其取得 Pro 15 次配額
    const proHeaders = {
      'x-client-device-id': 'dev_legit_pro_user',
    };

    const proRes1 = await postJson(serverCtx.baseUrl, '/api/study-advice', sampleExam, proHeaders);
    assert.equal(proRes1.status, 200);
    assert.equal(proRes1.data.quota.tier, 'pro', '已驗證用戶應取得 Pro 方案配額');
    assert.equal(proRes1.data.quota.dailyLimit, 15, 'Pro 方案每日配額應為 15 次');
  });

  // ───── 測試 11：匿名身分冒用防禦（Proof Token 偽造或他人冒用） ─────
  await t.test('11. 匿名身分冒用防禦：持他人 Proof Token 在不同 Device ID 發送請求，必須被拒絕', async () => {
    // 產生屬於 legitimate_user 的 Proof Token
    const legitUserId = 'dev_legit_owner_device';
    const fakeToken = generateEntitlementProofToken(legitUserId, 'orig_legit_100', Date.now() + 86400000);

    // 攻擊者使用 attacker_device 嘗試攜帶該 Proof Token
    const sampleExam = {
      examName: '多益英語測驗',
      examDate: '2026-11-12',
      dailyAvailableMinutes: 90,
      subjects: [{ name: '英文閱讀', familiarity: 2 }],
    };

    const attackerHeaders = {
      'x-client-device-id': 'dev_attacker_hijack_device',
      'x-apple-proof-token': fakeToken,
      'x-user-tier': 'pro',
    };

    const res = await postJson(serverCtx.baseUrl, '/api/study-advice', sampleExam, attackerHeaders);
    assert.equal(res.status, 200);
    assert.equal(res.data.quota.tier, 'free', '身分與 Proof Token 不符者，必須強制鎖定為 Free 額度');
  });

  // ───── 測試 12：Proof Token 退款後即時失效 ─────
  await t.test('12. 退款聯防：交易被 Apple 撤銷後，持有效簽名之舊 Proof Token 必須即時失效', async () => {
    const origTxnId = 'orig_refund_target_777';
    const testUserId = 'dev_refund_victim_device';

    // 1. 先模擬購買成功
    const validVerifier = {
      async verify() {
        return {
          isValid: true,
          status: 'active',
          tier: 'pro',
          productId: 'exampro_monthly',
          transactionId: 'txn_init_777',
          originalTransactionId: origTxnId,
          expiresDate: Date.now() + 30 * 86400000,
          environment: 'Sandbox',
          isExpired: false,
          isRevoked: false,
        };
      },
    };
    setCustomTransactionVerifier(validVerifier);

    const vRes = await postJson(
      serverCtx.baseUrl,
      '/api/verify-transaction',
      { signedTransaction: 'mock_init_jws' },
      { 'x-client-device-id': testUserId },
    );
    assert.equal(vRes.status, 200);
    const proofToken = vRes.data.proofToken;
    assert.ok(proofToken);

    // 2. 模擬 Apple 隨後核准退款 (revocation)
    const revokedVerifier = {
      async verify() {
        return {
          isValid: true,
          status: 'revoked',
          tier: 'free',
          productId: 'exampro_monthly',
          transactionId: 'txn_refunded_777',
          originalTransactionId: origTxnId,
          revocationDate: Date.now(),
          environment: 'Sandbox',
          isExpired: false,
          isRevoked: true,
        };
      },
    };
    setCustomTransactionVerifier(revokedVerifier);

    const rRes = await postJson(
      serverCtx.baseUrl,
      '/api/verify-transaction',
      { signedTransaction: 'mock_revoked_jws' },
      { 'x-client-device-id': testUserId },
    );
    assert.equal(rRes.status, 200);
    assert.equal(rRes.data.status, 'revoked');

    // 3. 使用者嘗試拿退款前的 Proof Token 發送 AI 請求
    const sampleExam = {
      examName: '多益英語測驗',
      examDate: '2026-11-12',
      dailyAvailableMinutes: 90,
      subjects: [{ name: '英文閱讀', familiarity: 2 }],
    };

    const tokenHeaders = {
      'x-client-device-id': testUserId,
      'x-apple-proof-token': proofToken,
    };

    const aiRes = await postJson(serverCtx.baseUrl, '/api/study-advice', sampleExam, tokenHeaders);
    assert.equal(aiRes.status, 200);
    assert.equal(aiRes.data.quota.tier, 'free', '退款後之 Proof Token 不得享有 Pro 額度');
  });

  // ───── 測試 13：舊 JWS 逆向覆蓋防護 ─────
  await t.test('13. 舊 JWS 逆向覆蓋防護：過期或較舊之 JWS 不得縮減 Redis 中已續訂之到期日', async () => {
    const origTxnId = 'orig_renewal_race_1';
    const futureDate = Date.now() + 60 * 86400000; // 60 天後 (已續約到第二個月)
    const pastDate = Date.now() + 5 * 86400000; // 5 天後 (第一個月的舊收據)

    // 1. 先寫入較新的續約記錄
    const newVerifier = {
      async verify() {
        return {
          isValid: true,
          status: 'active',
          tier: 'pro',
          productId: 'exampro_monthly',
          transactionId: 'txn_renewed_2',
          originalTransactionId: origTxnId,
          expiresDate: futureDate,
          environment: 'Sandbox',
          isExpired: false,
          isRevoked: false,
        };
      },
    };
    setCustomTransactionVerifier(newVerifier);

    await postJson(
      serverCtx.baseUrl,
      '/api/verify-transaction',
      { signedTransaction: 'mock_new_jws' },
      { 'x-client-device-id': 'dev_renewal_user' },
    );

    // 2. 客戶端意外重傳舊 JWS (到期日較短)
    const oldVerifier = {
      async verify() {
        return {
          isValid: true,
          status: 'active',
          tier: 'pro',
          productId: 'exampro_monthly',
          transactionId: 'txn_old_1',
          originalTransactionId: origTxnId,
          expiresDate: pastDate,
          environment: 'Sandbox',
          isExpired: false,
          isRevoked: false,
        };
      },
    };
    setCustomTransactionVerifier(oldVerifier);

    await postJson(
      serverCtx.baseUrl,
      '/api/verify-transaction',
      { signedTransaction: 'mock_old_jws' },
      { 'x-client-device-id': 'dev_renewal_user' },
    );

    // 3. 驗證 Redis 記錄仍然保留較新的 60 天到期日
    const ent = await getUserEntitlement('dev_renewal_user');
    assert.equal(ent.tier, 'pro');
    assert.equal(ent.expiresAt, futureDate, '較短之舊 JWS 不得覆蓋較新的續訂到期日');
  });

  // ───── 測試 14：Redis 資料遺失後重新驗證恢復 Lifetime 權益 ─────
  await t.test('14. Redis 快取遺失恢復：快取被清除後，透過 JWS 重新驗證可即時恢復永久權益', async () => {
    const lifetimeVerifier = {
      async verify() {
        return {
          isValid: true,
          status: 'active',
          tier: 'lifetime',
          productId: 'exampro_lifetime',
          transactionId: 'txn_lifetime_recovery',
          originalTransactionId: 'orig_lifetime_recovery',
          environment: 'Production',
          isExpired: false,
          isRevoked: false,
        };
      },
    };
    setCustomTransactionVerifier(lifetimeVerifier);

    // 1. 初次購買
    await postJson(
      serverCtx.baseUrl,
      '/api/verify-transaction',
      { signedTransaction: 'mock_lifetime_jws' },
      { 'x-client-device-id': 'dev_lifetime_recovery_user' },
    );

    let ent = await getUserEntitlement('dev_lifetime_recovery_user');
    assert.equal(ent.tier, 'lifetime');

    // 2. 模擬 Redis 伺服器重啟或快取全清
    inMemoryRedisMockInstance.clear();
    ent = await getUserEntitlement('dev_lifetime_recovery_user');
    assert.equal(ent.tier, 'free', '快取遺失後暫無權限');

    // 3. 使用者換機或點擊恢復購買，再次送出 JWS
    const restoreRes = await postJson(
      serverCtx.baseUrl,
      '/api/verify-transaction',
      { signedTransaction: 'mock_lifetime_jws' },
      { 'x-client-device-id': 'dev_lifetime_new_phone' },
    );
    assert.equal(restoreRes.status, 200);
    assert.equal(restoreRes.data.tier, 'lifetime');

    const newEnt = await getUserEntitlement('dev_lifetime_new_phone');
    assert.equal(newEnt.tier, 'lifetime', '重新驗證後新裝置順利解鎖 Lifetime 永久權益');
  });

  // ───── 測試 15：移除硬性裝置上限，允許合法跨裝置恢復 ─────
  await t.test('15. 移除硬性裝置上限：單一收據在超過 10 台裝置（例如 15 台）恢復購買時，依然能成功綁定，不阻斷正常用戶', async () => {
    const sharedTxnId = 'orig_legit_family_receipt';
    const sharedVerifier = {
      async verify() {
        return {
          isValid: true,
          status: 'active',
          tier: 'pro',
          productId: 'exampro_yearly',
          transactionId: 'txn_shared_yearly',
          originalTransactionId: sharedTxnId,
          expiresDate: Date.now() + 365 * 86400000,
          environment: 'Production',
          isExpired: false,
          isRevoked: false,
        };
      },
    };
    setCustomTransactionVerifier(sharedVerifier);

    // 連續綁定 15 台裝置（模擬使用者換機或家庭設備共用），皆應成功
    for (let i = 1; i <= 15; i++) {
      const r = await postJson(
        serverCtx.baseUrl,
        '/api/verify-transaction',
        { signedTransaction: 'mock_shared_jws' },
        { 'x-client-device-id': `dev_family_user_${i}` },
      );
      assert.equal(r.status, 200, `第 ${i} 台裝置應成功恢復購買與驗證`);
      assert.equal(r.data.tier, 'pro');
      assert.ok(r.data.proofToken, '每一台合法設備皆取得防偽 Proof Token');
    }
  });

  // ───── 測試 16：舊 JWS 逆向覆蓋撤銷防護 ─────
  await t.test('16. 舊 JWS 逆向覆蓋撤銷防護：當交易已被 Apple 撤銷後，重送舊 active JWS 必須維持 revoked 狀態', async () => {
    const revokedTxnId = 'orig_already_revoked_receipt';
    const userId = 'dev_user_attempting_stale_jws';

    // 1. 先模擬伺服端已記錄該交易為 revoked (退款)
    const revokedVerifier = {
      async verify() {
        return {
          isValid: true,
          status: 'revoked',
          tier: 'free',
          productId: 'exampro_yearly',
          transactionId: 'txn_revoked_init',
          originalTransactionId: revokedTxnId,
          revocationDate: Date.now() - 3600000,
          environment: 'Sandbox',
          isExpired: false,
          isRevoked: true,
        };
      },
    };
    setCustomTransactionVerifier(revokedVerifier);

    const initRevoke = await postJson(
      serverCtx.baseUrl,
      '/api/verify-transaction',
      { signedTransaction: 'mock_revoked_init_jws' },
      { 'x-client-device-id': userId },
    );
    assert.equal(initRevoke.status, 200);
    assert.equal(initRevoke.data.status, 'revoked');

    // 2. 使用者持退款前保存的舊 active JWS 嘗試重放開通
    const staleActiveVerifier = {
      async verify() {
        return {
          isValid: true,
          status: 'active',
          tier: 'pro',
          productId: 'exampro_yearly',
          transactionId: 'txn_stale_active',
          originalTransactionId: revokedTxnId,
          expiresDate: Date.now() + 300 * 86400000,
          environment: 'Sandbox',
          isExpired: false,
          isRevoked: false,
        };
      },
    };
    setCustomTransactionVerifier(staleActiveVerifier);

    const staleRes = await postJson(
      serverCtx.baseUrl,
      '/api/verify-transaction',
      { signedTransaction: 'mock_stale_active_jws' },
      { 'x-client-device-id': userId },
    );
    assert.equal(staleRes.status, 200);
    assert.equal(staleRes.data.status, 'revoked', '舊 active JWS 絕不能將已撤銷狀態覆蓋回 active');
    assert.equal(staleRes.data.tier, 'free');

    // 3. 再次確認使用者快取維持 free
    const ent = await getUserEntitlement(userId);
    assert.equal(ent.tier, 'free', '使用者權益必須維持 free');
  });

  // ───── 測試 17：舊 JWS 逆向覆蓋過期防護 ─────
  await t.test('17. 舊 JWS 逆向覆蓋過期防護：當伺服端已有有效續約時，收到過期舊 JWS 不得被降級為 expired', async () => {
    const renewalTxnId = 'orig_active_renewal_receipt';
    const userId = 'dev_user_with_active_renewal';
    const futureExpiry = Date.now() + 90 * 86400000;

    // 1. 先寫入有效續約記錄
    const activeVerifier = {
      async verify() {
        return {
          isValid: true,
          status: 'active',
          tier: 'pro',
          productId: 'exampro_monthly',
          transactionId: 'txn_renewed_month_3',
          originalTransactionId: renewalTxnId,
          expiresDate: futureExpiry,
          environment: 'Sandbox',
          isExpired: false,
          isRevoked: false,
        };
      },
    };
    setCustomTransactionVerifier(activeVerifier);

    const activeRes = await postJson(
      serverCtx.baseUrl,
      '/api/verify-transaction',
      { signedTransaction: 'mock_active_renewed_jws' },
      { 'x-client-device-id': userId },
    );
    assert.equal(activeRes.status, 200);
    assert.equal(activeRes.data.status, 'active');

    // 2. 客戶端送入上個月已過期的舊 JWS
    const expiredVerifier = {
      async verify() {
        return {
          isValid: true,
          status: 'expired',
          tier: 'free',
          productId: 'exampro_monthly',
          transactionId: 'txn_old_month_1',
          originalTransactionId: renewalTxnId,
          expiresDate: Date.now() - 5 * 86400000,
          environment: 'Sandbox',
          isExpired: true,
          isRevoked: false,
        };
      },
    };
    setCustomTransactionVerifier(expiredVerifier);

    await postJson(
      serverCtx.baseUrl,
      '/api/verify-transaction',
      { signedTransaction: 'mock_expired_old_jws' },
      { 'x-client-device-id': userId },
    );

    // 3. 確認使用者權限仍維持 Pro，到期日保持為 futureExpiry
    const ent = await getUserEntitlement(userId);
    assert.equal(ent.tier, 'pro', '有效續約不可被過期舊 JWS 降級');
    assert.equal(ent.expiresAt, futureExpiry);
  });
});
