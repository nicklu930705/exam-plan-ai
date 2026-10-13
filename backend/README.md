# 考試計畫 AI - 後端 API (Google Gemini 代理服務)

本專案為「考試計畫 AI」iPhone App 的獨立後端 API，專門用於安全調用 Google Gemini API，提供客製化繁體中文讀書建議。

---

## 核心設計理念（安全與零洩漏原則）

1. **零金鑰原則（Zero-Key Principle）**：
   * `GEMINI_API_KEY` 嚴格僅保存在本後端的環境變數中。
   * **絕對禁止**將金鑰放置於 Expo App、前端程式碼、`EXPO_PUBLIC_` 變數或 Git 倉庫中。
2. **AI 只提供建議，不覆蓋排程**：
   * 所有每日讀書日程、倒數計時與時間上限，100% 由前端的 TypeScript 確定性排程引擎計算。
   * AI 僅扮演「學習策略教練」角色，提供暖心鼓勵、弱科突破要訣與負荷可行性分析。
3. **健全的保護機制**：
   * **請求大小限制**：限制 15 KB 以下，防止大封包攻擊。
   * **來源 IP 限流（Rate Limit）**：每 IP 每分鐘上限 10 次，保護 Gemini 免費額度。
   * **12 秒逾時保護**：Google 塞車時自動超時並通知前端。
   * **優雅降級**：額度耗盡 (429) 或網路異常時，App 自動無縫切換為本機規則建議，絕不崩潰。

---

## 目錄結構

```text
backend/
├── api/
│   └── study-advice.ts       # 主要 API 端點: POST /api/study-advice
├── lib/
│   ├── gemini.ts             # 封裝 Google @google/genai SDK 呼叫
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

## 本地開發與測試步驟

### 1. 安裝依賴
```bash
npm install
```

### 2. 設定環境變數
建立本機 `.env` 檔案（請參考 `.env.example`）：
```bash
cp .env.example .env
```
在 `.env` 中填入您的 Google AI Studio API Key：
```env
GEMINI_API_KEY=AIzaSy...您的金鑰...
GEMINI_MODEL=gemini-2.5-flash
```

### 3. 本地啟動伺服器 (使用 Vercel CLI)
如果您有安裝 Vercel CLI：
```bash
npx vercel dev
```
伺服器將在 `http://localhost:3000` 啟動，可直接發送請求至 `http://localhost:3000/api/study-advice`。

---

## 部署到 Vercel (免費個人方案)

### 步驟 A：取得 Google Gemini API Key
1. 前往 [Google AI Studio (https://aistudio.google.com/)](https://aistudio.google.com/)。
2. 點擊 **Get API key** → 點擊 **Create API key**。
3. 複製金鑰（開頭為 `AIzaSy...`）。

### 步驟 B：部署至 Vercel
#### 方式一：透過 Vercel 網頁後台 (推薦)
1. 將此 `backend` 資料夾推送至您的 GitHub 儲存庫。
2. 登入 [Vercel (https://vercel.com/)](https://vercel.com/)。
3. 點擊 **Add New Project**，匯入該 GitHub 儲存庫。
4. 在 **Root Directory** 設定中，選取 `backend` 資料夾。
5. 在 **Environment Variables** 新增兩項變數：
   * `GEMINI_API_KEY`：填入剛才取得的 Google API 金鑰。
   * `GEMINI_MODEL`：填入 `gemini-2.5-flash`。
6. 點擊 **Deploy**，等待約 30 秒即可取得公開網址（例如 `https://your-exam-backend.vercel.app`）。

#### 方式二：透過 Vercel 命令列工具
在 `backend` 目錄下執行：
```bash
npx vercel
```
依照終端機指示登入並部署即可。

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
  "source": "gemini_ai",
  "disclaimer": "AI 建議僅供學習策略與心理激勵參考；每日讀書日程與時間限制仍由排程引擎安全計算。"
}
```

---

## 如何在 iPhone App 中連接此後端

部署完成取得 Vercel 網址（例如 `https://your-exam-backend.vercel.app`）後：

1. 開啟 iPhone App 中的 **「設定」** 標籤頁。
2. 找到 **「AI 雲端服務 (Google Gemini)」** 區塊。
3. 點選 **「後端伺服器端點」**，貼上您的 Vercel 網址並儲存。
4. 返回「首頁」或「進度」標籤頁，點選 **「✦ Gemini 深度建議」**，即可立即享用即時 AI 讀書規劃與弱科突破建議！
5. 若不想手動輸入，也可以在專案根目錄 `.env` 或 EAS Build Secrets 中設定 `EXPO_PUBLIC_BACKEND_URL=https://your-exam-backend.vercel.app`。

