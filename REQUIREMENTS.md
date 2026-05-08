# 桌面寵物互動程式 — 設計需求 v1.3

> 確認日期：2026-05-08
> v1.0 → v1.1：新增「資料驅動內容生成」整體流程；觸發閾值改為從觀察校準；P0 階段插入；隱私上傳邊界明訂。
> v1.1 → v1.2：新增「角色渲染器抽象層」，**預設靜態圖模式**，Live2D 為進階選項。
> v1.2 → v1.3：新增「對話氣泡多型態」 — type / persistence / interaction 三維度擴充（thought / persistent / choice 等）；M2.5 階段插入。詳見 [BUBBLE_TYPES.md](BUBBLE_TYPES.md)。

---

## 1. 專案性質

- 自用 Windows 11 桌面寵物程式，常駐執行。
- Live2D 動畫角色 + 對話氣泡 + 預錄語音。
- **執行期不靠生成式 AI**：所有對話由預生成的 JSON 台詞庫 + 觸發規則驅動，避免延遲與 API 成本。
- **AI 僅用於離線批次預生成**：依使用者實際操作模式量身產出台詞，每月更新一次。
- 隱私：執行期不上傳任何資料；批次生成階段才會把彙整後的事件資料送到 AI 服務（邊界見 §14）。

---

## 2. 技術選型

| 模組 | 選型 | 備註 |
|---|---|---|
| 應用外殼 | Electron | |
| **角色渲染** | **靜態圖（預設）** + Live2D（進階） | 雙 renderer 抽象層；靜態圖無 GPU 依賴 |
| 動畫（Live2D） | pixi-live2d-display + PixiJS | 支援 Cubism 2/3/4 |
| 全域輸入監聽 | uiohook-napi | |
| 語音播放 | HTML5 Audio | |
| 語音生成（離線批次） | edge-tts 或 VOICEVOX | |
| **台詞生成（離線批次）** | **AI provider 待定**（候選：Claude API / OpenAI / 本地 LLM） | 抽象 provider 介面，使用者後續選 |
| 設定檔 | JSON | |
| 系統匣 | Electron Tray API | |
| Node | portable Node 22 LTS | 已置於 `tools/node/` |
| 觸發/台詞 schema | 借鏡 stevenjoezhang/live2d-widget 之 `waifu-tips.json` | 抄結構、不抄內容 |

---

## 3. 視窗形態

- **全螢幕透明覆蓋**：覆蓋整個主螢幕，無邊框、永遠置頂、不擋其他應用程式。
- 滑鼠預設**穿透整個透明視窗**，僅在角色 / 氣泡有效區才接收滑鼠事件。
- 系統匣常駐：顯示/隱藏、開啟設定、結束。
- **多螢幕**：記憶上次螢幕與座標，重啟還原。
- **全螢幕應用偵測**：前景視窗為獨佔全螢幕（遊戲 / 簡報）→ 自動隱藏角色並暫停觸發；計數器仍記錄；退出後恢復。
- 鎖屏時暫停觸發。

---

## 4. 資料驅動內容流程（v1.1 新增核心）

整體採三階段：

```
Stage 0 監測       Stage 1 預生成        Stage 2 執行
┌──────────┐      ┌──────────────┐     ┌────────────┐
│ 桌寵收集 │ 7天  │ 把 7 天事件   │     │ 純 JSON    │
│ 模式（仍 │ ───► │ 摘要 + 人格   │ ──► │ 驅動，零   │
│ 出 fall- │      │ 設定送 AI →   │     │ LLM、低延  │
│ back句） │      │ 批次產出 1500│     │ 遲、無成本 │
└──────────┘      │ + 句台詞     │     └────────────┘
                  │ + triggers   │            │
                  └──────────────┘            │
                          ▲                   │
                          │   每月觸發        │
                          └───────────────────┘
                            （或手動）
```

### 4.1 Stage 0 監測模式
- 桌寵啟動即進入監測，常駐記錄。
- 同時間使用內建 **fallback 台詞包**（手寫 100–200 句）讓使用者立刻有東西看。
- **預設收集 7 天**才產出第一次自訂台詞庫。期間 fallback 持續服務。

