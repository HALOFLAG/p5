# 規格書 — 桌面寵物互動程式

> 版本：v1.1（對應 REQUIREMENTS.md v1.3）
> 確認日期：2026-05-08
> 涵蓋階段：P1–P7（自用主線）+ M2.5（氣泡多型態）
>
> v1.0 → v1.1：dialogues.json schema 擴充（type / persistence / interaction）；新增 IPC `dialogue:choice-selected`。詳見 [BUBBLE_TYPES.md](BUBBLE_TYPES.md)。

REQUIREMENTS.md 描述「**做什麼、為什麼**」。本規格書描述「**怎麼做**」 — 模組責任、資料模型、介面契約、事件流程、錯誤處理。

---

## 0. 文件目的

| 文件 | 焦點 | 何時看 |
|---|---|---|
| REQUIREMENTS.md | 需求與決策 | 評估範圍、決定是否啟用某功能 |
| **SPECIFICATION.md** | **技術契約** | **寫程式時當作 source of truth** |
| MILESTONES.md | 時程與交付 | 排工作、驗收 |
| STAKEHOLDER_ANALYSIS.md | 商業/體驗評估 | 決策前回顧 |
| PRIVACY_ANALYSIS.md | 隱私威脅與緩解 | 設計隱私功能、商業化合規評估 |

---

## 1. 系統架構

### 1.1 進程拓撲

```
┌──────────────────────────────────────────────────────────────┐
│                  Electron 主行程 (main process)              │
│                                                              │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────────┐    │
│  │ Tray     │  │ WindowMgr    │  │ ConfigStore        │    │
│  └──────────┘  └──────────────┘  └────────────────────┘    │
│  ┌──────────────────────┐  ┌──────────────────────────┐    │
│  │ InputMonitor         │  │ EventLogger              │    │
│  │ (uiohook-napi)       │  │ (JSONL append)           │    │
│  └────────┬─────────────┘  └────────────┬─────────────┘    │
│           │                              │                   │
│           ▼                              ▼                   │
│  ┌──────────────────────────────────────────────────┐      │
│  │ TriggerEngine                                    │      │
│  │ - rule evaluator  - cooldown mgr  - DND scheduler│      │
│  │ - typing detect   - fullscreen detect            │      │
│  └────────────────────┬─────────────────────────────┘      │
│                       │  fire(category, context)           │
│                       ▼                                     │
│  ┌──────────────────────────────────────────────────┐      │
│  │ DialogueDirector                                 │      │
│  │ - persona load  - line picker  - recent buffer   │      │
│  └────────────────────┬─────────────────────────────┘      │
│                       │  IPC: dialogue:show                 │
└───────────────────────┼─────────────────────────────────────┘
                        │
┌───────────────────────┼─────────────────────────────────────┐
│            Renderer 行程 (renderer process)                  │
│                       ▼                                     │
│  ┌──────────────────────────────────────────────────┐      │
│  │ CharacterStage                                   │      │
│  │ - CharacterRenderer interface                    │      │
│  │   ├ StaticImageRenderer                          │      │
│  │   └ Live2DRenderer  (P5b)                        │      │
│  └────────────────────┬─────────────────────────────┘      │
│                       │  setExpression / focus / mouth     │
│  ┌────────────────────▼─────────────────────────────┐      │
│  │ SpeechBubble        (打字機 / 序列推進)          │      │
│  └──────────────────────────────────────────────────┘      │
│  ┌──────────────────────────────────────────────────┐      │
│  │ SettingsWindow / DebugPanel  (獨立 BrowserWindow)│      │
│  └──────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────┘
```

### 1.2 進程間通訊（IPC）

所有 IPC 走 `ipcMain` ↔ `ipcRenderer`，preload 暴露 `window.api.*`：

| 方向 | Channel | Payload | 用途 |
|---|---|---|---|
| main → renderer | `dialogue:show` | `{ sequenceId, lines[], expression, motion, options? }` | 顯示對話 |
| main → renderer | `dialogue:dismiss` | — | 關閉氣泡 |
| renderer → main | `dialogue:advance` | `{ sequenceId, lineIndex }` | 推進到下一句 |
| renderer → main | `dialogue:choice-selected` | `{ sequenceId, choiceIndex, next }` | M2.5 — 選項分支選擇 |
| renderer → main | `dialogue:dismiss-ack` | `{ sequenceId, reason, completed }` | 氣泡關閉回報 |
| renderer → main | `dialogue:option-selected` | `{ sequenceId, optionIndex }` | 動作引擎用（未來） |
| main → renderer | `character:expression` | `{ name }` | 切換表情 |
| main → renderer | `character:motion` | `{ name }` | 觸發動作（Live2D） |
| main → renderer | `character:focus` | `{ x, y }` | 眼神跟隨（Live2D） |
| main → renderer | `character:mouth` | `{ value }` (0..1) | 嘴型同步 |
| renderer → main | `mouse:enter-character` | — | 滑鼠進入角色，main 取消穿透 |
| renderer → main | `mouse:leave-character` | — | main 恢復穿透 |
| renderer → main | `character:drag-start/move/end` | `{ x, y }` | 拖曳事件 |
| both | `settings:get/set/subscribe` | — | 設定讀寫 |
| main → renderer | `debug:counters` | `{ clicks, keys, idle, ... }` | Debug 面板 |
| renderer → main | `debug:fire` | `{ category }` | 手動觸發 |

