# 考試計畫 AI - 後端 API (OpenAI / Google Gemini 雙引擎 + Upstash Redis 用量與預算控制)

本專案為「考試計畫 AI」iPhone App 的獨立後端 API，部署於 Vercel Serverless。支援 OpenAI API（預設使用 `gpt-5.6-luna`）與 Google Gemini API 雙引擎架構，並透過 **Upstash Redis REST API** 實作原子級用量限制、防並行濫用、每分鐘限流與伺服端每日/每月成本預算控制。

---

## 核心架構與安全設計

### 1. 零金鑰與安全原則（Zero-Key Principle）
* `OPENAI_API_KEY`、`GEMINI_API_KEY` 與 `UPSTASH_REDIS_REST_TOKEN` 嚴格僅保存在 Vercel 後端環境變數。
* **絕對禁止**將金鑰放入 Expo App、前端程式碼、`EXPO_PUBLIC_` 變數或 Git 倉庫。
* 日誌僅記錄匿名化 User ID 與摘要 Token 數，嚴格禁止記錄敏感學習筆記與金鑰。

### 2. Upstash Redis 原子預扣與結算引擎 (Lua Scripts)
為了解決 Serverless 無狀態執行個體之間的並行競爭（Race Condition），採用 Redis Lua 腳本進行三階段控制：
1. **呼叫前原子檢查與預扣 (`PRE_FLIGHT_LUA`)**：
   - **冪等性快取 (`exam_ai:idempotency:<key>`)**：若命中 10 分鐘內的重送鍵，直接回傳快取回應，不重複扣額與呼叫 OpenAI。
   - **進行中並行鎖 (`exam_ai:lock:<userId>`)**：單一使用者同時間僅允許 1 筆進行中的請求（TTL 30s）。
   - **當日配額檢查 (`exam_ai:usage:day:<date>:<userId>`)**：免費版每日 3 次、Pro 每日 15 次（優先判斷，避免額度用完卻誤報頻率限制）。
   - **每日總預算檢查 (`exam_ai:budget:day:<date>`)**：預設上限 US$0.50。
   - **每月總預算檢查 (`exam_ai:budget:month:<month>`)**：預設上限 US$5.00。
   - **每分鐘頻率檢查 (`exam_ai:ratelimit:min:<userId>:<min>`)**：每分鐘最多 3 次。
   - **原子預扣**：同時通過後，原子增加當日計數與預扣預估費用（以該模型最大輸出 Token 估算），防止並行請求超支。
2. **呼叫成功結算 (`SETTLE_SUCCESS_LUA`)**：
   - 根據 OpenAI 回傳的實際 Token 數量計算精準費用（依據模型費率表）。
   - 補正預留金額與實際金額的差額（多退少補），儲存冪等快取，並釋放並行鎖。
3. **呼叫失敗/逾時釋放 (`SETTLE_FAILURE_LUA`)**：
   - 若呼叫 OpenAI 逾時（20 秒）或 API 發生 500 錯誤，立即原子扣回已預扣的次數與預算，並釋放並行鎖，不浪費使用者額度。
4. **安全關閉策略（Fail-Closed）**：
   - 若正式環境無法連線至 Upstash Redis 或缺少憑證，直接回傳 `503 STORAGE_UNAVAILABLE`，絕不退回不可靠的伺服器記憶體計數。

### 3. 台北時區每日重置機制
* 所有每日配額與單日預算均以 **`Asia/Taipei` (UTC+8)** 時區判定。
* 每日於台北時間 00:00:00 自動重設，TTL 計算精準對齊台北時間午夜。

### 4. 匿名身分方案與防濫用限制
* **現有方案**：App 於本機首次啟動時產生持久化 UUID (`X-Client-Device-Id`) 儲存於 AsyncStorage。若未提供則退回客戶端 IP SHA-256 雜湊。
* **防濫用能力說明**：
  - 此方案能有效限制正常使用者的每日次數與防手震重複提交。
  - **限制**：若使用者手動解除安裝 App 並重新下載，本機 UUID 會被重設。在尚未導入 Apple ID 登入或帳號系統前，單靠裝置 ID 無法 100% 杜絕重裝刷額度的惡意攻擊。