### 4.2 Stage 1 預生成（離線批次）
- `scripts/generate-dialogues.js` 讀取 `data/events/*.jsonl`。
- 計算統計摘要 + 取樣典型事件時序，組成 prompt。
- 呼叫 AI provider（介面抽象，provider 由設定指定）批次產出。
- 輸出寫入 `personas/<active>/dialogues.json` 並 `triggers.json` 閾值校準（如「點擊太多」的閾值取 **使用者每小時平均點擊數的 1.5 倍**）。
- **AI 校驗器**：每句生成後跑檢查（長度、禁用詞、變數插值合法性、人格一致性），不合格丟回重生。

### 4.3 Stage 2 執行
- 純 JSON 驅動，無 LLM 呼叫，無網路依賴。
- 與 v1.0 §6–§9 一致。

### 4.4 重新生成週期
- **每月自動重生**一次（檢查上次生成時間 ≥ 30 天就提醒，使用者點「重生」按鈕）。
- 也支援手動立即重生。
- 重生不刪舊台詞，移到 `personas/<active>/archive/<date>/`，可回滾。

---

## 5. 角色與內容

### 5.1 渲染器抽象（v1.2 新增）

桌寵的「外觀後端」是**可抽換的**，主流程透過統一介面操作角色，不綁死特定渲染技術：

```
[Dialog Engine] → setExpression('pout') → [CharacterRenderer (interface)]
                                                ├── StaticImageRenderer  (預設、低門檻)
                                                └── Live2DRenderer        (進階、高品質)
```

統一介面：`load()`、`setExpression(name)`、`setMotion(name)`、`setMouthOpen(value)`、`setFocusPoint(x,y)`、`destroy()`。

| 能力 | 靜態圖 | Live2D |
|---|---|---|
| 表情切換（基於台詞情緒） | ✅ 換圖 + 淡入淡出 | ✅ 流暢補間 |
| 待機動畫 | ✅ 多張 idle 隨機循環 + CSS 呼吸 | ✅ 內建 idle 動作 |
| 拖曳互動 | ✅ | ✅ |
| 嘴型同步 | ⚠️ 三幀替代圖（閉/半/全開） | ✅ 平滑連續 |
| 眼神跟隨滑鼠 | ❌ | ✅ |
| 動作（揮手等） | ⚠️ Sprite sheet 多幀模擬 | ✅ |
| 硬體門檻 | 無（DOM `<img>`） | WebGL + 中等 GPU |
| 素材取得難度 | 低（任何插畫/AI 出圖） | 高（需 rigging） |

**預設啟用 = 靜態圖**（相容性最高），Live2D 為使用者主動匯入後切換。

### 5.2 靜態圖規格

每個靜態人格資料夾含 `manifest.json` + 多張 PNG：

```jsonc
{
  "name": "貓貓 (靜態版)",
  "renderer": "static-image",
  "size": { "width": 300, "height": 500 },
  "anchor": { "x": 0.5, "y": 1.0 },         // 對話氣泡定位錨點
  "expressions": {
    "idle":        ["idle.png", "idle_2.png", "idle_3.png"],  // 陣列 = 隨機循環
    "happy":       "happy.png",
    "pout":        "pout.png",
    "annoyed":     "annoyed.png",
    "sleepy":      "sleepy.png",
    "surprised":   "surprised.png",
    "embarrassed": "embarrassed.png"
  },
  "default_expression": "idle",
  "idle_cycle_seconds": 8,                  // 每 N 秒隨機切一張 idle
  "breathing": { "enabled": true, "scale": 1.02, "duration_ms": 3000 },
  "transition": { "type": "crossfade", "duration_ms": 300 },
  "mouth_sync": {
    "enabled": false,
    "closed": "mouth_closed.png",
    "half":   "mouth_half.png",
    "open":   "mouth_open.png"
  }
}
```

**最小可用集**：1 張 idle + 4-6 張表情圖。
**完整集**：3 張 idle 循環 + 7 張表情 + 3 張嘴型 ≈ 13 張。

