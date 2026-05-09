# 專案文件目錄

> p5 桌面寵物互動程式（Electron + Live2D + uiohook）
> 文件索引：「我想找 X」對應哪個檔案。

---

## 🚀 快速查閱表

| 我想... | 看這個 |
|---|---|
| 了解專案核心需求與決策 | [設計需求.md](設計需求.md) |
| 看模組契約 / 介面 / IPC schema | [技術規格.md](技術規格.md) |
| 看開發路徑 / 里程碑 / 工日 | [里程碑計畫.md](里程碑計畫.md) |
| 跑 M3 驗收測試 | [M3-驗收測試手冊.md](M3-驗收測試手冊.md) |
| 看 events JSONL 欄位定義 | [events-schema.md](events-schema.md) |
| 看 analyze-rollup 工具的設計討論 | [analyze-rollup-設計.md](analyze-rollup-設計.md) |
| 看隱私風險 / 緩解策略 | [隱私分析.md](隱私分析.md) |
| 看氣泡 UI 多型態（type/persistence/interaction） | [對話氣泡類型.md](對話氣泡類型.md) |
| 看 UI / 角色視覺參考 | [設計參考.md](設計參考.md) |
| 看三方角度的設計分析 | [三方視角分析.md](三方視角分析.md) |
| 看本地 Gemma4 模型 API 整合 | [gemma4_api_guide.md](gemma4_api_guide.md) |
| 用 LLM 生 fallback 台詞草稿（M4） | [M4-fallback-prompt-模板.md](M4-fallback-prompt-模板.md) |
| Claude Code 工作流程規則 | [../CLAUDE.md](../CLAUDE.md) |
| 專案 README | [../README.md](../README.md) |

---

## 📂 文件分類

### 1. 規格與設計（架構主軸）

| 文件 | 版本 | 用途 |
|---|---|---|
| [設計需求.md](設計需求.md) | v1.3 | **「為什麼這樣做」** — 需求、決策、人格設定、隱私分級、規則 DSL 設計 |
| [技術規格.md](技術規格.md) | v1.1 | **「具體怎麼做」** — 模組契約、IPC channel、JSONL schema、redact 規則 |
| [里程碑計畫.md](里程碑計畫.md) | v1.1 | **「什麼時候做」** — M0~M∞ 階段安排、工日、依賴關係、驗收測試 |

> 這三份是專案核心。改架構決策時這三份都要更新。

### 2. 設計輔助分析（深度討論）

| 文件 | 用途 |
|---|---|
| [三方視角分析.md](三方視角分析.md) | 從不同角度（產品/工程/隱私）對設計的分析與權衡 |
| [隱私分析.md](隱私分析.md) | **隱私威脅模型** — 收集敏感度、洩漏風險、redact / 黑名單 / 加密規劃 |
| [對話氣泡類型.md](對話氣泡類型.md) | M2.5 氣泡三維設計（type / persistence / interaction） |
| [設計參考.md](設計參考.md) | 視覺參考、UI 風格、競品研究 |

### 3. 操作手冊與速查（用工具時看）

| 文件 | 用途 |
|---|---|
| [events-schema.md](events-schema.md) | **events JSONL 各欄位定義速查** — 每個 event type 的欄位、單位、emit 條件、隱私邊界 |
| [M3-驗收測試手冊.md](M3-驗收測試手冊.md) | **M3 功能驗證 step-by-step** — 28 項測試 + 各種邊界 case + cooldown 設計說明 |

### 4. 工具設計討論（實作前的討論記錄）

| 文件 | 用途 |
|---|---|
| [analyze-rollup-設計.md](analyze-rollup-設計.md) | **`analyze-rollup.js` 工具設計** — 5 個 mode、profile mode 板型策略、跟 M7 整合 |
| [M4-fallback-prompt-模板.md](M4-fallback-prompt-模板.md) | **M4 LLM prompt 模板** — 兩人格 × 五分類共 10 份完整 prompt + 篩選整理規範 + 風格自檢清單 |

> 此分類存「**實作前討論成果**」。每個工具實作前先寫設計討論，避免直接寫 code 卻發現方向錯。

### 5. 第三方資源（外部 API 參考）

| 文件 | 用途 |
|---|---|
| [gemma4_api_guide.md](gemma4_api_guide.md) | 本地 Gemma4 模型 API 參考（M7 LLM 整合用） |

### 6. 專案根目錄（不在此資料夾）

| 文件 | 用途 |
|---|---|
| [../CLAUDE.md](../CLAUDE.md) | Claude Code 工作流程規則 — git config、上傳規範、`./data/events` 讀取限制 |
| [../README.md](../README.md) | 專案 README — 安裝、執行、整體介紹 |

---

## 🔍 各文件 1-2 句摘要

### 設計需求.md
專案的「**為什麼**」。從動機（自己用的 desktop 桌寵）→ 雙人格設計 → 規則 DSL 結構 → 隱私分級 → 觸發例外（DND/全螢幕/打字中）。改任何核心決策前先讀這份。

### 技術規格.md
專案的「**怎麼做**」。每個模組的對外介面、所有 IPC channel 定義、JSONL schema、redact regex 規則、TriggerEngine 評估流程、ContextStateTracker 推導規則。寫程式時對照這份。

### 里程碑計畫.md
專案的「**什麼時候做**」。M0~M7 各階段工日、依賴關係、交付物、驗收測試。M3 + M3 增補（rollup）已完成。當前狀態：M4 待開始。

