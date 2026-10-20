import {
  Environment,
  JWSTransactionDecodedPayload,
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
} from '@apple/app-store-server-library';
import { getAppleRootCertificatesBuffers } from './appleCertificates';
import { isTransactionEnvironmentAllowed, resolveAppleEnvironment } from './appleEnvironment';

/**
 * 考試計畫 AI - Apple StoreKit 2 交易驗證模組
 *
 * 核心原則：
 * 1. 使用 Apple 官方 @apple/app-store-server-library 之 SignedDataVerifier。
 * 2. 嚴格驗證 Apple JWS 數位簽章與 X.509 憑證鏈，根憑證鎖定至 Apple Root CA - G3。
 * 3. 嚴格比對 Bundle ID 為 com.examplanai.app。
 * 4. 嚴格檢驗 Product ID 是否為已建立之合規商品（exampro_monthly / exampro_yearly / exampro_lifetime）。
 * 5. 檢核退款（revocationDate）與訂閱到期（expiresDate）。
 * 6. 絕不依賴客戶端宣稱之 tier、plan 或未經簽章的交易 ID。
 */

export const EXPECTED_BUNDLE_ID = 'com.examplanai.app';
export const EXPECTED_APP_APPLE_ID = 6823259191;

export const VALID_PRODUCT_CONFIG = {
  exampro_monthly: {
    productId: 'exampro_monthly',
    tier: 'pro' as const,
    type: 'subscription' as const,
    billingCycle: 'monthly' as const,
  },
  exampro_yearly: {
    productId: 'exampro_yearly',
    tier: 'pro' as const,
    type: 'subscription' as const,
    billingCycle: 'yearly' as const,
  },
  exampro_lifetime: {
    productId: 'exampro_lifetime',
    tier: 'lifetime' as const,
    type: 'non_consumable' as const,
    billingCycle: 'lifetime' as const,
  },
} as const;

export type ValidProductId = keyof typeof VALID_PRODUCT_CONFIG;

export function isValidProductId(productId: string): productId is ValidProductId {
  return Object.prototype.hasOwnProperty.call(VALID_PRODUCT_CONFIG, productId);
}

export interface AppleVerificationResult {
  isValid: boolean;
  status: 'active' | 'expired' | 'revoked' | 'invalid';
  tier: 'free' | 'pro' | 'lifetime';
  productId?: string;
  transactionId?: string;
  originalTransactionId?: string;
  purchaseDate?: number;
  originalPurchaseDate?: number;
  expiresDate?: number;
  revocationDate?: number;
  signedDate?: number;
  environment?: string;
  willRenew?: boolean;
  isExpired: boolean;
  isRevoked: boolean;
  errorMessage?: string;
}

export interface ITransactionVerifier {
  verify(signedTransaction: string, options?: { allowSandbox?: boolean }): Promise<AppleVerificationResult>;
}

/**
 * 官方 Apple StoreKit 2 JWS 交易驗證器
 */
export class AppleStoreKitVerifier implements ITransactionVerifier {
  private productionVerifier: SignedDataVerifier | null = null;
  private sandboxVerifier: SignedDataVerifier | null = null;

  private initVerifiers() {
    if (this.productionVerifier && this.sandboxVerifier) return;

    const rootCerts = getAppleRootCertificatesBuffers();
    const enableOnlineChecks = process.env.APPLE_ENABLE_ONLINE_OCSP === 'true';

    // 建立正式環境驗證器
    this.productionVerifier = new SignedDataVerifier(
      rootCerts,
      enableOnlineChecks,
      Environment.PRODUCTION,
      EXPECTED_BUNDLE_ID,
      EXPECTED_APP_APPLE_ID,
    );

    // 建立沙盒環境驗證器 (適用於 TestFlight、Xcode 與 Sandbox 測試)
    this.sandboxVerifier = new SignedDataVerifier(
      rootCerts,
      enableOnlineChecks,
      Environment.SANDBOX,
      EXPECTED_BUNDLE_ID,
    );
  }