### 5.3 角色與人格的解耦

人格（dialogues、人設、語音）與外觀（Live2D / 靜態圖）**獨立**：

- 設定中可任意組合：「毒舌人格 + 靜態圖」、「溫柔人格 + Live2D 模型 A」
- 同一人格可有 Live2D 版 + 靜態版兩套外觀，並列在 `models/live2d/` 與 `models/static/`

### 5.4 通用條目

- **角色（外觀資產）**：免費為主，**可在程式內切換**（資料夾丟進 `models/<type>/` 自動偵測）。
- **角色人格**：可在程式內切換，至少 2 套，每套含獨立 `persona.json`（人設描述 → 餵給 Stage 1 的 prompt）+ `dialogues.json`（運行用 = AI 產出 + 手寫 fallback）。
- **語音**：可切換語言，初版 P1–P5 純文字氣泡，P6 才接語音生成。

### 5.5 起始人格（已確認 2026-05-08）

兩套起始人格選自使用者既有素材（`docs/人物設定-*.{docx,png}`）：

| 內部 slug | 顯示名 | 素材 | 內容交付時機 |
|---|---|---|---|
| `haiyin` | 海音 | docs/人物設定-海音.docx + 2 png | M4 開始前 |
| `liss` | 莉絲 | docs/人物設定-莉絲.docx + 1 png | M4 開始前 |

人設細節（個性、語氣、口頭禪、AI prompt 文字）由使用者在 M4 開始前提供，依此寫入 `personas/haiyin/persona.json` 與 `personas/liss/persona.json`。

第三套人格（艾蒂安）暫不啟用，素材保留以備後續擴充。

---

## 6. 互動量目標

- 每小時 5–10 次互動。
- **連續一週不重複**：因 Stage 1 一次產出 1500+ 句並維護「最近 50 句」歷史避免短期重複，足以達成。

---

## 7. 觸發系統

### 7.1 規則設定
- 規則寫於 `triggers.json`，啟動載入。
- 每條規則：條件、對應台詞分類、冷卻時間、**優先級數字**。
- **閾值由 Stage 1 自動校準**（根據使用者實際模式），使用者仍可手動覆寫。

### 7.2 觸發條件來源
- 累計滑鼠點擊次數
- 累計鍵盤敲擊次數
- 閒置時間
- 連續使用時間
- 特定時段（早晨、深夜）
- 季節 / 節日（沿用 waifu-tips `seasons` schema）
- 點擊角色（拖曳）
- （未來擴充）特定應用程式啟動、視窗切換頻率

### 7.3 多條件同時成立
- **靜態優先級**：取 `priority` 最高的觸發，其餘忽略。

### 7.4 冷卻策略
- **動態冷卻**：依互動頻率自動調整。
  - 短期內互動量高 → 縮短冷卻、嘴多。
  - 短期內互動量低 → 拉長冷卻、閃人。
  - 參數寫在 `triggers.json` 的 `dynamic_cooldown` 區段。
- 各分類仍有自己的最低冷卻 `cooldown_sec` 作為下限。

### 7.5 觸發例外
- **打字偵測**：鍵盤連續輸入中**不觸發**，停手 5 秒以上才視為「有空可被打擾」。
- **全螢幕應用 / 鎖屏**：暫停觸發。
- **請勿打擾模式**：手動開關 + 可排程（如 09:00–18:00）。靜音期間仍計數但不出氣泡。

### 7.6 「最近說過」歷史
- 維護**最近 50 句** ID 的 ring buffer，已說過的不重抽。

---

## 8. 對話氣泡

### 8.1 基本行為（M2 已實作）
- 浮現於角色頭部上方，跟隨角色。
- 半透明背景，文字清晰，淡入淡出。
- **打字機逐字呈現**；點擊一次顯示完整句、再點切到下一句。
- 多句序列：點擊推進，最後一句顯示提示符號，再點淡出。
- 預設 12 秒無互動自動關閉。
- 有語音時：打字進度與語音同步；點擊新一句會打斷舊語音。

