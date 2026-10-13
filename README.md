# 考試計畫 AI

幫助考生安排每日讀書進度的 iPhone App（Expo + React Native + TypeScript）。

## 目前進度

| 階段 | 內容 | 狀態 |
| --- | --- | --- |
| 第一階段 | 環境、專案、五個畫面的基本 UI、底部導覽、示範資料 | ✅ 完成 |
| 第二階段 | 完整建立考試流程、修改考試、資料模型整理 | 待進行 |
| 第三階段 | 排程引擎（含測試）、產生每日任務 | 待進行 |
| 第四階段 | SQLite 本機儲存、重新排程預覽與套用 | 待進行 |
| 第五階段 | 核心流程測試與修正 | 待進行 |

## 專案結構

```
src/
├── app/                 # 畫面（Expo Router：每個檔案就是一個畫面）
│   ├── _layout.tsx      # 根導覽（Stack）
│   ├── (tabs)/          # 底部四個分頁
│   │   ├── _layout.tsx  # 底部導覽列
│   │   ├── index.tsx    # 首頁
│   │   ├── plan.tsx     # 讀書計畫
│   │   ├── progress.tsx # 進度
│   │   └── settings.tsx # 設定
│   ├── exam/new.tsx     # 建立考試（三個步驟）
│   ├── task/[id].tsx    # 任務詳情
│   ├── reschedule.tsx   # 重新安排計畫
│   ├── exams.tsx        # 考試與計畫管理
│   └── privacy.tsx      # 隱私權政策
├── components/          # 共用介面元件（按鈕、列表、進度條…）
├── constants/           # 介面文字對照
├── data/                # 示範資料
├── hooks/               # 自訂 hooks
├── store/               # App 狀態與資料計算（selectors）
├── theme/               # 顏色、字級、間距
├── types/               # 資料模型
├── utils/               # 日期等工具函式
└── validation/          # 表單驗證規則
```

之後的階段會加入：
- `src/scheduler/`：排程引擎（純函式＋測試，不放在畫面裡）
- `src/storage/`：SQLite 本機儲存
- `src/services/ai/`：未來 AI 服務的介面（API 金鑰不放在 App 內）

## 開發指令

```bash
npm start            # 啟動開發伺服器
npm run ios          # 啟動並在 iPhone 模擬器開啟
npm run typecheck    # TypeScript 型別檢查
npm run lint         # 程式碼風格檢查
npx expo-doctor      # 檢查套件版本與設定
npx expo install xxx # 安裝套件（請用這個，不要用 npm install xxx）
```
