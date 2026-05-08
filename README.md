# p5 — 桌面寵物互動程式

> 自用 Windows 11 桌面寵物。Live2D / 靜態圖角色 + 個人化對話 + 行為驅動觸發 + 預生成台詞庫。
>
> 設計核心：**執行期不靠生成式 AI**。靠 Logger 累積行為、AI 離線批次預生成台詞、純 JSON runtime。

---

## 目前狀態

**M2.5 完成；M3 待動工**

- ✅ M0 環境準備（portable Node 22 LTS）
- ✅ M1 應用程式骨架（透明視窗、tray、設定、滑鼠穿透）
- ✅ M2 對話氣泡 UI（打字機、序列推進、自動關）
- ✅ M2.5 氣泡多型態（5 種視覺類型 + 4 種持續性 + 4 種互動，含 B1 二元分區）
- ⏳ M3 監聽 + 觸發引擎 + Logger

---

## 文件導覽

所有專案文件集中於 [`文件/`](文件/) 資料夾：

| 文件 | 內容 | 何時看 |
|---|---|---|
| **[設計需求](文件/設計需求.md)** v1.3 | 需求與決策（**為何**） | 評估範圍、決定是否啟用某功能 |
| **[技術規格](文件/技術規格.md)** v1.1 | 技術契約（**怎麼做**） | 寫程式時的 source of truth |
| **[里程碑計畫](文件/里程碑計畫.md)** v1.1 | 時程與交付（**何時**） | 排工作、驗收 |
| [對話氣泡類型](文件/對話氣泡類型.md) v1.0 | 對話氣泡多型態分析 | M2.5 / M7 prompt 撰寫前 |
| [設計參考](文件/設計參考.md) v1.0 | 業界對話 UI 設計參考與未來考慮點 | 體感發現痛點時 / M7 prompt 工程 |
| [三方視角分析](文件/三方視角分析.md) v1.0 | 開發者 / 使用者 / 投資者三方視角 | 商業可行性回顧 |
| [隱私分析](文件/隱私分析.md) v1.0 | 隱私威脅與緩解 | 隱私功能設計 / 商業化合規評估 |
| [CLAUDE.md](CLAUDE.md) | 工作流程規則 | — |

文件依賴：`設計需求 → 技術規格 → 里程碑計畫`，後者引用前者。

---

## 目錄結構（當前）

```
p5/
├── README.md                     ← 本檔（導覽入口）
├── CLAUDE.md                     工作流程規則
├── .gitignore
├── 文件/                          ← 專案文件（中文化）
│   ├── 設計需求.md                v1.3
│   ├── 技術規格.md                v1.1
│   ├── 里程碑計畫.md              v1.1
│   ├── 對話氣泡類型.md            v1.0
│   ├── 設計參考.md                v1.0
│   ├── 三方視角分析.md            v1.0
│   └── 隱私分析.md                v1.0
├── 角色素材/                      ← 人物設定參考（docx + png）
│   ├── 人物設定-海音.{docx,png}   起始人格 1
│   ├── 人物設定-艾蒂安.{docx,png} 保留備用
│   └── 人物設定-莉絲.{docx,png}   起始人格 2
├── package.json, package-lock.json
├── main.js, preload.js
├── src/
│   ├── main/                     主行程模組
│   └── renderer/                 渲染行程
├── config/                       使用者設定（settings.json）
├── assets/                       tray icon 等
├── data/                         執行期狀態（不入 git，敏感）
└── node_modules/                 依賴（不入 git）
```

開發開始後（M4 之後）會新增的目錄：

```
├── personas/                     人格內容包（dialogues / voices）
├── models/static/                靜態圖角色資產
├── models/live2d/                Live2D 角色資產（M5b）
└── scripts/                      批次工具（CSV、語音、Stage 1 pipeline）
```

---

## 快速開始（開發環境）

需要：Node ≥ 18（已在 v24.15.0 / v22.22.2 驗證可用），系統 PATH 中。

```powershell
# 安裝依賴（首次）
npm install

# 啟動
npm start
npm run start:dev    # dev 模式（自動開 DevTools）
```

---

## 已確認的核心決策

### 架構
- **三階段資料驅動**：Stage 0 監測 → Stage 1 離線 AI 批次預生成 → Stage 2 純 JSON 執行
- **雙渲染後端**：靜態圖（預設、低門檻）+ Live2D（進階）
- 重生週期：每月一次（手動或自動提醒）

### 執行期
- 全螢幕透明覆蓋視窗，滑鼠穿透
- 靜態優先級觸發 + 動態冷卻
- 打字中 / 全螢幕應用 / 鎖屏暫停觸發
- 最近 50 句不重複
- 可排程「請勿打擾」

### 對話氣泡（M2.5）
- 5 種視覺類型：speech / thought / narration / system / whisper
- 4 種持續性：transient（自動關）/ persistent（循環、僅 ✕ 關）/ pinned（靜態、僅 ✕ 關）/ sticky（M3 後）
- 4 種互動：display / advance / choice（多按鈕）/ binary_split（左綠右紅二元）

### 內容
- ≥2 套人格（人格與外觀解耦），起始為 `haiyin`（海音）+ `liss`（莉絲）
- 文字打字機呈現
- 拖曳角色會說話、Live2D 眼神跟隨滑鼠
- 變數插值：`{time}/{hour}/{weekday}/{usage_hours}/{window_title}`

### 隱私
- 執行期完全離線
- Stage 1 上傳粒度：詳細事件時序（敏感格式遮罩）
- 預設 AI provider：本地 Ollama
- 按鍵內容絕不上傳

完整決策見 [設計需求](文件/設計需求.md)。

---

## 待後續決定的事

| 項目 | 狀態 | 備註 |
|---|---|---|
| 兩套人格名字 | ✅ 已定 | `haiyin`（海音）+ `liss`（莉絲），素材在 角色素材/ |
| 兩套人格的人設文字內容 | ⏳ M4 前 | 從現有 docx 萃取，使用者交付 |
| 靜態圖素材來源（自繪 / AI / 委託） | ⏳ M5a 前 | 角色素材/*.png 可作為起點，需補表情變體 |
| Live2D 模型來源 | ⏳ M5b 前 | 可延後（M5a 已能跑完整體驗） |
| 語音生成工具（edge-tts / VOICEVOX） | ⏳ M6 前 | |
| AI provider（Ollama / Claude / OpenAI） | ⏳ M7 前 | 預設 Ollama 本地 |

---

## Git 上傳規則

依 [CLAUDE.md](CLAUDE.md)：
- **不主動上傳**，需使用者明確指示
- 目標 repo：`https://github.com/HALOFLAG/p5.git`
- 排除敏感內容：`tools/node/`、`data/`、`*.bak`、`.env`、API 金鑰

`.gitignore` 已涵蓋上述項目。