### 8.2 多型態氣泡（M2.5）

對話氣泡採三維設計，**任意組合都成立**。完整論述見 [BUBBLE_TYPES.md](BUBBLE_TYPES.md)。

| 維度 | 選項 |
|---|---|
| **type 來源** | speech（對話）/ thought（想法）/ narration（旁白）/ system（系統）/ whisper（低語） |
| **persistence 持續性** | transient（短暫，自動關）/ persistent（持續，需手動關）/ sticky（條件解除才關）/ pinned（釘選） |
| **interaction 互動** | display（純顯示）/ advance（點擊推進）/ choice（選項分支）/ timed_choice（時間敏感分支） |

M2.5 啟用範圍：
- type：speech / thought / narration / system（whisper 視時程）
- persistence：transient / persistent / pinned
- interaction：display / advance / choice

**M2.5 不做**（推到 M3 之後）：sticky（依賴觸發引擎條件追蹤）、timed_choice（高互動複雜度）。

### 8.3 設計原則

- **schema 一次設計到位、分階段實作**：所有欄位設定預設值，舊資料不需遷移。
- **AI（M7）需被教會何時用哪種**：不是全部都用 speech；prompt 工程要求 70% speech / 10-20% thought / 0-10% system。
- **破壞性互動需明顯確認路徑**：persistent 必有 ✕ 鈕或 ESC，避免使用者卡住。

---

## 9. 角色直接互動

- **拖曳角色時會說話**。
- **戳臉 / 摸頭：本期不啟用**（保留 hit-area 設計）。
- **眼神跟隨滑鼠**（pixi-live2d-display 內建 Focus），頭部不轉。

---

## 10. 台詞與變數插值

### 10.1 變數
台詞中可寫以下標記，執行期被替換：
- `{time}` / `{hour}` — 當前時間 / 時段
- `{weekday}` — 星期
- `{usage_hours}` — 連續使用時數
- `{window_title}` — 前景視窗標題

### 10.2 編輯流程
- **JSON 為運行格式**。
- **CSV ↔ JSON 轉換腳本** `scripts/csv-to-dialogues.js` 供大量手動編輯時用。
- AI 生成出來的就是 JSON，無需手動轉。

---

## 11. 操作監測（Logger）

> v1.1 新增章節，是 Stage 0 的具體實作。

### 11.1 收集內容
- 鍵盤事件：時間戳 + 是否為修飾鍵（不記按鍵內容）。
- 滑鼠事件：時間戳 + 類型（左/右/中、移動量摘要）。
- 前景視窗切換：時間戳 + 應用程式名 + 視窗標題（標題僅本地，預設遮罩可疑字串如 email、URL）。
- 閒置事件：起訖時間戳 + 時長。
- 全螢幕事件：起訖時間戳 + 應用程式名。

### 11.2 儲存格式
- 每天一份 JSONL：`data/events/2026-05-08.jsonl`。
- 30 天後自動歸檔壓縮，60 天後刪除（避免無限堆積）。

### 11.3 隱私邊界（呼應 §15）
- **不記錄按鍵內容**，只記時間戳與類型。
- 視窗標題在記錄時即過濾敏感模式（email、URL、信用卡格式）。
- 使用者可在設定看到「目前累積多少事件」「即將上傳給 AI 的摘要預覽」並可拒絕特定欄位。

---

## 12. 設定 UI

### 12.1 輕量設定視窗（內含項目）
- 人格切換
- 語音語言切換（P6 起有效）
- 不打擾開關 + 排程編輯
- 音量
- 切換 Live2D 模型
- **資料收集狀態**（已累積天數 / 事件數 / 距下次重生 N 天）
- **「立即重生台詞」按鈕**（手動觸發 Stage 1）
- Debug 面板入口

### 12.2 不放入 UI 的高階設定
- 觸發規則細節、台詞內容、變數對應 — 編輯 JSON。

### 12.3 設定備份
- 每次修改 `settings.json` 自動寫一份 `.bak`，**保留最近 5 個版本**。

---

## 13. Debug / 開發模式

