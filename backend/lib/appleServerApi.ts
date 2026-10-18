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

    try {
      // 處理多行 PEM 格式或 base64 編碼金鑰
      let signingKeyPem = rawKey;
      if (!signingKeyPem.includes('-----BEGIN PRIVATE KEY-----')) {
        // 嘗試以 base64 解碼
        try {
          const decoded = Buffer.from(signingKeyPem, 'base64').toString('utf8');
          if (decoded.includes('-----BEGIN PRIVATE KEY-----')) {
            signingKeyPem = decoded;
          }
        } catch {
          // 維持原始字串
        }
      }

      this.client = new AppStoreServerAPIClient(
        signingKeyPem,
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
