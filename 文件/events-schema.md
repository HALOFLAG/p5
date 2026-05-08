# events JSONL Schema 速查

> 對應 M3。`data/events/YYYY-MM-DD.jsonl` 是 source of truth；`stats.json` 與 `recent-dialogues.json` 都是可重建的 cache。
>
> 每行一個 event 物件，所有 event 都帶 `t`（epoch ms）。寫入由 EventLogger 1 秒 buffer 批次 flush。

---

## 通用欄位

| 欄位 | 型別 | 說明 |
|---|---|---|
| `t` | number | epoch ms。優先序：明確指定 > `ended_at` > `started_at` > 寫入當下 |
| `type` | string | 事件種類（見下表） |
| `source_plugin` | string? | 由 plugin emit 的事件會帶；InputMonitor / 直接 log() 的不帶 |

---

## Tier 1 — InputMonitor 聚合事件

源頭聚合策略：鍵盤不記字元、滑鼠不記座標。

### `typing-burst`
連續打字段（keydown 間隔 < 1500ms 視為同 burst，停手 > 1500ms 切下一段）。

| 欄位 | 說明 |
|---|---|
| `started_at` / `ended_at` | epoch ms |
| `duration_ms` | burst 長度（毫秒） |
| `key_count` | 該段內按鍵總數 |
| `modifier_ratio` | 0..1，含 Ctrl/Alt/Shift/Win 的比例 |
| `backspace_ratio` | 0..1，Backspace 的比例（高 = 在改稿） |

### `mouse-burst`
1 秒視窗聚合的滑鼠移動摘要。

| 欄位 | 說明 |
|---|---|
| `started_at` / `ended_at` | epoch ms |
| `duration_ms` | 段長 |
| `distance_px` | 累計移動距離 |
| `active_ms` | 實際移動時長（停下不算） |
| `max_speed_px_per_sec` | 該段最高速度 |

### `click`
單次點擊事件（即時 emit，給 TriggerEngine 用）。

| 欄位 | 說明 |
|---|---|
| `button` | `'left' \| 'right' \| 'middle' \| 'button4' \| 'button5' \| 'other'` |

### `click-burst`
5 秒視窗的 click 統計（與 `click` 雙軌並存）。

| 欄位 | 說明 |
|---|---|
| `started_at` / `ended_at` / `duration_ms` | — |
| `count` | 該段點擊總數 |
| `by_button` | `{ left, right, middle, other }` |

### `idle-start` / `idle-end`
連續 5 分鐘無輸入觸發 idle-start；任何輸入觸發 idle-end。

| 欄位 | 說明 |
|---|---|
| `started_at` | idle 起始時間 |
| `ended_at` | idle-end 才有 |
| `duration_ms` | idle-end 才有 |

---

## Tier 2 — 環境感知 plugins

### `power:lock` / `power:unlock` / `power:sleep` / `power:resume` / `power:ac` / `power:battery`
來源：`tier2-power`（Electron `powerMonitor`）。
無額外欄位，靠 `type` 區分。

### `screen:added` / `screen:removed` / `screen:metrics-changed`
來源：`tier2-screen`。

| 欄位 | 說明 |
|---|---|
| `display` | `{ id, bounds, workArea, scaleFactor, rotation, internal }` |
| `changedMetrics` | `metrics-changed` 才有 |

### `theme:dark-mode-changed`
來源：`tier2-theme`。

| 欄位 | 說明 |
|---|---|
| `isDark` | boolean |

### `window:focus-changed`
來源：`tier2-window-tracker`。**title 已過 redact**（email/URL/卡號等敏感字串會變 `[REDACTED]`）。

| 欄位 | 說明 |
|---|---|
| `app` | exe basename，**全小寫**（如 `chrome.exe`） |
| `title` | 視窗標題（已 redact） |
| `pid` | process id |
| `exe_path` | exe 完整路徑（M3 暫不 redact） |

### `fullscreen:state`
全螢幕進出。confidence 由 multiple sources 加總（覆蓋 work area >= 95% 給 0.5；覆蓋 screen bounds >= 99% 給 0.3）。

| 欄位 | 說明 |
|---|---|
| `active` | boolean |
| `confidence` | 0..1 |
| `app` | `active=true` 時帶 |
| `duration_ms` | `active=false` 時帶（剛剛全螢幕了多久） |

---

## Tier 3 — 進階感知 plugins

### `system:stats-tick`
來源：`tier3-system-stats`。每 5 秒一筆。

| 欄位 | 說明 |
|---|---|
| `cpu_pct` | 0..100，整體 CPU 使用率 |
| `gpu_pct` | 0..100，**部分驅動可能 null** |
| `ram_pct` | 0..100 |
| `sampled_at` | epoch ms |

### `audio:session-started` / `audio:session-ended`
來源：`tier3-audio-session`。降目標版（依已知影音 exe 清單 + hysteresis）。

| 欄位 | 說明 |
|---|---|
| `exe` | 影音 app exe（如 `spotify.exe`、`chrome.exe`） |
| `duration_ms` | `ended` 才有 |

> ⚠️ 已知限制：簡化版用「process 存活」推論「正在發聲」，瀏覽器類常誤判。M5/M6 升級為真 WASAPI 會解決。

### `mic:recent-access-by` / `mic:released-by` / `cam:recent-access-by` / `cam:released-by`
來源：`tier3-mic-cam-activity`（PowerShell 讀 ConsentStore 登錄檔）。每 5 秒輪詢。

| 欄位 | 說明 |
|---|---|
| `exe` | 應用名稱（如 `teams.exe`） |

> ⚠️ ConsentStore 反映「最近存取」非「正在使用」，所以命名是 `recent-access-by`。

### `clipboard:changed`
來源：`tier3-clipboard-watcher`。每 2 秒比對 sha1。**raw text 永不寫入**。

| 欄位 | 說明 |
|---|---|
| `hash` | sha1 hex |
| `length` | 字串長度 |
| `has_url` | boolean，內容是否含 `http(s)://` |
| `has_email_pattern` | boolean，是否疑似 email |

---

## 輸出層 — TriggerEngine + DialogueDirector

### `trigger:fired`
TriggerEngine 評估後 emit，DialogueDirector 接到後寫入 logger。

| 欄位 | 說明 |
|---|---|
| `rule_name` | 規則名（如 `click_too_much`、`drag_character`） |
| `category` | 對應 dialogues.json 的 category |
| `sequence_id` | 抽中的 sequence id（如 `haiyin_ctm_001`） |
| `persona` | active persona（如 `haiyin`、`liss`） |

### `plugin:degraded`
MonitorRegistry 偵測到 plugin 失聯時 emit。

| 欄位 | 說明 |
|---|---|
| `plugin` | plugin id |
| `reason` | `start-failed` / `heartbeat-stale` / 其他 |
| `error` | 錯誤訊息字串 |

---

## 不會出現的欄位（隱私硬底線）

- 鍵盤 keychar / 字元內容
- 滑鼠絕對座標
- 剪貼簿 raw text
- 應用程式黑名單（settings.json `logger_blacklist`）內的 focus event **整筆不寫**

---

## 工具

```bash
# 把 JSONL 轉成人類可讀時序日誌
node scripts/dump-events.js

# 只看今天最後 50 筆 trigger:fired
node scripts/dump-events.js --types trigger:fired --tail 50

# 看前 30 分鐘的事件
node scripts/dump-events.js --since 30m

# 統計各類型計數
node scripts/dump-events.js --summary
```