* **Pro 會員防偽造機制**：
  - 前端傳來的 `tier='pro'` 或 `plan='pro'` 視為**未驗證資料**。
  - 後端預設一律將其降為 Free（3 次/日），直到提供有效的 Apple App Store Server 憑證。

### 5. Apple In-App Purchase (StoreKit) 伺服端驗證介面
* 目前 iPhone App 採用本機 StoreKit 2 交易管理。
* 後端已於 `backend/lib/identity.ts` 預留 `verifyAppleTransaction(token)` 驗證介面。
* **後續待完成事項**：
  - 於 App Store Connect 申請 App Store Server API 金鑰 (.p8)。
  - 設定 `APPLE_ISSUER_ID`、`APPLE_KEY_ID`、`APPLE_PRIVATE_KEY` 與 `APPLE_BUNDLE_ID`。
  - 於客戶端購妥後傳遞 JWS SignedTransaction 供後端驗證，驗證通過才升級為 Pro（15 次/日）。

---

## Redis 鍵值設計 (Key Architecture)

| Redis Key 格式 | 類型 | 說明 | 預設 TTL |
| :--- | :--- | :--- | :--- |
| `exam_ai:lock:<userId>` | String | 進行中並行鎖 (NX EX) | 30 秒 |
| `exam_ai:ratelimit:min:<userId>:<YYYYMMDDHHmm>` | Integer | 每分鐘請求次數 (上限 3 次) | 60 秒 |
| `exam_ai:usage:day:<YYYY-MM-DD>:<userId>` | Integer | 使用者當日已用次數 (Free: 3, Pro: 15) | 台北午夜 + 1小時 |
| `exam_ai:budget:day:<YYYY-MM-DD>` | Integer | 當日全系統累計微美元 (Micro USD) | 台北午夜 + 1小時 |
| `exam_ai:budget:month:<YYYY-MM>` | Integer | 當月全系統累計微美元 (Micro USD) | 台北月底 + 24小時 |
| `exam_ai:idempotency:<idempotencyKey>` | String | 成功回應快取 JSON | 600 秒 (10分鐘) |

---

## 環境變數清單 (Vercel 後端)

在 Vercel 專案後台 **Settings ➔ Environment Variables** 設定（請加入 **Production** 與 **Preview** 環境）：

### 1. AI 提供商金鑰
| 變數名稱 | 必填 | 預設值 | 說明 |
| :--- | :--- | :--- | :--- |
| `OPENAI_API_KEY` | 是 | 無 | OpenAI Platform API Key (格式為 `sk-proj-...` 或 `sk-...`) |
| `OPENAI_MODEL` | 否 | `gpt-5.6-luna` | 指定的模型名稱 (支援 `gpt-5.6-luna`、`gpt-4o-mini` 等) |
| `GEMINI_API_KEY` | 否 | 無 | Google AI Studio 金鑰 (備援方案) |
| `GEMINI_MODEL` | 否 | `gemini-3.8-flash` | Gemini 模型名稱 |
| `AI_PROVIDER` | 否 | `openai` | 強制指定使用 `openai` 或 `gemini` |

### 2. Upstash Redis REST 連線
| 變數名稱 | 必填 | 說明 |
| :--- | :--- | :--- |
| `UPSTASH_REDIS_REST_URL` | 是 (正式環境) | Upstash 控制台之 REST URL (例如 `https://xxx.upstash.io`) |
| `UPSTASH_REDIS_REST_TOKEN` | 是 (正式環境) | Upstash 控制台之 REST Token |

> **提示**：可直接在 Vercel 專案的 **Integrations ➔ Upstash** 一鍵安裝，Vercel 會自動注入上述兩項變數！

