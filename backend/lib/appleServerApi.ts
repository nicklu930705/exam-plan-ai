import {
  AppStoreServerAPIClient,
  Environment,
  HistoryResponse,
  RefundHistoryResponse,
  Status,
  StatusResponse,
  TransactionHistoryRequest,
  TransactionInfoResponse,
} from '@apple/app-store-server-library';
import crypto from 'node:crypto';
import { EXPECTED_BUNDLE_ID, resolveAppleEnvironment } from './appleEnvironment';

/**
 * 考試計畫 AI - Apple App Store Server API 客戶端封裝模組 (v2)
 *
 * 核心規範：
 * 1. 使用 Apple 官方 @apple/app-store-server-library 之 AppStoreServerAPIClient。
 * 2. 所有憑證嚴格自後端環境變數讀取 (APPLE_API_PRIVATE_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER_ID)。
 *    嚴禁在原始碼、測試檔或前端硬編碼任何私鑰。
 * 3. 憑證未配置時安全回報不可用 (Fail-Safe)，絕不拋出未捕獲例外，絕不影響既有購買驗證 API。
 * 4. 支援 Sandbox / Production 環境動態選定。
 * 5. 支援測試專用 Mock Client 注入，確保自動化測試 100% 覆蓋。
 */

export interface ApplePrivateKeyValidationResult {
  valid: boolean;
  normalizedPem?: string;
  error?: string;
}

/**
 * 安全正規化與前置驗證 Apple App Store Server API EC (ES256) 私鑰
 *
 * 支援情境：
 * 1. 標準多行 PKCS#8 PEM 字串
 * 2. 包含字面 \\n 的單行 PEM 字串（如 Vercel 環境變數貼入或轉譯）
 * 3. 完整 PKCS#8 PEM 經 Base64 編碼的字串
 * 4. 首尾帶有雙引號或單引號包裹的字串
 *
 * 安全限制：
 * - 嚴格要求完整 PEM 結構（包含 -----BEGIN/END PRIVATE KEY-----）
 * - 絕不替缺少 Header/Footer 的字串拼湊 PEM 結構，避免誤收錯誤或不合規金鑰
 * - 使用 Node.js crypto.createPrivateKey 進行前置驗證：
 *   - type 必須為 'private'
 *   - asymmetricKeyType 必須為 'ec'
 *   - namedCurve 必須為 'prime256v1' (P-256)
 * - 發生錯誤時絕不洩漏私鑰內容、PEM 本體或環境變數內容
 */
export function normalizeAndValidateApplePrivateKey(rawKey: string): ApplePrivateKeyValidationResult {
  if (!rawKey || typeof rawKey !== 'string') {
    return { valid: false, error: '未提供私鑰內容。' };
  }

  let keyStr = rawKey.trim();

  // 1. 去除首尾外層引號（若在環境變數或 JSON 中包裹了 "..." 或 '...'）
  if (
    (keyStr.startsWith('"') && keyStr.endsWith('"')) ||
    (keyStr.startsWith("'") && keyStr.endsWith("'"))
  ) {
    keyStr = keyStr.slice(1, -1).trim();
  }

  // 2. 若不含 BEGIN PRIVATE KEY，嘗試檢查是否為完整 PEM 經 Base64 編碼
  if (!keyStr.includes('-----BEGIN PRIVATE KEY-----')) {
    try {
      const decoded = Buffer.from(keyStr, 'base64').toString('utf8').trim();
      if (decoded.includes('-----BEGIN PRIVATE KEY-----')) {
        keyStr = decoded;
      }
    } catch {
      // 忽略解碼錯誤，後續將依 PEM 完整性校驗判定
    }
  }

  // 3. 處理字面上的 \\n 換行（轉為實體換行 \n）與 Windows \r\n 換行
  if (keyStr.includes('\\n')) {
    keyStr = keyStr.replace(/\\n/g, '\n');
  }
  keyStr = keyStr.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

  // 4. 嚴格檢查 PKCS#8 PEM Header 與 Footer 完整性（不得替缺失者拼湊結構）
  const hasBegin = keyStr.includes('-----BEGIN PRIVATE KEY-----');
  const hasEnd = keyStr.includes('-----END PRIVATE KEY-----');
  if (!hasBegin || !hasEnd) {
    return {
      valid: false,
      error: 'Apple 私鑰格式無效：缺少完整的 PKCS#8 PEM 標頭或頁尾 (-----BEGIN/END PRIVATE KEY-----)。',
    };
  }

  // 5. 使用 Node.js crypto.createPrivateKey 前置語法校驗
  let keyObject: crypto.KeyObject;
  try {
    keyObject = crypto.createPrivateKey(keyStr);
  } catch {
    return {
      valid: false,
      error: 'Apple 私鑰解析失敗：無法以 OpenSSL 解析為有效私鑰。',
    };
  }

  // 6. 校驗金鑰屬性：type 必須為 private、asymmetricKeyType 必須為 ec、曲線必須為 prime256v1 / P-256
  if (keyObject.type !== 'private') {
    return {
      valid: false,
      error: 'Apple 私鑰類型無效：必須為非對稱私鑰 (private key)。',
    };
  }

  if (keyObject.asymmetricKeyType !== 'ec') {
    return {
      valid: false,
      error: `Apple 私鑰演算法不符：預期為 EC 橢圓曲線金鑰，實際為 ${keyObject.asymmetricKeyType || '未知'}。`,
    };
  }

  const namedCurve = (keyObject.asymmetricKeyDetails?.namedCurve || '').toLowerCase();
  const validCurves = ['prime256v1', 'secp256r1', 'p-256'];
  if (!validCurves.includes(namedCurve)) {
    return {
      valid: false,
      error: `Apple 私鑰曲線不符：ES256 要求 prime256v1 (P-256) 曲線，實際為 ${namedCurve || '未知'}。`,
    };
  }

  return {
    valid: true,
    normalizedPem: keyStr,
  };
}