### 1.3 模組責任矩陣

| 模組 | 進程 | 責任 | 不負責 | 依賴 |
|---|---|---|---|---|
| WindowMgr | main | 建立透明置頂視窗、滑鼠穿透切換、視窗位置儲存 | 內容渲染 | electron |
| Tray | main | 系統匣選單、狀態圖示 | 設定內容 | electron |
| ConfigStore | main | 載入/儲存 settings/triggers，自動 .bak | 內容驗證 | fs/path |
| InputMonitor | main | 全域鍵滑事件抽象、計數器、閒置偵測 | 觸發決策 | uiohook-napi |
| EventLogger | main | 寫 JSONL、敏感過濾、輪替清理 | 上傳 | fs |
| FullscreenDetect | main | 偵測前景視窗是否獨佔全螢幕 | 觸發決策 | win32 binding |
| TriggerEngine | main | 規則比對、優先級、動態冷卻、DND、打字偵測 | 對話內容 | InputMonitor / FullscreenDetect |
| DialogueDirector | main | 抽詞、最近 50 句記憶、變數插值 | 顯示細節 | ConfigStore |
| CharacterStage | renderer | renderer 抽象、模型載入、表情切換 | 對話內容 | pixi（Live2D 時） |
| SpeechBubble | renderer | 氣泡 UI、打字機、序列推進、淡入淡出 | 觸發 | DOM |
| SettingsWindow | renderer | 設定 UI（獨立視窗） | 設定儲存 | IPC |
| DebugPanel | renderer | 計數器、觸發紀錄、模式可視化 | — | IPC |

### 1.4 資料夾結構（最終目錄）

見 REQUIREMENTS.md §16。

---

## 2. 資料模型（完整 Schema）

### 2.1 `config/settings.json`

```jsonc
{
  "$schema": "v1",
  "active_persona": "snarky",
  "active_renderer": "static-image",   // "static-image" | "live2d"
  "active_model": "default-static",    // 對應 models/<renderer>/<id>
  "voice": {
    "enabled": false,
    "language": "zh"
  },
  "volume": 0.6,
  "do_not_disturb": {
    "manual": false,
    "schedule_enabled": false,
    "schedule": [
      { "weekdays": [1,2,3,4,5], "from": "09:00", "to": "18:00" }
    ]
  },
  "ai_provider": "local-ollama",       // 走到 P7 前才生效
  "log_level": "info",                 // off | error | warn | info | debug
  "first_run_completed": false
}
```

`api_keys` 不存於此檔；改用 OS keychain（Windows Credential Manager）— 隱私加固項。

### 2.2 `config/triggers.json`

```jsonc
[
  {
    "name": "click_too_much",
    "category": "click_too_much",
    "priority": 10,
    "cooldown_sec": 600,
    "condition": {
      "type": "counter_threshold",
      "counter": "clicks_since_last_trigger",
      "operator": ">=",
      "value": 500          // Stage 1 校準後可被覆寫
    }
  },
  {
    "name": "long_idle",
    "category": "long_idle",
    "priority": 20,
    "cooldown_sec": 1800,
    "condition": {
      "type": "idle_duration",
      "operator": ">=",
      "value_sec": 1800
    }
  },
  {
    "name": "deep_night",
    "category": "deep_night",
    "priority": 50,
    "cooldown_sec": 3600,
    "condition": {
      "type": "time_window",
      "from": "23:00",
      "to": "05:00"
    }
  },
  {
    "name": "continuous_use",
    "category": "continuous_use",
    "priority": 30,
    "cooldown_sec": 1200,
    "condition": {
      "type": "session_duration",
      "operator": ">=",
      "value_sec": 14400
    }
  },
  {
    "name": "drag_character",
    "category": "drag",
    "priority": 100,
    "cooldown_sec": 5,
    "condition": { "type": "event", "event": "character:drag-start" }
  }
],
"dynamic_cooldown": {
  "enabled": true,
  "window_min": 60,
  "high_activity_threshold": 8,        // 一小時 8+ 次互動視為高
  "high_activity_multiplier": 0.7,     // 冷卻乘 0.7（更頻繁）
  "low_activity_multiplier": 1.5       // 冷卻乘 1.5（拉長）
}
```