### 3. 限額與預算控制變數 (選填，未填則自動採用安全預設值)
| 變數名稱 | 預設值 | 說明 |
| :--- | :--- | :--- |
| `FREE_DAILY_AI_LIMIT` | `3` | 免費版每日請求上限 |
| `PRO_DAILY_AI_LIMIT` | `15` | Pro 會員每日請求上限 |
| `AI_RATE_LIMIT_PER_MINUTE` | `3` | 單一使用者每分鐘上限 |
| `AI_DAILY_BUDGET_USD` | `0.5` | 每日伺服器總支出上限 (美元) |
| `AI_MONTHLY_BUDGET_USD` | `5.0` | 每月伺服器總支出上限 (美元) |
| `AI_BUDGET_WARNING_PERCENT` | `50` | 支出達預算 50% 時記錄警訊 |
| `AI_MAX_INPUT_CHARS` | `4000` | 請求內文總字數上限 |
| `AI_MAX_OUTPUT_TOKENS` | `600` | 模型生成輸出最大 Token 數 |
| `AI_REQUEST_TIMEOUT_MS` | `20000` | API 請求逾時時間 (20 秒) |
| `AI_MAX_RETRIES` | `1` | 遇非預期錯誤最大重試次數 |

---

## 部署到 Vercel 步驟

1. 推送最新的程式碼至 GitHub `main` 分支。
2. 開啟 [Upstash 控制台 (https://console.upstash.com/)](https://console.upstash.com/) 建立免費 Redis 資料庫（區域建議選擇靠近台灣的 `ap-southeast-1` 新加坡 或 `us-east-1`）。
3. 取得 **REST API** 的 `UPSTASH_REDIS_REST_URL` 與 `UPSTASH_REDIS_REST_TOKEN`。
4. 登入 [Vercel 專案後台](https://vercel.com/) ➔ **Settings** ➔ **Environment Variables**：
   - 確保 `OPENAI_API_KEY` 在 **Production** 環境中。
   - 新增 `UPSTASH_REDIS_REST_URL` 與 `UPSTASH_REDIS_REST_TOKEN`。
5. 前往 **Deployments** 點選 **Redeploy**。

---

## 實際測試與驗證方式

### 1. 執行單元與並行測試
在本地端執行測試（內建 Redis Mock 與 OpenAI Mock，14 項嚴格測試）：
```bash
cd backend
npm test
```
涵蓋：
- 405 Method Not Allowed / 400 Invalid Input / 400 Max Chars / 413 Payload Size
- 503 Storage Unavailable (Fail-Closed) / 500 Missing Key
- 免費版第 4 次 429 DAILY_QUOTA_EXCEEDED 拒絕
- Pro 偽造降級為 Free 防禦
- 並行請求鎖 CONCURRENT_REQUEST (200ms 並行測試)
- 每分鐘 3 次速率限制 RATE_LIMIT_EXCEEDED
- 冪等性快取 X-Idempotency-Key
- 單日預算上限 DAILY_BUDGET_EXCEEDED
- 失敗安全退款與額度回復

### 2. 使用 curl 測試正式環境端點
```bash
# 測試第 1 次呼叫 (正常成功，回傳 quota 資訊)
curl -X POST https://exam-plan-ai-backend-coral.vercel.app/api/study-advice \
  -H "Content-Type: application/json" \
  -H "X-Client-Device-Id: test_device_curl_001" \
  -d '{
    "examName": "多益英語測驗",
    "examDate": "2026-11-15",
    "dailyAvailableMinutes": 90,
    "intensity": "normal",
    "subjects": [
      { "name": "閱讀", "familiarity": 1, "totalChapters": 10, "completedChapters": 2 },
      { "name": "聽力", "familiarity": 2, "totalChapters": 10, "completedChapters": 4 }
    ],
    "recentCompletionRate": 80,
    "behindTasksCount": 1
  }'
```
回應中的 `quota` 欄位將顯示：
```json
"quota": {
  "usedToday": 1,
  "dailyLimit": 3,
  "remainingToday": 2,
  "tier": "free",
  "resetsAt": "2026-10-16T00:00:00+08:00"
}
```
連續發送 4 次即可親自驗證被 `429 DAILY_QUOTA_EXCEEDED` 安全阻擋！

