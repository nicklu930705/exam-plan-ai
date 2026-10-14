# 考試計畫 AI - 後端 API (OpenAI / Google Gemini 雙引擎服務)

本專案為「考試計畫 AI」iPhone App 的獨立後端 API，支援 OpenAI API（預設使用 `gpt-5.6-luna`）與 Google Gemini API 雙引擎架構，為考生提供量身訂做的繁體中文讀書建議與備考策略。

---

## 核心設計理念（安全與零洩漏原則）

1. **零金鑰原則（Zero-Key Principle）**：
   * `OPENAI_API_KEY` 與 `GEMINI_API_KEY` 嚴格僅保存在本後端的 Vercel 環境變數中。
   * **絕對禁止**將金鑰放置於 Expo App、前端程式碼、`EXPO_PUBLIC_` 變數或 Git 倉庫中。
2. **AI 只提供建議，不覆蓋排程**：
   * 所有每日讀書日程、倒數計時與時間上限，100% 由前端的 TypeScript 確定性排程引擎計算。
   * AI 僅扮演「學習策略教練」角色，提供暖心鼓勵、弱科突破要訣與負荷可行性分析。
3. **健全的保護機制**：
   * **請求大小限制**：限制 15 KB 以下，防止大封包攻擊。
   * **來源 IP 限流（Rate Limit）**：每 IP 每分鐘上限 10 次，防止濫刷。
   * **20 秒安全逾時保護**：避免網路遲緩造成無止境等待。
   * **優雅降級**：當 API 發生異常或網路中斷時，App 自動無縫切換為本機規則建議，絕不崩潰。

---

## 目錄結構

```text
backend/
├── api/
│   └── study-advice.ts       # 主要 API 端點: POST /api/study-advice
├── lib/
│   ├── openai.ts             # 封裝 OpenAI 官方 SDK 呼叫 (預設 gpt-5.6-luna)
│   ├── gemini.ts             # 封裝 Google @google/genai SDK 呼叫 (備援方案)
│   ├── rateLimit.ts          # 來源 IP 簡易防刷機制
│   ├── types.ts              # 請求與回應型別定義
│   └── validation.ts         # 嚴格的輸入資料欄位防呆檢查
├── .env.example              # 環境變數範本
├── .gitignore                # 忽略 node_modules 與 .env
├── package.json              # 依賴設定
├── tsconfig.json             # TypeScript 編譯設定
├── vercel.json               # Vercel 部署與 CORS 跨域設定
└── README.md                 # 說明文件
```

---

## 環境變數設定說明 (Vercel)

在 Vercel 專案後台的 **Settings ➔ Environment Variables** 中設定：

### 1. OpenAI 設定 (主要方案 - 推薦)
| 變數名稱 | 必填 | 預設值 | 說明 |
| :--- | :--- | :--- | :--- |
| `OPENAI_API_KEY` | 是 (使用 OpenAI 時) | 無 | 您的 OpenAI API Key (格式為 `sk-proj-...` 或 `sk-...`) |
| `OPENAI_MODEL` | 否 | `gpt-5.6-luna` | 指定的模型名稱 (例如：`gpt-5.6-luna`、`gpt-4o-mini`) |

### 2. Google Gemini 設定 (可切換備援方案)
| 變數名稱 | 必填 | 預設值 | 說明 |
| :--- | :--- | :--- | :--- |
| `GEMINI_API_KEY` | 是 (使用 Gemini 時) | 無 | 您的 Google AI Studio API Key |
| `GEMINI_MODEL` | 否 | `gemini-3.8-flash` | 指定的 Gemini 模型名稱 |

### 3. 提供商切換開關 (選填)
| 變數名稱 | 必填 | 預設值 | 說明 |
| :--- | :--- | :--- | :--- |
| `AI_PROVIDER` | 否 | `openai` | 強制指定使用的提供商：可填 `openai` 或 `gemini`。若未設定，後端偵測到 `OPENAI_API_KEY` 時會自動優先使用 OpenAI。 |

---

## 部署到 Vercel 步驟

1. 將本專案（或 `backend` 資料夾）提交並推送至您的 GitHub 儲存庫。
2. 登入 [Vercel 控制台 (https://vercel.com/)](https://vercel.com/) ➔ 點進 `exam-plan-ai-backend-coral`。
3. 點選 **Settings** ➔ **Environment Variables**：
   - 新增 `OPENAI_API_KEY`，填入您的 OpenAI 金鑰。
   - （選填）新增 `OPENAI_MODEL`，設定為 `gpt-5.6-luna`。
4. 前往 **Deployments** 頁籤，在最上方最新部署右側點擊 `...` ➔ **Redeploy**。
5. 等待約 20 秒，後端即自動更新啟用 OpenAI！

---

## API 規格說明

### `POST /api/study-advice`

#### 請求標頭 (Request Headers)
```http
Content-Type: application/json
```

#### 請求範例 (Request Body)
```json
{
  "examName": "多益英語測驗",
  "examDate": "2026-11-12",
  "dailyAvailableMinutes": 90,
  "intensity": "normal",
  "subjects": [
    {
      "name": "聽力",
      "familiarity": 2,
      "totalChapters": 4,
      "completedChapters": 1
    },
    {
      "name": "閱讀",
      "familiarity": 1,
      "totalChapters": 4,
      "completedChapters": 0
    }
  ],
  "recentCompletionRate": 25,
  "behindTasksCount": 2
}
```

#### 回應範例 (Response Body - 200 OK)
```json
{
  "success": true,
  "advice": {
    "summary": "距離考試尚有一個月，閱讀部分進度稍有落後且熟悉度較低，建議本週集中火力在長篇填空與破題練習。",
    "focusSubjects": ["閱讀", "聽力 Part 2"],
    "actionableTips": [
      "每天利用精神最佳的前 45 分鐘先做閱讀題目。",
      "聽力熟悉度佳，可運用計時器於零碎時間進行維持題感。",
      "週末利用排程中的緩衝時間補齊落後的 2 項任務，切勿熬夜打亂節奏。"
    ],
    "estimatedFeasibility": "目前每日 90 分鐘時間充裕，維持規律即可順利在考前完成全部範圍。"
  },
  "source": "openai_ai",
  "disclaimer": "AI 建議僅供學習策略與心理激勵參考；每日讀書日程與時間限制仍由排程引擎安全計算。"
}
```