### 13.1 `--dev` 命令列旗標 / 隱藏快捷鍵
- 開啟 DevTools。
- 手動觸發任一台詞分類。
- 查看計數器當前值。
- 「跳過冷卻」清空所有 cooldown。
- **「乾跑生成器」**：用當前累積資料模擬 Stage 1，但不實際呼叫 API（看 prompt 預覽）。

### 13.2 Debug 面板（從設定視窗進入）
- 今天觸發次數、各分類分佈。
- 計數器現狀。
- 最近 N 次觸發時序。
- **使用模式可視化**：時段熱力圖、應用使用佔比、平均閒置時長分佈（這也是會送給 AI 的資料形式預覽）。

---

## 14. 語音（P6 才實作）

- edge-tts / VOICEVOX 離線批次生成 mp3。
- 增量生成（已存在不重跑）。
- 嘴型同步：音量包絡 → Live2D `ParamMouthOpenY`。
- 觸發新對話打斷舊語音。
- 語音切換 = 切換 `voices/<lang>/` 子資料夾。

---

## 15. 隱私邊界（v1.1 加嚴）

| 階段 | 上傳 | 不上傳 |
|---|---|---|
| **執行期（Stage 2）** | 無任何上傳 | — |
| **預生成（Stage 1）** | 詳細事件時序（時間戳、事件類型、應用程式名、視窗標題*）+ 統計摘要 + 人格 prompt | 按鍵內容、剪貼簿、檔案內容 |
| **Logger（Stage 0）** | 完全本地 | — |

\* 視窗標題在 Logger 入庫時即過濾 email / URL / 信用卡格式等敏感模式。

**使用者控制**：
- 設定視窗有「即將上傳給 AI 的摘要預覽」，使用者可逐欄位允許/拒絕。
- AI provider 在 `settings.json` 指定；切換到本地 LLM 即實現完全離線。

---

## 16. 資料夾結構

```
p5/
├── tools/node/                 # portable Node（不入 git）
├── env.ps1, env.bat
├── package.json
├── main.js                     # Electron 主入口
├── preload.js
├── src/
│   ├── main/
│   │   ├── window-mgr.js           # 透明置頂視窗、滑鼠穿透
│   │   ├── tray.js
│   │   ├── config-store.js         # settings.json 讀寫 + .bak
│   │   ├── window-state.js
│   │   ├── input-monitor.js        # uiohook-napi 包裝
│   │   ├── event-logger.js         # Stage 0 事件 JSONL
│   │   ├── fullscreen-detect.js
│   │   ├── trigger-engine.js
│   │   ├── dialogue-director.js    # 抽詞 / recent buffer
│   │   ├── persona-loader.js
│   │   ├── variable-interpolator.js
│   │   └── ipc.js
│   └── renderer/
│       ├── index.html
│       ├── renderer.js
│       ├── character-stage.js
│       ├── character-renderer.js   # interface
│       ├── static-image-renderer.js
│       ├── live2d-renderer.js      # M5b 才加
│       ├── speech-bubble.js, speech-bubble.css
│       ├── settings-window.html, settings.js
│       ├── debug-panel.html, debug-panel.js
│       └── style.css
├── config/                     # 使用者設定（入 git，內容空殼）
│   ├── settings.json
│   ├── triggers.json
│   └── *.bak
├── personas/                   # 人格內容包
│   ├── gentle/
│   │   ├── persona.json        # 餵 AI 的人設 prompt
│   │   ├── dialogues.json      # 運行用（fallback + AI 產出合併）
│   │   ├── archive/<date>/     # 歷史台詞版本
│   │   └── voices/zh/, /ja/
│   └── snarky/...
├── models/                     # 角色外觀資產（按渲染器分類）
│   ├── static/                 # 靜態圖角色（預設、低門檻）
│   │   └── default-static/
│   │       ├── manifest.json
│   │       ├── idle.png, idle_2.png, idle_3.png
│   │       ├── happy.png, pout.png, annoyed.png, sleepy.png, ...
│   │       └── (optional) mouth_closed.png, mouth_half.png, mouth_open.png
│   └── live2d/                 # Live2D 模型（進階）
│       └── default-l2d/
│           └── ... (cubism 檔)
├── data/                       # 執行期狀態（不入 git，**敏感**）
│   ├── events/                 # Stage 0 事件 JSONL，每日一份
│   │   ├── 2026-05-08.jsonl
│   │   └── ...
│   ├── recent-dialogues.json   # 最近 50 句歷史
│   ├── stats.json              # 觸發統計
│   ├── window-state.json
│   └── last-generation.json    # 上次 Stage 1 跑的時間/結果
├── assets/
│   └── tray-icon.png
├── scripts/
│   ├── csv-to-dialogues.js
│   ├── generate-dialogues.js   # Stage 1 主腳本
│   ├── ai-providers/           # 抽象 provider
│   │   ├── claude.js
│   │   ├── openai.js
│   │   └── local-llm.js
│   └── generate-voices.js      # P6 用
├── REQUIREMENTS.md
├── CLAUDE.md
└── .gitignore
```