### 2.3 `personas/<id>/dialogues.json`

```jsonc
{
  "$schema": "v2",                      // v2 起含 type/persistence/interaction
  "persona_id": "haiyin",
  "fallback_pack": true,
  "generated_at": "2026-05-08T12:00:00Z",
  "categories": {
    "click_too_much": {
      "sequences": [
        {
          "id": "ctm_001",
          // ── M2.5 新增的三維度（皆有預設值）─────────────
          "type": "speech",             // speech | thought | narration | system | whisper
          "persistence": "transient",   // transient | persistent | sticky | pinned
          // ── persistence 行為差異（M2.5 已實作）─────
          //   transient : 12 秒自動關 / 點完所有句即關
          //   persistent: 只能 ✕/ESC 關；多句會循環（最後一句點本體 → 回第一句）
          //   pinned    : 只能 ✕/ESC 關；點本體無作用、不循環、停在第一句
          //   sticky    : 依 until 條件關（M3 後啟用）
          "interaction": "advance",     // display | advance | choice | binary_split | timed_choice

          "lines": [
            { "text": "你點這麼多下幹嘛啦", "expression": "annoyed" },
            { "text": "手不會痠嗎？", "expression": "pout" }
          ],
          "motion": "annoyed",          // Live2D 動作；靜態圖忽略

          // ── 持續性參數（依 persistence 類型）──────────
          "auto_close_ms": 12000,       // null/0 = 不自動關（用於 persistent）
          "until": null,                // for sticky；條件解除即關閉（M3 後啟用）

          // ── 互動參數（依 interaction 類型）────────────
          "choices": null,              // for choice / timed_choice
          "binary": null,               // for binary_split：{ left:{label,next}, right:{label,next} }
          "time_branches": null         // for timed_choice（M3 後啟用）
        },
        {
          // 範例：persistent + choice
          "id": "ctm_002_choice",
          "type": "speech",
          "persistence": "persistent",
          "interaction": "choice",
          "lines": [
            { "text": "你連續點 4 小時了，要不要：", "expression": "annoyed" }
          ],
          "choices": [
            { "label": "休息 5 分鐘", "next": "ctm_rest_path" },
            { "label": "關通知",     "next": "ctm_silence_path" },
            { "label": "別管我",     "next": null }
          ]
        },
        {
          // 範例：thought + display
          "id": "ctm_003_thought",
          "type": "thought",
          "persistence": "transient",
          "interaction": "display",
          "lines": [
            { "text": "（這人手會不會抽筋啊⋯⋯）" }
          ]
        }
      ]
    },
    "long_idle": { /* ... */ },
    "deep_night": { /* ... */ },
    "drag": { /* ... */ }
  },
  "hour_tips": {
    "t5-7":   ["早安，{weekday}加油"],
    "t11-14": ["午餐時間了"],
    "t23-5":  ["都{hour}了還不睡"]
  },
  "seasons": [
    { "date": "01/01", "text": ["新年快樂"] },
    { "date": "12/24-12/25", "text": ["聖誕節要不要點蠟燭"] }
  ]
}
```

**Schema 預設值規則**：
- 未指定 `type` → `speech`
- 未指定 `persistence` → `transient`
- 未指定 `interaction` → `advance`
- 未指定 `auto_close_ms`：transient → 12000；persistent/pinned → null

**驗證規則**（runtime + AI 校驗器都跑）：
- `interaction: 'choice'` 必須有 `choices`
- `interaction: 'binary_split'` 必須有 `binary` 物件，含 `left` 與 `right` 欄位
- `interaction: 'timed_choice'` 必須有 `time_branches`（M3 後啟用）
- `persistence: 'sticky'` 必須有 `until`（M3 後啟用）
- `persistence: 'pinned'` 必出現 ✕ 關閉鈕
- `next` 引用的 sequence ID 必須在同一 dialogues.json 內存在
- `type: 'system' | 'narration'` **不應**綁定人格表情/動作（這兩種是程式發出的，與角色無關）

**完整型態論述**：見 [BUBBLE_TYPES.md](BUBBLE_TYPES.md)。

### 2.4 `personas/<id>/persona.json`

```jsonc
{
  "id": "snarky",
  "display_name": "毒舌小貓",
  "avatar": "avatar.png",
  "description_for_user": "看到你發呆會嘴你的毒舌型助手。",
  "ai_prompt": "你是一隻毒舌但內心關心使用者的桌面寵物。語氣戲謔、不正經，但會在使用者疲憊或熬夜時表達關切。每句限制 30 字內。禁用粗口。",
  "voice_profile": "edge-tts:zh-CN-XiaoyiNeural"
}
```