### 三方視角分析.md
從產品 / 工程 / 隱私三個角度對整體設計的權衡分析。架構決策有疑慮時參考。

### 隱私分析.md
威脅模型 + 緩解清單。**自用情境**已採取的（redact、黑名單、輪替）+ **商業化前要補的**（加密、keychain、jitter）。M3 完成階段對應到「自用級」隱私防護。

### 對話氣泡類型.md
M2.5 階段定的三維設計：
- `type`: speech / thought / narration / system / whisper
- `persistence`: transient / persistent / pinned
- `interaction`: display / advance / choice / binary_split

### 設計參考.md
UI / 角色 / 對話氣泡視覺設計參考。M5a 階段找素材時看。

### events-schema.md
**最常用的速查文件**。dump-events.js 看不懂某欄位 → 翻這份。每個 event type 的：
- 來源（哪個 plugin emit）
- 觸發條件
- 欄位定義 + 單位
- 隱私處理

### M3-驗收測試手冊.md
M3 功能驗收清單。28 項測試分 5 大類：
1. 啟動 / Debug 面板
2. Tier 1 鍵滑聚合
3. Tier 2 環境感知
4. Tier 3 進階感知
5. ContextStateTracker / TriggerEngine / 進階情境壓制

每項有「最簡驗證」+「嚴謹驗證」兩條路。

### analyze-rollup-設計.md
未實作工具的設計討論。5 個 mode（summary / hourly / weekday / session / profile），重點在 profile mode 用 **rule-based 板型 + 異常偵測** 而非 LLM。**累積 1 週資料後再實作**。

### gemma4_api_guide.md
本地 Gemma4 LLM API 整合指引。M7 階段選 provider 時參考。

### M4-fallback-prompt-模板.md
M4 階段把 dialogues.json 從 15 句擴至 200-300 句的工具文件。10 份 LLM prompt（兩人格 × 五觸發分類），含：
- §0 用法（每份預期 30-50 句，跑 3 輪 ≈ 350 句/人格）
- §1 通用規則（變數白名單 / type 比例 / 風格要求）
- §2-3 prompt 本體（複製即用）
- §4 篩選與 CSV 整理格式（給未來 csv-to-dialogues.js 用）
- §5 風格自檢清單（海音「中度病嬌」/ 莉絲「最愛的主人♡」配比）

搭配 `scripts/llm-fallback-builder.js` 動態生成相同 prompt（從 persona.json 即時組合）。

---

## 📋 文件編寫慣例

### 命名
- 中文檔名（既有風格）
- 工具類用 hyphen 連接（events-schema.md）
- 階段相關用 dash 連 prefix（M3-驗收測試手冊.md）

### 結構
- 開頭一段「用途」說明此文件目的
- 使用 emoji header 提升掃描度（⭐ ⚠️ 🎯 📋 ✅ ❌）
- 用表格濃縮對照資訊
- 程式片段用 ` ``` ` 標 language

### 跨文件引用
- 相對路徑：[里程碑計畫](里程碑計畫.md)
- 標題錨點：[§ in_meeting](#in_meeting)
- 程式碼路徑：[src/main/x.js](../src/main/x.js)

### 變更管理
- 文件結尾附「變更管理」表格（版本 + 日期 + 主要變更）
- 大幅調整升 minor 版號

### 不要做的
- 不要在文件裡放使用者個人資料（events 範例用 dummy data）
- 不要把 raw `data/events/` 內容貼進文件（CLAUDE.md 規則）
- 不要重複「程式碼自身能說明」的內容（讓程式 + comment 說話）

---

## 📅 文件版本快照（2026-05-09）

| 文件 | 版本 | 最後更新 | 狀態 |
|---|---|---|---|
| 設計需求.md | v1.3 | 2026-05-08 | 穩定 |
| 技術規格.md | v1.1 | 2026-05-08 | 穩定 |
| 里程碑計畫.md | v1.1 | 2026-05-08 | M3 完成更新中 |
| 隱私分析.md | v1.0 | 2026-05-08 | 穩定 |
| 對話氣泡類型.md | v1.0 | 2026-05-08 | 穩定 |
| 三方視角分析.md | v1.0 | 2026-05-08 | 穩定 |
| 設計參考.md | v1.0 | 2026-05-08 | 穩定 |
| events-schema.md | v1.0 | 2026-05-09 | 穩定 |
| M3-驗收測試手冊.md | v1.0 | 2026-05-09 | M3 完成同期 |
| analyze-rollup-設計.md | v1.0 | 2026-05-09 | 設計討論，未實作 |
| gemma4_api_guide.md | — | 2026-05-08 | 第三方資源 |
| M4-fallback-prompt-模板.md | v1.0 | 2026-05-09 | M4 Phase 4.1 |

---

## 🔄 維護建議

### 新增文件時
1. 寫文件本身
2. **更新此 README**（快速查閱表 + 分類 + 摘要 + 版本快照）
3. 跨文件引用（從相關文件加 link）

### 大幅修改時
1. 升版號
2. 更新「變更管理」表格
3. 此 README 的版本快照同步更新

### 廢棄文件
- 標記為 `[deprecated]`
- 移到 `文件/_archive/` 子資料夾
- 此 README 移除引用，註明廢棄日期

---

## 變更管理

| 版本 | 日期 | 主要變更 |
|---|---|---|
| v1.0 | 2026-05-09 | 文件目錄初版（M3 完成階段） |