---

## 17. 非功能需求

- **效能**：閒置 CPU < 3%、記憶體 < 300 MB。
- **穩定性**：連續 24h 不崩潰、不漏記憶體。
- **可擴充性**：新增模型、人格、規則不需動程式碼。
- **隱私**：執行期完全離線；Stage 1 上傳粒度可控；本地 LLM 模式可實現全程離線。

---

## 18. 安全 / 相容性 提醒（將寫入 README）

- `uiohook-napi` 可能被部分防毒誤判，需手動白名單。
- Electron 透明視窗在 Win11 + 部分 GPU 驅動下可能有閃爍。

---

## 19. 開發階段

| 階段 | 範圍 | 驗收 |
|---|---|---|
| **P1** 應用程式骨架 | Electron 透明全螢幕視窗、系統匣、設定載入框架、視窗位置記憶、滑鼠穿透機制、--dev 旗標 | 程式跑起來；托盤可顯隱；位置記憶生效 |
| **P2** 對話氣泡 UI | 半透明氣泡、打字機、序列點擊推進、自動關閉、debug 觸發按鈕 | 透明視窗指定位置冒出可推進的氣泡 |
| **P2.5** 氣泡多型態擴充 | type（speech/thought/narration/system/whisper）+ persistence（persistent/pinned）+ interaction（display/choice）；schema 完整存在但 sticky/timed_choice 暫停用 | 同一 sequence 可選不同 type 視覺；choice 按鈕可分支；persistent 不自動關 |
| **P3** 事件監聽 + 觸發引擎 | uiohook-napi、滑鼠/鍵盤/閒置/連續使用/時段、靜態優先級、動態冷卻、全螢幕偵測、打字偵測、請勿打擾排程；同時開始寫 **Stage 0 event-logger** | 真實使用會自動冒氣泡；data/events 開始累積 |
| **P4** 台詞庫 + 人格切換 + Debug 面板 + Fallback 包 | 完整 dialogues.json schema、雙人格資料夾、變數插值、最近 50 句記憶、CSV 匯入腳本、Debug 面板、**手寫 fallback 100–200 句／人格** | 切人格立即不同；fallback 包能撐 7 天 |
| **P5a** 渲染器抽象 + 靜態圖 | CharacterRenderer 介面、StaticImageRenderer 實作、manifest schema、表情淡入淡出、多 idle 循環、CSS 呼吸動畫、嘴型 3 幀替代、設定中切換 renderer | 桌面有可拖曳靜態角色，台詞情緒會切換表情 |
| **P5b** Live2D 整合 | Live2DRenderer 實作 (pixi-live2d-display)、模型切換、拖曳、眼神跟隨、拖曳發話、動作/表情同步台詞 | 桌面有可拖曳的 Live2D 角色，與靜態版可即時互換 |
| **P6** 語音 | edge-tts/VOICEVOX 批次腳本、Audio 播放、嘴型同步、語言切換 | 對話有配音、嘴型對得上 |
| **P7** Stage 1 預生成管線 | `scripts/generate-dialogues.js`、provider 抽象介面、prompt 模板、AI 校驗器、archive 機制、月更新提醒 | 累積 7 天資料後跑一次能產出可用台詞庫 |