### 2.5 `models/static/<id>/manifest.json`

見 REQUIREMENTS.md §5.2。

### 2.6 `data/events/YYYY-MM-DD.jsonl`

每行一個事件 JSON。事件型別：

```jsonc
// 鍵盤事件（不記內容）
{"t":1715169600123,"type":"key","modifier":false}

// 滑鼠點擊
{"t":1715169601456,"type":"click","button":"left"}

// 滑鼠移動摘要（每秒聚合一次而非每動作一筆）
{"t":1715169602000,"type":"mouse_summary","distance_px":234,"clicks_in_sec":2}

// 前景視窗切換
{"t":1715169610789,"type":"focus","app":"chrome.exe","title":"[REDACTED]"}

// 閒置起訖
{"t":1715170200000,"type":"idle_start"}
{"t":1715170800000,"type":"idle_end","duration_sec":600}

// 全螢幕起訖
{"t":1715171000000,"type":"fullscreen_start","app":"LeagueOfLegends.exe"}
{"t":1715175000000,"type":"fullscreen_end","duration_sec":4000}

// 桌寵自身事件（用來做後續分析）
{"t":1715180000000,"type":"trigger_fired","category":"click_too_much","sequence_id":"ctm_001"}
{"t":1715180020000,"type":"bubble_dismissed","sequence_id":"ctm_001","completed":true}
```

### 2.7 `data/recent-dialogues.json`

```jsonc
{
  "ring_size": 50,
  "entries": [
    { "t": 1715180000000, "category": "click_too_much", "sequence_id": "ctm_001" },
    { "t": 1715190000000, "category": "long_idle", "sequence_id": "li_007" }
  ]
}
```

### 2.8 `data/stats.json`

```jsonc
{
  "today": "2026-05-08",
  "today_counters": {
    "clicks": 4523,
    "keys": 12834,
    "triggers_fired": 18,
    "by_category": { "click_too_much": 3, "long_idle": 2, "deep_night": 1 }
  },
  "rolling": {
    "interactions_per_hour_recent_24h": 6.5
  },
  "lifetime": {
    "first_seen": "2026-05-01T08:00:00Z",
    "total_triggers_fired": 312
  }
}
```

### 2.9 `data/last-generation.json`

```jsonc
{
  "last_run": "2026-05-08T03:00:00Z",
  "next_recommended": "2026-06-07T03:00:00Z",
  "events_window": { "from": "2026-04-08", "to": "2026-05-07" },
  "provider": "claude-api",
  "lines_generated": 1547,
  "validator_rejections": 23,
  "archive_path": "personas/snarky/archive/2026-05-08/"
}
```

---

## 3. 介面契約

### 3.1 `CharacterRenderer`（renderer 行程）

```typescript
interface CharacterRenderer {
  /** 載入指定模型路徑的全部資產 */
  load(modelPath: string): Promise<void>;

  /** 切換表情。靜態圖：換圖；Live2D：driveExpression */
  setExpression(name: string): void;

  /** 觸發動作。靜態圖：no-op；Live2D：playMotion */
  setMotion(name: string): void;

  /** 嘴型開合 0..1。靜態圖：≤0.33→閉, ≤0.66→半, >0.66→全；Live2D：直接餵參數 */
  setMouthOpen(value: number): void;

  /** 眼神聚焦座標（畫布座標系）。靜態圖：no-op；Live2D：setFocus */
  setFocusPoint(x: number, y: number): void;

  /** 取得對話氣泡定位錨點（角色頭部上方絕對座標） */
  getBubbleAnchor(): { x: number; y: number };

  /** 釋放資源 */
  destroy(): void;
}
```

### 3.2 `AIProvider`（main 行程，scripts 共用）

```typescript
interface AIProvider {
  readonly id: string;
  readonly displayName: string;
  readonly requiresApiKey: boolean;

  /** 健康檢查（金鑰、連線） */
  healthCheck(): Promise<{ ok: boolean; reason?: string }>;

  /** 批次生成台詞 */
  generateDialogues(input: GenInput): Promise<GenOutput>;
}

type GenInput = {
  personaPrompt: string;
  observationSummary: ObservationSummary;
  categories: string[];               // 要產出的分類
  linesPerCategory: number;
  language: 'zh' | 'ja';
};

type GenOutput = {
  byCategory: Record<string, GeneratedLine[]>;
  totalCost?: number;
  metadata: { provider: string; model: string; tokensUsed: number };
};
```

### 3.3 `TriggerEngine`（main）

