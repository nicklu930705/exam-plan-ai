import { Environment } from '@apple/app-store-server-library';

/**
 * 考試計畫 AI - Apple 環境隔離與安全決策核心模組
 *
 * 核心安全職責：
 * 1. 嚴格區分後端用途：Sandbox 獨立後端 (exam-plan-ai-backend-sandbox) vs 正式後端 (exam-plan-ai-backend-coral)。
 * 2. 不得單以 NODE_ENV=production 判斷是否允許 Apple Sandbox！
 *    (因為 Sandbox Vercel 專案在正式發布時 NODE_ENV 亦為 'production')。
 * 3. 實作環境變數白名單與防呆矛盾檢驗：
 *    - APPLE_IAP_ENVIRONMENT 僅允許 'sandbox' 或 'production'。
 *    - Sandbox 後端：APPLE_IAP_ENVIRONMENT=sandbox 與 APPLE_ALLOW_SANDBOX=true (在 NODE_ENV=production 下) 100% 合法。
 *    - 正式後端：APPLE_IAP_ENVIRONMENT=production 嚴禁開啟 APPLE_ALLOW_SANDBOX=true，嚴禁接受 Sandbox 交易與通知。
 * 4. 交叉比對 Apple 簽署憑證中的 environment 與 Bundle ID，防止收據或 Webhook 跨環境注入。
 * 5. 嚴禁依賴前端傳送之可偽造 HTTP Host 或任意 Header 作為安全邊界。
 */

export const EXPECTED_BUNDLE_ID = 'com.examplanai.app';
export const EXPECTED_APP_APPLE_ID = 6823259191;

export interface AppleEnvironmentConfig {
  valid: boolean;
  targetRole: 'sandbox' | 'production';
  targetAppleEnv: Environment;
  allowSandbox: boolean;
  bundleId: string;
  appAppleId?: number;
  error?: string;
}

/**
 * 解析並嚴格校驗 Apple 後端環境配置
 */
export function resolveAppleEnvironment(): AppleEnvironmentConfig {
  const rawEnv = (
    process.env.APPLE_IAP_ENVIRONMENT ||
    process.env.BACKEND_TARGET_ENV ||
    process.env.APP_ENV ||
    ''
  )
    .trim()
    .toLowerCase();

  const rawAllowSandbox = process.env.APPLE_ALLOW_SANDBOX?.trim().toLowerCase();

  // 1. 環境白名單檢驗：若有提供，必須為 'sandbox' 或 'production'
  if (rawEnv && rawEnv !== 'sandbox' && rawEnv !== 'production') {
    return {
      valid: false,
      targetRole: 'production',
      targetAppleEnv: Environment.PRODUCTION,
      allowSandbox: false,
      bundleId: EXPECTED_BUNDLE_ID,
      error: `無效的 APPLE_IAP_ENVIRONMENT 設定值「${rawEnv}」，僅允許 "sandbox" 或 "production"。`,
    };
  }

  // 2. 確定後端目標用途 (Target Role)
  // 若未指定環境變數：
  // - 測試環境 (NODE_ENV === 'test')：預設為 sandbox，允許測試執行
  // - 其他環境：安全預設為 production (Fail-Safe 原則，避免誤用測試環境)
  let targetRole: 'sandbox' | 'production';
  if (rawEnv === 'sandbox') {
    targetRole = 'sandbox';
  } else if (rawEnv === 'production') {
    targetRole = 'production';
  } else if (process.env.NODE_ENV === 'test') {
    targetRole = 'sandbox';
  } else {
    targetRole = 'production';
  }

  // 3. Sandbox 後端規則檢驗 (exam-plan-ai-backend-sandbox)
  if (targetRole === 'sandbox') {
    // 衝突檢查：若用途宣告為 sandbox，但卻明確設定 APPLE_ALLOW_SANDBOX=false
    if (rawAllowSandbox === 'false') {
      return {
        valid: false,
        targetRole: 'sandbox',
        targetAppleEnv: Environment.SANDBOX,
        allowSandbox: false,
        bundleId: EXPECTED_BUNDLE_ID,
        error: '環境設定矛盾：後端用途為 sandbox，但 APPLE_ALLOW_SANDBOX 被設定為 false。',
      };
    }

    return {
      valid: true,
      targetRole: 'sandbox',
      targetAppleEnv: Environment.SANDBOX,
      allowSandbox: true,
      bundleId: EXPECTED_BUNDLE_ID,
    };
  }

  // 4. 正式後端規則檢驗 (exam-plan-ai-backend-coral)
  if (targetRole === 'production') {
    // 嚴格安全防護：正式後端嚴禁開啟 APPLE_ALLOW_SANDBOX=true！
    // (即使在任何環境下，只要角色是 production，就絕不接受 sandbox 收據)
    if (rawAllowSandbox === 'true') {
      return {
        valid: false,
        targetRole: 'production',
        targetAppleEnv: Environment.PRODUCTION,
        allowSandbox: false,
        bundleId: EXPECTED_BUNDLE_ID,
        appAppleId: EXPECTED_APP_APPLE_ID,
        error: '正式環境安全防護：正式後端 (APPLE_IAP_ENVIRONMENT=production) 嚴禁設定 APPLE_ALLOW_SANDBOX=true。',
      };
    }

    return {
      valid: true,
      targetRole: 'production',
      targetAppleEnv: Environment.PRODUCTION,
      allowSandbox: false,
      bundleId: EXPECTED_BUNDLE_ID,
      appAppleId: EXPECTED_APP_APPLE_ID,
    };
  }

  return {
    valid: false,
    targetRole: 'production',
    targetAppleEnv: Environment.PRODUCTION,
    allowSandbox: false,
    bundleId: EXPECTED_BUNDLE_ID,
    error: '無法識別當前 Apple 後端環境。',
  };
}

/**
 * 檢查解密後的交易環境 (verifiedEnv) 是否符合當前伺服器允許的環境
 */
export function isTransactionEnvironmentAllowed(verifiedEnv: string): boolean {
  const config = resolveAppleEnvironment();
  if (!config.valid) return false;

  const normalized = (verifiedEnv || '').trim().toLowerCase();

  if (config.targetRole === 'production') {
    // 正式後端只允許正式收據
    return normalized === 'production';
  }

  // Sandbox 後端允許 Sandbox 收據 (測試環境亦可接受)
  return normalized === 'sandbox' || (config.allowSandbox && normalized === 'production');
}

/**
 * 檢查解密後的 Webhook 通知環境是否符合當前伺服器角色
 */
export function isNotificationEnvironmentAllowed(notificationEnv: string): boolean {
  const config = resolveAppleEnvironment();
  if (!config.valid) return false;

  const normalized = (notificationEnv || '').trim().toLowerCase();

  if (config.targetRole === 'production') {
    // 正式後端嚴格只接受 Apple Production Webhook
    return normalized === 'production';
  }

  // Sandbox 後端嚴格只接受 Apple Sandbox Webhook
  return normalized === 'sandbox';
}