> 註：P3 同時把 Logger 跑起來是策略性的 — 一邊開發 P4–P7 一邊累積真實資料，等 P7 完成時資料已滿 7 天可立刻試跑 Stage 1。
> 註：P5a 完成即可單獨驗收完整使用體驗（角色 + 表情 + 對話 + 觸發），P5b 變成「升級體驗」而非「必經關卡」，降低 Live2D 整合卡關的風險。

---

## 20. 暫不做（已確認）

- 執行期 LLM 即時生成。
- 雲端同步、多裝置共用。
- 開機自啟動（後期視需求補）。
- 戳臉 / 摸頭直接互動（保留 hit-area 預留位）。
- 頭部跟隨滑鼠（眼神跟隨即可）。

---

## 21. 待後續決定

- AI provider 選擇（Claude API / OpenAI / 本地 LLM）— 走到 P7 前確認。
- ~~人格初始設定（兩套人格的具體名字）~~ — **已確認**：`haiyin` / `liss`（見 §5.5）；人設文字內容仍待 M4 前交付。
- **靜態圖素材來源**（自繪 / 委託 / AI 生圖）— 走到 P5a 前確認；既有 docs/*.png 是否可作為起點。
- Live2D 模型來源 — 走到 P5b 前確認（可延後，因為 P5a 已能跑完整體驗）。

---

## 22. 未來擴充規劃（非 v1.x 範圍）

以下功能**主線開發不做**，但架構上預留入口、文件留紀錄，等主骨架穩定後再評估是否啟用。

### 22.1 動作引擎（Action Engine）— 桌寵主動執行系統操作

**功能定位**：把桌寵從「觀察 + 講話」升級為「觀察 + 講話 + 主動協助」。

**動作分級規劃**：

| 難度 | 動作範例 | 技術 |
|---|---|---|
| 🟢 易 | 播放/暫停/上下首音樂、打開網頁、打開應用程式、系統音量、靜音、開請勿打擾、鎖屏 | 媒體鍵 / `shell.openExternal` / `loudness` npm |
| 🟡 中 | 螢幕亮度、切夜間模式、取得當前播放歌曲、休眠 | PowerShell / WMI / WinRT 綁定 |
| 🔴 難 / 不採用 | 控制其他 app 的內部介面 | UI Automation 脆弱、不接 |

**安全核心原則**：
- 動作清單寫在 `config/actions.json`，**白名單機制**。
- AI 生成台詞時只能引用動作 ID，不能定義新動作或填入動態 PowerShell。
- 破壞性 / 不可逆動作必須 `confirmation: true` 二次確認。
- 動作參數靜態定義或白名單枚舉，禁止字串拼接。

**對話氣泡升級**：對話最後一句可帶選項按鈕，使用者點擊執行對應動作。

**架構入口（已預留）**：
- 新增 `src/main/action-engine.js` 模組。
- `config/actions.json` 設定檔。
- 對話 schema 擴充 `options[]` 欄位（含 label + action_id）。
- IPC：renderer 點選 → main 行程查 whitelist → 執行 → 回報結果。

**估時**：3-5 工日（若選 P8 完整實作）。

**啟用條件**：主架構（P1-P7）完成且穩定使用 ≥ 1 個月後再評估。

### 22.2 其他可能的未來擴充

- **時段自動化**：習慣性時段自動執行動作（早上 9:00 自動開 Slack）— 在動作引擎之上。
- **情境自動化**：偵測特定 app 啟動 → 觸發動作鏈（LoL.exe → 自動靜音 + 請勿打擾）。
- **戳臉 / 摸頭互動**：Live2D hit-area 觸發台詞。
- **頭部跟隨滑鼠**：超出眼神跟隨的更高互動。
- **開機自動啟動**：`app.setLoginItemSettings`。
- **多人格並存**：同時顯示兩個角色互動（架構大改）。
- **跨裝置同步**：雲端同步台詞庫與設定（破壞純本地原則，需重新設計隱私）。