```typescript
interface TriggerEngine {
  start(): void;
  stop(): void;

  /** 主動回報計數器當前值（DebugPanel 用） */
  getCounters(): CounterSnapshot;

  /** 強制重置所有冷卻（dev 模式） */
  resetCooldowns(): void;

  /** 手動觸發某分類（dev 模式） */
  fire(category: string): void;

  /** 訂閱觸發事件 */
  on(event: 'fire', handler: (e: TriggerEvent) => void): void;
}

type TriggerEvent = {
  category: string;
  rule_name: string;
  context: Record<string, any>;       // 給變數插值用：time/weekday/usage_hours/window_title
  fired_at: number;
};
```

### 3.4 `InputMonitor`（main）

```typescript
interface InputMonitor {
  start(): void;
  stop(): void;

  /** 取得當前快照 */
  snapshot(): {
    clicks_total: number;
    keys_total: number;
    last_input_at: number;
    is_typing: boolean;               // 連續鍵盤輸入中
    idle_sec: number;
    session_start: number;
  };

  on(event: 'click' | 'key' | 'idle-start' | 'idle-end', handler: Function): void;
}
```

### 3.5 `EventLogger`（main）

```typescript
interface EventLogger {
  start(): void;
  stop(): void;

  log(event: LogEvent): void;          // 內部會跑過濾再寫檔

  /** 讀取指定日期範圍的事件（Stage 1 用） */
  readRange(from: Date, to: Date): AsyncIterable<LogEvent>;

  /** 清除所有資料（隱私功能） */
  purgeAll(): Promise<void>;

  /** 預覽即將上傳的內容（隱私 UI 用） */
  previewUploadable(from: Date, to: Date): Promise<UploadablePreview>;
}
```

---

## 4. 事件流程（關鍵情境）

### 4.1 啟動序列

```
1. main.js
   ├─ 載入 settings.json（不存在 → 建立預設）
   ├─ 建立 transparent + click-through 視窗（位置從 window-state.json 讀）
   ├─ 建立 Tray
   ├─ 建立 InputMonitor（uiohook-napi 啟動）
   ├─ 建立 EventLogger
   ├─ 建立 FullscreenDetect
   ├─ 建立 TriggerEngine（注入上述）
   ├─ 建立 DialogueDirector（注入 ConfigStore）
   └─ 連接 TriggerEngine 'fire' → DialogueDirector → IPC → Renderer

2. Renderer (index.html)
   ├─ Preload 注入 window.api
   ├─ 讀 active_renderer，instantiate StaticImageRenderer 或 Live2DRenderer
   ├─ load(modelPath)
   └─ 訂閱 IPC dialogue:show / character:* / mouse:*
```

### 4.2 觸發 → 對話流程

```
[uiohook 點擊事件]
    │
    ▼
InputMonitor.click_total++ 並廣播 'click'
    │
    ▼
TriggerEngine 監聽到 'click'
    ├─ 檢查 DND 是否啟用 → 是則 return
    ├─ 檢查 fullscreen → 是則 return
    ├─ 檢查 typing → 是則 return
    ├─ 取得所有條件成立的 rules
    ├─ 排優先級 → 取最高
    ├─ 檢查冷卻（全域 + 分類）→ 任一未過則 return
    └─ emit 'fire' { category, context }
    │
    ▼
DialogueDirector
    ├─ 載入 active persona 的 dialogues.json
    ├─ 取 categories[category].sequences
    ├─ 過濾掉 recent-dialogues.json 內最近 50 句
    ├─ 隨機抽一個 sequence
    ├─ 對每行做變數插值（{time}, {weekday}, ...）
    ├─ 寫 recent-dialogues.json
    ├─ 寫 events JSONL: trigger_fired
    └─ IPC dialogue:show { sequenceId, lines, expression, motion }
    │
    ▼
SpeechBubble (renderer)
    ├─ CharacterStage.setExpression(expr)
    ├─ CharacterStage.setMotion(motion)
    ├─ 從 getBubbleAnchor() 計算氣泡位置
    ├─ 淡入 + 打字機開始
    │
    │  使用者點氣泡 → 'dialogue:advance'
    │     ├─ 若打字機未完 → 立刻顯示全句
    │     └─ 若已完 → 切下一句 lines[i+1]
    │
    ├─ 最後一句結束 → 顯示 ✓ 提示符 → 等使用者點或 12 秒自動關
    └─ 'dialogue:dismiss' → 寫 events: bubble_dismissed
```

### 4.3 拖曳互動流程

