# p5 — 桌面寵物互動程式

> 自用 Windows 11 桌面寵物。Live2D / 靜態圖角色 + 個人化對話 + 行為驅動觸發 + 預生成台詞庫。
>
> 設計核心：**執行期不靠生成式 AI**。靠 Logger 累積行為、AI 離線批次預生成台詞、純 JSON runtime。

---

## 目前狀態

**M2 完成；M2.5 規劃完成、待實作**

- ✅ M0 環境準備（portable Node 22 LTS）
- ✅ M1 應用程式骨架（透明視窗、tray、設定、滑鼠穿透）
- ✅ M2 對話氣泡 UI（打字機、序列推進、自動關）
- ⏳ M2.5 氣泡多型態擴充（thought/persistent/choice）— 1.5-2 天
- ⏳ M3 監聽 + 觸發引擎 + Logger

---

## 文件導覽

| 文件 | 內容 | 何時看 |
|---|---|---|
| **[REQUIREMENTS.md](REQUIREMENTS.md)** v1.3 | 需求與決策（**為何**） | 評估範圍、決定是否啟用某功能 |
| **[SPECIFICATION.md](SPECIFICATION.md)** v1.1 | 技術契約（**怎麼做**） | 寫程式時的 source of truth |
| **[MILESTONES.md](MILESTONES.md)** v1.1 | 時程與交付（**何時**） | 排工作、驗收 |
| [BUBBLE_TYPES.md](BUBBLE_TYPES.md) v1.0 | 對話氣泡多型態分析 | M2.5 / M7 prompt 撰寫前 |
| [STAKEHOLDER_ANALYSIS.md](STAKEHOLDER_ANALYSIS.md) v1.0 | 三方視角分析 | 商業可行性回顧 |
| [PRIVACY_ANALYSIS.md](PRIVACY_ANALYSIS.md) v1.0 | 隱私威脅與緩解 | 隱私功能設計 / 商業化合規評估 |
| [CLAUDE.md](CLAUDE.md) | 工作流程規則 | — |

文件依賴：`REQUIREMENTS → SPECIFICATION → MILESTONES`，後者引用前者。

---

## 目錄結構（當前）

```
p5/
├── README.md                 ← 本檔
├── REQUIREMENTS.md           需求文件 v1.2
├── SPECIFICATION.md          規格書 v1.0
├── MILESTONES.md             里程碑計畫 v1.0
├── STAKEHOLDER_ANALYSIS.md
├── PRIVACY_ANALYSIS.md
├── CLAUDE.md
├── env.ps1, env.bat          啟用 portable Node 環境
├── tools/
│   └── node/                 portable Node 22.22.2（不入 git）
└── docs/
    └── 人物設定-*.{docx,png} 角色設定參考素材（M4 fallback 撰寫 / M5a 靜態圖可能用）
```

開發開始後（M1 之後）會新增的目錄：

```
├── package.json, main.js, preload.js
├── src/main/, src/renderer/
├── config/                   使用者設定（settings/triggers）
├── personas/                 人格內容包（dialogues/voices）
├── models/static/            靜態圖角色資產
├── models/live2d/            Live2D 角色資產（M5b）
├── data/                     執行期狀態（不入 git，敏感）
├── scripts/                  批次工具（CSV 匯入、語音生成、Stage 1 pipeline）
└── assets/                   tray icon 等
```

---

## 快速開始（開發環境）

```powershell
# 在專案根目錄啟用 portable Node 環境（每次 PowerShell session 一次）
. .\env.ps1

# 確認 Node 可用
node --version    # 應顯示 v22.22.2

# M1 之後：
# npm install
# npm start
# npm start -- --dev
```

`env.bat` 為 cmd / PowerShell 通用替代（用法相同：`env.bat`）。

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

### 內容
- ≥2 套人格（人格與外觀解耦）
- 文字打字機呈現
- 拖曳角色會說話、Live2D 眼神跟隨滑鼠
- 變數插值：`{time}/{hour}/{weekday}/{usage_hours}/{window_title}`

### 隱私
- 執行期完全離線
- Stage 1 上傳粒度：詳細事件時序（敏感格式遮罩）
- 預設 AI provider：本地 Ollama
- 按鍵內容絕不上傳

完整決策見 [REQUIREMENTS.md](REQUIREMENTS.md)。

---

## 待後續決定的事

| 項目 | 狀態 | 備註 |
|---|---|---|
| 兩套人格名字 | ✅ 已定 | `haiyin`（海音）+ `liss`（莉絲），素材在 docs/ |
| 兩套人格的人設文字內容 | ⏳ M4 前 | 從現有 docx 萃取，使用者交付 |
| 靜態圖素材來源（自繪 / AI / 委託） | ⏳ M5a 前 | docs/*.png 可作為起點，需補表情變體 |
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