  async verify(
    signedTransaction: string,
    options: { allowSandbox?: boolean } = {},
  ): Promise<AppleVerificationResult> {
    if (!signedTransaction || typeof signedTransaction !== 'string' || signedTransaction.trim().length === 0) {
      return {
        isValid: false,
        status: 'invalid',
        tier: 'free',
        isExpired: false,
        isRevoked: false,
        errorMessage: '未提供有效的 Apple 簽署交易憑證 (JWS)。',
      };
    }

    this.initVerifiers();

    const envConfig = resolveAppleEnvironment();
    if (!envConfig.valid) {
      return {
        isValid: false,
        status: 'invalid',
        tier: 'free',
        isExpired: false,
        isRevoked: false,
        errorMessage: envConfig.error || 'Apple 環境設定無效或衝突。',
      };
    }

    const allowSandbox = envConfig.allowSandbox && (options.allowSandbox ?? true);
    const preferredEnv = envConfig.targetRole;

    let decoded: JWSTransactionDecodedPayload | null = null;
    let verifiedEnv = '';
    let lastError: any = null;

    // 依據後端角色配置候選驗證器
    const verifiersToTry: Array<{ verifier: SignedDataVerifier; envName: string }> = [];

    if (preferredEnv === 'sandbox') {
      if (this.sandboxVerifier) verifiersToTry.push({ verifier: this.sandboxVerifier, envName: 'Sandbox' });
      // 僅在有 sandbox 權限時允許備用
      if (allowSandbox && this.productionVerifier) {
        verifiersToTry.push({ verifier: this.productionVerifier, envName: 'Production' });
      }
    } else {
      // 正式後端：嚴格僅掛載正式驗證器，絕對不允許 Sandbox
      if (this.productionVerifier) verifiersToTry.push({ verifier: this.productionVerifier, envName: 'Production' });
      if (allowSandbox && this.sandboxVerifier) {
        verifiersToTry.push({ verifier: this.sandboxVerifier, envName: 'Sandbox' });
      }
    }

    for (const { verifier, envName } of verifiersToTry) {
      try {
        decoded = await verifier.verifyAndDecodeTransaction(signedTransaction.trim());
        verifiedEnv = envName;
        break;
      } catch (err: any) {
        lastError = err;
        // 若是因為環境不吻合且還有下一個候選環境，繼續嘗試
        if (err instanceof VerificationException && err.status === VerificationStatus.INVALID_ENVIRONMENT) {
          continue;
        }
        // 若為簽章偽造、憑證損毀或 Bundle ID 錯誤，直接中斷
        break;
      }
    }

    if (!decoded) {
      const errDetail = this.formatVerificationError(lastError);
      return {
        isValid: false,
        status: 'invalid',
        tier: 'free',
        isExpired: false,
        isRevoked: false,
        errorMessage: errDetail,
      };
    }

    // 嚴格檢驗交易環境是否符合當前伺服器角色
    if (!isTransactionEnvironmentAllowed(verifiedEnv)) {
      return {
        isValid: false,
        status: 'invalid',
        tier: 'free',
        isExpired: false,
        isRevoked: false,
        errorMessage: `正式後端嚴格禁止處理 ${verifiedEnv} 交易憑證。`,
      };
    }

    // 嚴格檢查 Bundle ID
    if (decoded.bundleId !== EXPECTED_BUNDLE_ID) {
      return {
        isValid: false,
        status: 'invalid',
        tier: 'free',
        isExpired: false,
        isRevoked: false,
        errorMessage: `交易應用程式識別碼不相符 (預期 ${EXPECTED_BUNDLE_ID}，實際 ${decoded.bundleId || '空值'})。`,
      };
    }

    // 嚴格檢查 Product ID
    const productId = decoded.productId || '';
    if (!isValidProductId(productId)) {
      return {
        isValid: false,
        status: 'invalid',
        tier: 'free',
        isExpired: false,
        isRevoked: false,
        errorMessage: `未知的產品識別碼「${productId}」，非合法考試計畫 AI 方案。`,
      };
    }

    const productConfig = VALID_PRODUCT_CONFIG[productId];
    const now = Date.now();

    // 檢查退款與撤銷狀態
    const isRevoked = Boolean(decoded.revocationDate && decoded.revocationDate > 0);
    if (isRevoked) {
      return {
        isValid: true,
        status: 'revoked',
        tier: 'free',
        productId,
        transactionId: decoded.transactionId,
        originalTransactionId: decoded.originalTransactionId || decoded.transactionId,
        purchaseDate: decoded.purchaseDate,
        originalPurchaseDate: decoded.originalPurchaseDate,
        expiresDate: decoded.expiresDate,
        revocationDate: decoded.revocationDate,
        signedDate: decoded.signedDate,
        environment: verifiedEnv,
        isExpired: false,
        isRevoked: true,
        errorMessage: '此交易已被 Apple 撤銷或退款。',
      };
    }

    // 檢查訂閱是否到期 (僅針對自動續訂型商品)
    if (productConfig.type === 'subscription') {
      const expiresDate = decoded.expiresDate;
      if (!expiresDate || typeof expiresDate !== 'number') {
        return {
          isValid: false,
          status: 'invalid',
          tier: 'free',
          productId,
          transactionId: decoded.transactionId,
          originalTransactionId: decoded.originalTransactionId || decoded.transactionId,
          isExpired: true,
          isRevoked: false,
          errorMessage: '訂閱型交易遺漏有效到期時間 (expiresDate)。',
        };
      }

      if (expiresDate < now) {
        return {
          isValid: true,
          status: 'expired',
          tier: 'free',
          productId,
          transactionId: decoded.transactionId,
          originalTransactionId: decoded.originalTransactionId || decoded.transactionId,
          purchaseDate: decoded.purchaseDate,
          originalPurchaseDate: decoded.originalPurchaseDate,
          expiresDate,
          signedDate: decoded.signedDate,
          environment: verifiedEnv,
          isExpired: true,
          isRevoked: false,
          errorMessage: '此訂閱方案已到期。',
        };
      }
    }

    // 驗證成功且有效！
    return {
      isValid: true,
      status: 'active',
      tier: productConfig.tier,
      productId,
      transactionId: decoded.transactionId,
      originalTransactionId: decoded.originalTransactionId || decoded.transactionId,
      purchaseDate: decoded.purchaseDate,
      originalPurchaseDate: decoded.originalPurchaseDate,
      expiresDate: decoded.expiresDate,
      signedDate: decoded.signedDate,
      environment: verifiedEnv,
      isExpired: false,
      isRevoked: false,
    };
  }

  private formatVerificationError(err: any): string {
    if (!err) return 'Apple 交易驗證未通過。';
    if (err instanceof VerificationException) {
      switch (err.status) {
        case VerificationStatus.INVALID_APP_IDENTIFIER:
          return '交易 Bundle ID 與本應用程式不符。';
        case VerificationStatus.INVALID_ENVIRONMENT:
          return '交易環境不相符 (沙盒/正式環境不一致)。';
        case VerificationStatus.INVALID_CHAIN_LENGTH:
        case VerificationStatus.INVALID_CERTIFICATE:
        case VerificationStatus.VERIFICATION_FAILURE:
          return 'Apple 交易數位簽章或憑證鏈驗證失敗。';
        default:
          return '交易憑證格式不正確或驗證失敗。';
      }
    }
    return '交易憑證驗證過程發生未預期錯誤。';
  }
}

// 測試注入與單例管理
let customVerifier: ITransactionVerifier | null = null;
export function setCustomTransactionVerifier(verifier: ITransactionVerifier | null) {
  customVerifier = verifier;
}

export function getTransactionVerifier(): ITransactionVerifier {
  return customVerifier || new AppleStoreKitVerifier();
}