export interface AppleServerApiConfig {
  privateKey: string;
  keyId: string;
  issuerId: string;
  bundleId: string;
  environment: Environment;
}

export interface AppleServerApiStatus {
  isConfigured: boolean;
  environment: 'sandbox' | 'production';
  keyId?: string;
  issuerId?: string;
  bundleId: string;
  reason?: string;
}

export class AppleServerApiNotConfiguredError extends Error {
  constructor(message = 'Apple App Store Server API 金鑰尚未配置，服務暫時不可用。') {
    super(message);
    this.name = 'AppleServerApiNotConfiguredError';
  }
}

/**
 * 抽象介面：供後端主動查詢 Apple 訂閱與退款狀態
 */
export interface IAppleServerApiClient {
  isConfigured(): boolean;
  getStatus(): AppleServerApiStatus;
  getAllSubscriptionStatuses(anyTransactionId: string, status?: Status[]): Promise<StatusResponse>;
  getTransactionHistory(
    anyTransactionId: string,
    revision?: string | null,
    request?: TransactionHistoryRequest,
  ): Promise<HistoryResponse>;
  getRefundHistory(anyTransactionId: string, revision?: string | null): Promise<RefundHistoryResponse>;
  getTransactionInfo(transactionId: string): Promise<TransactionInfoResponse>;
}

export function resolveAppleServerApiEnvironment(): {
  valid: boolean;
  targetEnv: Environment;
  envString: 'sandbox' | 'production';
  error?: string;
} {
  const env = resolveAppleEnvironment();
  return {
    valid: env.valid,
    targetEnv: env.targetAppleEnv,
    envString: env.targetRole,
    error: env.error,
  };
}

/**
 * 官方 AppStoreServerAPIClient 實作封裝
 */
export class AppleServerApiClientWrapper implements IAppleServerApiClient {
  private client: AppStoreServerAPIClient | null = null;
  private configStatus: AppleServerApiStatus | null = null;

  constructor() {
    this.initClient();
  }