```
1. 滑鼠進入角色 hit-area
   → 'mouse:enter-character'
   → main: BrowserWindow.setIgnoreMouseEvents(false, { forward: true })

2. 按下 + 移動
   → renderer 自行處理位移（CSS transform）
   → 'character:drag-start' → TriggerEngine 視為 event
   → 若觸發「拖曳發話」規則 → 一般對話流程

3. 放開 + 滑鼠離開角色
   → 'mouse:leave-character'
   → main: setIgnoreMouseEvents(true, { forward: true })
   → 寫 window-state.json 記新位置
```

### 4.4 Stage 1 重新生成流程

```
1. 觸發點
   ├─ 設定視窗點「立即重生」按鈕 → IPC trigger
   └─ 自動：last-generation.json 顯示 ≥30 天 → 提示
   │
   ▼
2. main 起 child_process 跑 scripts/generate-dialogues.js
   │
3. generate-dialogues.js
   ├─ 讀 last 30 天 events JSONL
   ├─ 計算 ObservationSummary（時段熱力、應用 top-N、平均閒置...）
   ├─ 載入 active persona 的 persona.json（取 ai_prompt）
   ├─ AIProvider.healthCheck() → 失敗則中止
   ├─ 顯示「即將上傳預覽」（若使用者未明示同意）→ 等使用者確認
   ├─ AIProvider.generateDialogues(...)
   ├─ 跑校驗器：長度 / 變數合法性 / 重複度 / 禁用詞
   │  └─ 不合格 → 補生（最多 3 輪）
   ├─ archive 舊 dialogues.json → personas/<id>/archive/<date>/
   ├─ 寫新 dialogues.json
   ├─ 寫 last-generation.json
   └─ 通知 main 重新載入 persona
```

---

## 5. 觸發引擎細節

### 5.1 條件 DSL

支援的 `condition.type`：

| type | 欄位 | 語意 |
|---|---|---|
| `counter_threshold` | `counter`, `operator`, `value` | 計數器與閾值比較 |
| `idle_duration` | `operator`, `value_sec` | 閒置時長 |
| `session_duration` | `operator`, `value_sec` | 連續使用時長 |
| `time_window` | `from`, `to` | 當前時間在區間內（支援跨日 23-5） |
| `weekday` | `days` | 星期幾命中 |
| `event` | `event` | 內部事件直觸（拖曳、戳臉等） |
| `composite` | `op`, `conditions[]` | AND/OR 組合 |

範例組合：

```jsonc
{
  "name": "weekend_late_night_long_idle",
  "priority": 80,
  "condition": {
    "type": "composite",
    "op": "and",
    "conditions": [
      { "type": "weekday", "days": [0, 6] },
      { "type": "time_window", "from": "00:00", "to": "04:00" },
      { "type": "idle_duration", "operator": ">=", "value_sec": 600 }
    ]
  }
}
```

### 5.2 動態冷卻演算法

```
每分鐘重算 hourly_interactions（最近 60 分鐘的 trigger_fired 數）

effective_cooldown = base_cooldown_sec × multiplier

multiplier =
  if hourly_interactions >= high_activity_threshold:
      high_activity_multiplier (預設 0.7)
  else if hourly_interactions <= low_activity_threshold (預設 2):
      low_activity_multiplier (預設 1.5)
  else:
      1.0

最終 effective_cooldown 仍受各分類 min_cooldown_sec 下限約束
```

### 5.3 優先級解析

當一個事件命中多條規則時：
1. 篩出 `condition` 全部成立的規則
2. 篩出**冷卻已過**的
3. 取 `priority` 最高
4. 同 priority 隨機取一

優先級語意（建議區段）：
- 100+ ：使用者直接互動（拖曳、戳臉）
- 50-99 ：時段 / 節日 / 季節
- 20-49 ：閒置 / 連續使用
- 1-19  ：累計次數類

### 5.4 打字偵測

```
is_typing = (now - last_keypress < 1000ms) && (recent 5s key count >= 5)
typing_quiet_after = 5000ms

若 is_typing 為真 → 暫停所有「閒置 / 累計次數 / 時段」類觸發
拖曳事件不受此限（使用者主動互動優先）
```

### 5.5 全螢幕偵測

`fullscreen-detect.js` 每秒輪詢 Win32 API：
```
foreground = GetForegroundWindow()
rect = GetWindowRect(foreground)
if rect equals primary monitor work area && WS_POPUP style:
    is_fullscreen = true
```
進入時主行程廣播 `'fullscreen:start'`（renderer 隱藏角色），TriggerEngine 暫停。

---

## 6. EventLogger 規範

### 6.1 寫入規則

- 路徑：`data/events/YYYY-MM-DD.jsonl`
- 模式：append-only，UTF-8，行尾 `\n`
- buffer：每 100 條或每 5 秒 flush 一次
- 每天 00:00 換新檔

### 6.2 過濾規則

每個事件**入庫前**跑過濾：

```javascript
function filter(event) {
  if (event.type === 'focus') {
    event.title = redactSensitive(event.title);
  }
  // 鍵盤事件保留 type/timestamp，不存任何鍵內容
  // 滑鼠座標只寫入「移動量總和」不寫入絕對座標
  return event;
}

const SENSITIVE_PATTERNS = [
  /\b[\w.-]+@[\w.-]+\.\w+\b/,                      // email
  /\bhttps?:\/\/\S+/,                               // URL
  /\b(?:\d{4}[\s-]?){3}\d{4}\b/,                   // 信用卡格式
  /\b[A-Z]{2}\d{2}[A-Z0-9]{4,30}\b/,               // IBAN
  /\b[A-Z]\d{9}\b/,                                 // 護照
  /\b[A-Z]\d{8}\b/,                                 // 身分證 (台灣格式)
];
```

### 6.3 輪替清理

- 30 天前的 .jsonl → 自動 gzip 為 `.jsonl.gz`
- 60 天前的 → 刪除
- `purgeAll()` → 立刻清整個 `data/events/`

### 6.4 v1.2 後加固項（PRIVACY_ANALYSIS §8）

- 應用程式黑名單：可在 settings.json 指定 `"logger_blacklist": ["keepass.exe", "1password.exe"]`，列在內的 app focus 事件不寫
- AES-256 加密儲存：金鑰存 OS keychain，未持金鑰開不了

---

## 7. Stage 1 Pipeline 規範

### 7.1 ObservationSummary 結構

```jsonc
{
  "window": { "from": "2026-04-08", "to": "2026-05-07" },
  "totals": {
    "active_days": 28,
    "total_clicks": 145320,
    "total_keys": 532910,
    "total_idle_minutes": 8740
  },
  "hourly_distribution": [/* 24 個 0-1 數值 */],
  "weekday_distribution": [/* 7 個 0-1 數值 */],
  "top_apps": [
    { "app": "chrome.exe", "active_minutes": 5230, "share": 0.31 },
    { "app": "code.exe", "active_minutes": 3100, "share": 0.18 }
  ],
  "fullscreen_usage_minutes": 1200,
  "avg_idle_duration_sec": 480,
  "longest_session_sec": 21600,
  "typical_late_night_active": true,            // 23:00-05 有顯著活動
  "weekend_pattern": "low",                     // low | similar | high
  "trigger_history_summary": {
    "total_fired": 412,
    "by_category": { "click_too_much": 67, "long_idle": 89, "..." : 0 }
  }
}
```

### 7.2 Prompt 模板

```
[SYSTEM]
你是一位為桌面寵物撰寫角色台詞的編劇。
人格：{{persona.ai_prompt}}
語言：{{language}}

[CONSTRAINTS]
- 每句 ≤ 30 字
- 可用變數：{time}, {hour}, {weekday}, {usage_hours}, {window_title}
- 變數必須是上面 5 個之一，不可發明新變數
- 禁用：粗口、政治、宗教、性、人身攻擊
- 序列每組 1-3 句，互相銜接

[CONTEXT — 使用者觀察]
{{observation_summary}}

[TASK]
為以下分類各產出 {{lines_per_category}} 組對話序列：
- click_too_much: 觸發時機是使用者短時間點擊很多次
- long_idle: 觸發時機是使用者離開超過 30 分鐘
- ...

請根據 [CONTEXT] 中的「使用者觀察」量身寫，例如：
- 若 typical_late_night_active=true，可在 deep_night 分類嘲諷夜貓子
- 若 weekend_pattern=high，可在週末加入工作狂吐槽

[OUTPUT FORMAT]
JSON：{ "click_too_much": [{...}, ...], "long_idle": [...], ... }
每個 sequence: { "lines": [{"text": "...", "expression": "..."}], "motion": "..." }
```

### 7.3 校驗器規則

```typescript
function validate(line: GeneratedLine, context: ValidationContext): Result {
  if (line.text.length > 30) return { ok: false, reason: 'too_long' };
  if (UNALLOWED_VARS_REGEX.test(line.text)) return { ok: false, reason: 'unknown_var' };
  if (FORBIDDEN_WORDS.some(w => line.text.includes(w))) return { ok: false, reason: 'forbidden' };

  // 語意去重：與過去 50 句 cosine similarity < 0.85
  const sim = cosineSim(embed(line.text), context.recentEmbeddings);
  if (sim > 0.85) return { ok: false, reason: 'duplicate' };

  // 人格一致性：embedding 與 persona prompt 相似度 ≥ threshold
  const pSim = cosineSim(embed(line.text), context.personaEmbedding);
  if (pSim < 0.3) return { ok: false, reason: 'persona_drift' };

  // 表情對應正規表
  if (!ALLOWED_EXPRESSIONS.has(line.expression)) {
    return { ok: false, reason: 'unknown_expression' };
  }

  return { ok: true };
}
```