  private initClient(): void {
    const envRes = resolveAppleServerApiEnvironment();
    if (!envRes.valid) {
      this.configStatus = {
        isConfigured: false,
        environment: envRes.envString,
        bundleId: EXPECTED_BUNDLE_ID,
        reason: envRes.error || '環境變數設定衝突或無效。',
      };
      this.client = null;
      return;
    }

    const targetEnv = envRes.targetEnv;
    const envString = envRes.envString;

    const rawKey = process.env.APPLE_API_PRIVATE_KEY?.trim();
    const keyId = process.env.APPLE_API_KEY_ID?.trim();
    const issuerId = process.env.APPLE_API_ISSUER_ID?.trim();

    if (!rawKey || !keyId || !issuerId) {
      const missingFields: string[] = [];
      if (!rawKey) missingFields.push('APPLE_API_PRIVATE_KEY');
      if (!keyId) missingFields.push('APPLE_API_KEY_ID');
      if (!issuerId) missingFields.push('APPLE_API_ISSUER_ID');

      this.configStatus = {
        isConfigured: false,
        environment: envString,
        bundleId: EXPECTED_BUNDLE_ID,
        reason: `缺少必要之環境變數: ${missingFields.join(', ')}。`,
      };
      this.client = null;
      return;
    }

    const keyValidation = normalizeAndValidateApplePrivateKey(rawKey);
    if (!keyValidation.valid || !keyValidation.normalizedPem) {
      this.configStatus = {
        isConfigured: false,
        environment: envString,
        bundleId: EXPECTED_BUNDLE_ID,
        reason: `Apple Server API 私鑰校驗失敗: ${keyValidation.error || '金鑰無效'}`,
      };
      this.client = null;
      return;
    }

    try {
      this.client = new AppStoreServerAPIClient(
        keyValidation.normalizedPem,
        keyId,
        issuerId,
        EXPECTED_BUNDLE_ID,
        targetEnv,
      );

      this.configStatus = {
        isConfigured: true,
        environment: envString,
        keyId,
        issuerId,
        bundleId: EXPECTED_BUNDLE_ID,
      };
    } catch (err: any) {
      this.configStatus = {
        isConfigured: false,
        environment: envString,
        bundleId: EXPECTED_BUNDLE_ID,
        reason: `Apple Server API 客戶端初始化失敗: ${err?.message || '金鑰解析錯誤'}`,
      };
      this.client = null;
    }
  }

  isConfigured(): boolean {
    return Boolean(this.client && this.configStatus?.isConfigured);
  }

  getStatus(): AppleServerApiStatus {
    if (!this.configStatus) {
      this.initClient();
    }
    return (
      this.configStatus || {
        isConfigured: false,
        environment: 'production',
        bundleId: EXPECTED_BUNDLE_ID,
        reason: '尚未初始化。',
      }
    );
  }

  private ensureClient(): AppStoreServerAPIClient {
    if (!this.client) {
      const status = this.getStatus();
      throw new AppleServerApiNotConfiguredError(status.reason);
    }
    return this.client;
  }

  async getAllSubscriptionStatuses(
    anyTransactionId: string,
    status?: Status[],
  ): Promise<StatusResponse> {
    const client = this.ensureClient();
    if (!anyTransactionId || typeof anyTransactionId !== 'string' || anyTransactionId.trim().length === 0) {
      throw new Error('未提供有效之交易識別碼 (anyTransactionId)。');
    }
    return client.getAllSubscriptionStatuses(anyTransactionId.trim(), status);
  }

  async getTransactionHistory(
    anyTransactionId: string,
    revision: string | null = null,
    request?: TransactionHistoryRequest,
  ): Promise<HistoryResponse> {
    const client = this.ensureClient();
    if (!anyTransactionId || typeof anyTransactionId !== 'string' || anyTransactionId.trim().length === 0) {
      throw new Error('未提供有效之交易識別碼 (anyTransactionId)。');
    }
    return client.getTransactionHistory(anyTransactionId.trim(), revision, request || {});
  }

  async getRefundHistory(
    anyTransactionId: string,
    revision: string | null = null,
  ): Promise<RefundHistoryResponse> {
    const client = this.ensureClient();
    if (!anyTransactionId || typeof anyTransactionId !== 'string' || anyTransactionId.trim().length === 0) {
      throw new Error('未提供有效之交易識別碼 (anyTransactionId)。');
    }
    return client.getRefundHistory(anyTransactionId.trim(), revision);
  }

  async getTransactionInfo(transactionId: string): Promise<TransactionInfoResponse> {
    const client = this.ensureClient();
    if (!transactionId || typeof transactionId !== 'string' || transactionId.trim().length === 0) {
      throw new Error('未提供有效之交易識別碼 (transactionId)。');
    }
    return client.getTransactionInfo(transactionId.trim());
  }
}

// 測試注入與單例管理
let customServerApiClient: IAppleServerApiClient | null = null;

export function setCustomAppleServerApiClient(client: IAppleServerApiClient | null) {
  customServerApiClient = client;
}

export function getAppleServerApiClient(): IAppleServerApiClient {
  return customServerApiClient || new AppleServerApiClientWrapper();
}