不合格句**不丟棄**，記入 `last-generation.json.validator_rejections` 並用補生迴圈替換（最多 3 輪）。

### 7.4 Provider 抽象實作清單

```
scripts/ai-providers/
├── claude.js          // Anthropic SDK，prompt caching
├── openai.js          // OpenAI SDK
├── ollama.js          // 本地 HTTP，預設 http://localhost:11434
└── index.js           // factory: byId(settings.ai_provider)
```

### 7.5 archive 機制

```
重生前：
  cp personas/snarky/dialogues.json personas/snarky/archive/2026-05-08/dialogues.json
  cp personas/snarky/voices/ → archive 不複製（語音檔保留）
重生後：
  寫新 dialogues.json
  使用者可在設定視窗看歷史版本，一鍵回滾
```

---

## 8. 錯誤處理與韌性

| 場景 | 處理 |
|---|---|
| `settings.json` 損壞 | 使用最近 .bak；都壞則重建預設並告警 |
| `dialogues.json` 損壞 | 切換到 fallback persona |
| InputMonitor 啟動失敗（uiohook 載入失敗） | tray 出現警告，桌寵仍可顯示但停用觸發；提示使用者檢查防毒 |
| Renderer 渲染失敗（Live2D 模型載入錯誤） | 自動 fallback 到 static-image renderer + 使用該人格的 default-static |
| AI provider 失敗（金鑰無效、網路錯） | 重生流程中止，保留舊 dialogues.json，UI 顯示錯誤；不卡執行期 |
| 視窗位置在已不存在的螢幕（拔掉外接螢幕） | 偵測螢幕清單，若位置出界 → 重設到主螢幕中央 |
| Tray icon 載入失敗 | 用內嵌 base64 fallback 圖示 |
| 透明視窗閃爍 | 偵測閃爍率 > 閾值 → 提示使用者切換 fallback 模式（disable transparent） |

**全域原則**：
- 任何失敗**不可崩潰整個應用**。
- 每個模組獨立失敗，主循環容錯。
- 嚴重錯誤寫 `data/error.log`（rolling 3 檔）。

---

## 9. 日誌與觀察性

### 9.1 應用日誌（與 events 不同）

- 路徑：`data/app.log`
- 等級：依 `settings.log_level`
- 內容：模組啟動/停止、IPC 異常、AI 呼叫、設定變更
- 輪替：5MB / 檔，保留 5 個

### 9.2 不寫入日誌的內容

- 任何使用者輸入內容
- API 金鑰、token
- events 的具體值（events 已有專屬路徑）

### 9.3 Debug 面板可視化

- 即時計數器（每秒更新）
- 觸發紀錄表（最近 50 筆，可點查 sequence 細節）
- 時段熱力圖（24 小時 × 7 天）
- 應用使用 Top-10 圓餅圖
- 「即將上傳給 AI」預覽（手動觸發）

---

## 10. 命名與版本

### 10.1 檔案命名規範

- JSON 設定：`kebab-case.json`
- JS 模組：`kebab-case.js`
- 類別：`PascalCase`
- 變數/函式：`camelCase`
- 事件 ID（sequence_id 等）：`snake_case`

### 10.2 schema 版本標記

每個會異動的 JSON 檔頂層放 `"$schema": "v1"`。schema 升級時：
- minor 變動（加欄位）：相容讀取
- major 變動：跑遷移腳本 `scripts/migrate-schema.js`

### 10.3 應用版本

`package.json`/`version` follow semver。`v0.x` 為自用內測；`v1.0` 視為功能完整可發布。

---

## 11. 打包與部署

### 11.1 開發

```
. .\env.ps1            # 啟用 portable Node
npm install            # 首次
npm start              # 啟動
npm start -- --dev     # dev 模式
```

### 11.2 打包

- 工具：electron-builder
- 輸出：`dist/p5-Setup-X.Y.Z.exe` 安裝版 + `dist/p5-X.Y.Z-portable.zip` 可攜版
- 簽章：自用階段不簽，商業化前需取得 OV/EV 證書
- 圖示：`assets/icon.ico`（256/128/64/32/16 五尺寸）

### 11.3 自更新（自用階段不做）

預留 `electron-updater` 介接點，但 P1-P7 不啟用。

---

## 12. 關聯文件

- 上層：[REQUIREMENTS.md](REQUIREMENTS.md)
- 同層：[MILESTONES.md](MILESTONES.md)、[PRIVACY_ANALYSIS.md](PRIVACY_ANALYSIS.md)
- 工作流規則：[CLAUDE.md](CLAUDE.md)
