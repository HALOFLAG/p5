# `analyze-rollup.js` 設計

> 用途：「每小時 rollup → 多日趨勢分析」工具的設計討論。
> 文件性質：實作前討論記錄，未真正寫程式。實作時參考此文件。
> 預計工日：1-2 天，最佳時機為累積 ≥ 1 週資料後。

---

## 1. 角色定位

三個資料工具的職責切分：

```
data/events/*.jsonl       ← dump-events.js     →  「過去 N 分鐘細節」（除錯用）
        │
        ↓ 聚合
data/rollups/*.jsonl      ← build-rollup.js    →  「過去 N 小時統計」（單日內）
        │
        ↓ 多日分析
（記憶體 / JSON 輸出）     ← analyze-rollup.js  →  「過去 N 天 / 週 / 月 趨勢」
```

`build-rollup.js` 看「**單日內每小時長怎樣**」，`analyze-rollup.js` 看「**這個禮拜跟上禮拜有什麼不同**」。前者是切片，後者是趨勢。

---

## 2. 為什麼需要它

從 1 小時 rollup 直接看「30 天 × 24 小時 = 720 個 hour bucket」對人類太雜，對 LLM 也是 token 噩夢。需要一個**中間轉譯層**把 720 個 bucket 壓成「人類/LLM 能消化的趨勢段落」。

這層轉譯邏輯**跟 M7 ObservationSummary 模組是同一件事**。CLI 版本就是「在不啟動 LLM 的情況下，先跑出 LLM 將要讀的東西」— 你可以**用眼睛驗證**這個摘要是否真的反映你的使用模式，再考慮餵給 LLM。

---

## 3. 五個 mode 設計

| Mode | 輸出形式 | 服務時機 |
|---|---|---|
| `summary` | 表格 + 條列數字 | 日常掃眼「這禮拜活動量怎樣」 |
| `hourly` | ASCII bar chart（24 行）| M4 寫**時段相關**台詞時參考 |
| `weekday` | 7 行週幾對照 | M4 寫**週幾相關**台詞時參考 |
| `session` | 直方圖 + 統計 | 調 trigger 規則參數時參考 |
| **`profile`** | **自然語言段落** | **送 LLM 之前最終預覽** |

### CLI 用法

```powershell
# 看單一視角（多數時候）
node scripts/analyze-rollup.js --mode summary
node scripts/analyze-rollup.js --mode profile

# 一鍵全部
node scripts/analyze-rollup.js --mode all

# 區間
node scripts/analyze-rollup.js --since 7d
node scripts/analyze-rollup.js --range 2026-04-01 2026-04-30
node scripts/analyze-rollup.js --week                 # 上一個完整週

# 給 M7 用
node scripts/analyze-rollup.js --mode profile --export json > profile.json
```

每次跑都是**現查現算**從 hourly rollup 重算（idempotent），不會自動排程或寫成持久檔案（除非 `--export json`）。

### Mode 1 — `summary` 範例

```
=== 過去 7 天總覽 ===
活躍小時數：38.5h（平均每天 5.5h）
總點擊：32,521 / 總鍵：18,403
觸發次數：48（drag 18, click_too_much 12, deep_night 14, long_idle 4）

主要時段：14:00-19:00（35%）+ 22:00-02:00（28%）
凌晨工作（00-05）：每週累計 12h
週末 vs 平日：差異 < 10%（基本天天工作）

Top apps：code.exe 14.2h, chrome.exe 8.7h, discord.exe 4.1h
Discord 通話：每週 4 次，平均 1.5h
```

### Mode 2 — `hourly` 範例

```
=== 24 小時活動熱度（過去 14 天平均）===
00 ███████████████ 41 click/h
01 ██████████████ 38
02 ████████ 22
...
14 ████████████████████ 56  ← 最活躍
15 ███████████████████ 53
...
22 ██████████████████ 50
23 █████████████████ 47
```

可同時看：click density / mouse density / app focus density / trigger density。

### Mode 3 — `weekday` 範例

```
=== 週幾模式（過去 30 天）===
週一: 6.8h, 主要 14-18, top1 code.exe (3.2h)
週二: 7.5h, 主要 14-19, top1 code.exe (3.8h), 通話 1 次
週三: 7.1h, 主要 14-18, top1 chrome.exe (2.9h)
週四: 8.3h, 主要 13-19+22-02, top1 code.exe (4.5h), 通話 2 次  ← 高峰日
週五: 6.0h, 主要 15-19, top1 chrome.exe (2.1h)
週六: 5.2h, 主要 22-02, top1 discord.exe (2.5h)  ← 週末模式不同
週日: 4.8h, 主要 22-02, top1 chrome.exe (2.2h)
```

### Mode 4 — `session` 範例

從 hourly + idle 反推「沒休息的連續工作段」。

```
=== 工作 session 統計（過去 14 天）===
總 session 數：43
平均長度：1h 47m
最長：4h 32m（2026-04-28 14:00-18:32）

長度分布：
  < 30m   : ████ 6 次
  30-60m  : ██████████ 14 次
  1-2h    : █████████████ 18 次  ← 最常見
  2-4h    : ████ 5 次
  4h+     : (warning) — 0 次本週

連續工作 4h+：每週平均 0.7 次
凌晨 session（00:00 後開始）：每週平均 3 次
```

對「桌寵該不該嘴你」的決策最有用。

### Mode 5 — `profile` 範例（最重要）

```
=== 使用者行為畫像（過去 30 天）===

你是夜貓子型工作者。主要活動時段在 14:00-19:00（下午檔）跟
22:00-02:00（深夜檔），每天平均工作 6.8 小時。週末跟平日無顯著
差異，傾向「天天工作」型。

你的主力工具是 VSCode（每週累計 32.5h），常配合 Chrome 看
DevTools。Discord 是主要溝通管道，每週通話 4-5 次，平均 1.5h，
集中在週四下午跟週六晚上。

工作節奏特徵：典型 session 長度 1-2 小時。連續 4 小時不休息
每週發生 0.7 次，多在週四。凌晨後（00:00-05:00）開始的 session
每週 3 次，最晚記錄到 04:32。

桌寵互動模式：drag 拒絕率 0%，click_too_much 自然觸發每週 2.3 次，
long_idle 4 次。對 deep_night 提醒接受度不明（觸發後 2 分鐘內
仍在打字，建議 M4 加追蹤）。

不易察覺但值得提的細節：
- 週四是「會議+加班」雙峰，疲勞風險最高
- 修飾鍵比例 60%+ 的時段集中在 14-16（精力高峰，多用快捷鍵）
- backspace 比例峰值在週五下午（可能是改稿日）
```

**這份段落直接餵 LLM 就能生個人化台詞**。CLI 版能讓你**事先預覽 LLM 將要看到什麼**，發現不對再調 prompt 或 mode。

---

## 4. profile mode 實作策略

### 4.1 不用 LLM 寫 profile

**Profile mode 不會用 LLM**。要的話也是 M7 階段把板型輸出**再餵** LLM 的事。M3.5/M4 階段的 profile mode 用 **rule-based 板型 + 異常偵測** 組合而成：

| 屬性 | profile mode | 為什麼 |
|---|---|---|
| 隱私 | 100% 本地 | 不送任何資料給雲端 |
| 成本 | 零 | 不呼叫 API |
| 可預測性 | 高 | 每次跑長相穩定 |
| 預覽功能 | 完整 | 你看完才決定要不要送 LLM |

**為什麼不用 LLM**：profile mode 本身就是「**送 LLM 前的預覽**」，用 LLM 寫等於循環論證（被預覽的東西又是 LLM 寫的）。

### 4.2 板型不會死板的關鍵

不是「**一個大板型套全部資料**」，是「**幾十個小段落片段，根據資料命中組裝**」。

每個欄位有 3-5 種變體，組合空間遠超「一個固定板型」。例：「主要時段」這一行：

```
條件命中                            輸出文字
────────────────────────────────────────────────────────────
1 個尖峰時段                        主要活動時段集中在 {peak1}。
2 個尖峰時段                        主要時段在 {peak1} 跟 {peak2}。
3+ 尖峰（碎片化）                   工作時段呈碎片化分佈，無明顯尖峰。

凌晨工作 > 30%                      → 加上「你是夜貓子型工作者」開場
早上 6-9 點 > 30%                   → 加上「你是早起型工作者」開場
均勻分佈                            → 加上「工作時段相對均勻」開場
```

### 4.3 ProfileGenerator 結構

```
ProfileGenerator
   │
   ├─ Step 1: analyzeRollups(rollups) → DataPoints
   │     - 30+ 個量化指標
   │     - peakHours, lateNightHourPct, sessionAvg, topApp,
   │       chatSessionsPerWeek, modifierRatioByHour, ...
   │
   ├─ Step 2: matchProfile(DataPoints) → ProfileTags
   │     - tags: ['late_night_worker', 'short_session', 'heavy_chat_user']
   │     - 可多 tag 共存
   │
   ├─ Step 3: detectAnomalies(DataPoints) → AnomalyFacts
   │     - facts: ['週四加班高峰', 'Backspace 比例週五異常高']
   │     - z-score / threshold 偵測
   │     - 只在資料真有異常時才 emit
   │
   └─ Step 4: render(tags, facts) → Markdown profile
         - 每個 tag 對應一段含 {變數} 的固定文案
         - facts 插入到「不易察覺但值得提的細節」段落
```

### 4.4 異常偵測（讓 profile 有靈魂）

profile 段落最後一段「不易察覺但值得提的細節」是動態的：

```
for indicator in INDICATORS:
    z = (current - baseline.mean) / baseline.std
    if abs(z) > 2.0:
        facts.append(template_for(indicator, z))
```

**監測指標範例**：
- 週幾差異（z-score 找出「比平均凸出」的星期）
- modifier_ratio 在不同 hour 的差異（找出「精力高峰時段」）
- backspace_ratio 在不同 weekday 的差異（找出「改稿日」）
- session 長度突然變化（找出疲勞累積）

**只在真有異常時才 emit**，不會每次硬塞「值得注意」段落。

### 4.5 同板型對不同資料的差異

**人 A（夜貓 + 重 chat）：**
```
你是夜貓子型工作者。主要時段在 14:00-19:00 跟 22:00-02:00。
凌晨工作（00-05）每週 12h。
主力工具是 VSCode（每週 32h），常配合 Chrome 使用。
Discord 是主要溝通管道，每週通話 4 次，平均 1.5h。
工作節奏特徵：典型 session 長度 1-2 小時。
連續 4h+ 不休息每週 0.7 次。
值得注意：週四是會議+加班雙峰，疲勞風險最高。
```

**人 B（早起 + 短 session）：**
```
你是早起型工作者。主要時段集中在 08:00-12:00 + 13:00-17:00。
主力工具是 Excel（每週 28h），常配合 Outlook 使用。
無顯著通話模式（每週 < 1 次）。
工作節奏特徵：典型 session 長度 45 分鐘。
session 普遍偏短，建議追蹤是否被頻繁中斷。
值得注意：週五下午 backspace 比例顯著高於平均（改稿日特徵）。
```

**同一份 ProfileGenerator 程式**，靠資料自己變化出兩種完全不同的描述。

---

## 5. 跟 M7 的關係（寫一次用兩次）

```
[M3 增補 已做]              [analyze-rollup.js 計畫做]              [M7 計畫做]

  hourly rollup  ──→  ProfileGenerator (CLI 形式)  ──→  ProfileGenerator (整合進 main.js)
                                ↓                                  ↓
                       人類可讀的 profile 段落           prompt 模板 + LLM call
                                                                ↓
                                                         個人化台詞
```

**寫一次用兩次**：CLI 版本的 helper 函式（指標計算、tag 匹配、異常偵測、文案組裝）M7 階段直接 require 進 ObservationSummary 模組。

LLM **不直接看 raw rollup**（300MB），看的是已經被 ProfileGenerator 篩過、整理好的 profile 段落（~1KB）：
- token 經濟
- 不會在統計數字裡迷路
- 隱私風險低（profile 已經是「使用者層級畫像」不是「分鐘級行為」）

---

## 6. 工日估計

| 範圍 | 工日 | 內容 |
|---|---|---|
| **簡化版** | **1 天** | summary + hourly + weekday + app 4 個 mode（不含 profile） |
| **完整版** | **1.5-2 天** | 加 session 偵測 + profile mode（含 ~20 個板型片段 + 5+ 異常偵測） |
| 進階版 | 2-3 天 | 再加「跟前一週對比」「異常偵測進階指標」 |

工日大部分花在「**寫板型片段文字**」（這跟 M4 fallback 一樣是寫作工作），程式邏輯本身只佔 0.3-0.5 天。

我**傾向完整版**：profile mode 是最有價值的部分，沒它的話 CLI 工具的意義就只剩 debug。

---

## 7. 何時做最有意義

| 時機 | 評估 |
|---|---|
| 現在做（M3 → M4 之間）| ❌ 還沒累積夠資料，profile 段落會空洞 |
| **累積 1 週後做** | ✅ 有基本趨勢可看 |
| **累積 2-4 週做** | ⭐ 最佳，週模式跟長期 pattern 都顯現 |
| M7 開始前才做 | 可，但等於 M7 一部分 |

**建議累積 1 週後做**：
- 那時 24h 跑過幾天，有足夠資料看趨勢
- profile 段落已能反映真實使用模式
- M4 開發期間正好可以拿這份 profile **驗證 fallback 台詞符不符合實際工作型態**

---

## 8. 關於「報告 vs 分析工具」釐清

| 屬性 | 「報告」字面 | analyze-rollup.js 實際 |
|---|---|---|
| 生成時機 | 定期排程 | **on-demand 跑** |
| 結果落地 | 寫成檔案備查 | console 輸出，加 `--export json` 才落地 |
| 樣式 | 固定欄位 | 多 mode 切換 |
| 一次出全部 | 是 | **預設一次一個 mode**，可 `--all` 全跑 |

每次跑都是**現查現算**從 hourly rollup 重算，不會堆死資料在硬碟。

---

## 9. 待決策事項

實作前要確認：

| 決策 | 選項 | 預設傾向 |
|---|---|---|
| 板型片段數量 | 簡化（10-15）/ 完整（30+）/ 進階（50+）| 完整版 |
| 板型語氣 | 中性報告 / 對話口吻 / 數據冷感 | 中性偏對話（接近你 dialogues 風格）|
| 異常偵測門檻 | z-score > 2 / > 1.5 / > 2.5 | z-score > 2.0（保守）|
| `profile` 是否含「臆測解讀」 | 「你可能是 X 型」 / 純客觀 | 純客觀，避免冒犯 |
| 預設區間 | 7 天 / 14 天 / 30 天 | 7 天（資料累積初期） |
| `summary` 是否含上週對比 | 有 / 沒有 | 進階版才有 |

---

## 10. 不必現在做的部分

可延後：
- 「跟前一週對比」（需累積 ≥ 2 週才有意義）
- 「異常偵測進階指標」（需 baseline）
- 「機器學習聚類」（過度設計，肉眼能看出 pattern 就夠）
- 多語言（M7 階段視需求）

---

## 11. 實作 checklist（實際開工前看這份）

- [ ] 確認 `data/rollups/` 已累積 ≥ 7 天資料
- [ ] 寫 `scripts/analyze-rollup.js` 主程式（CLI 解析、檔案載入）
- [ ] 寫 `src/main/profile-generator.js`（核心 logic）
  - [ ] `analyzeRollups()` 算 30+ 指標
  - [ ] `matchProfile()` 命中 tags
  - [ ] `detectAnomalies()` z-score 偵測
  - [ ] `render()` 板型組裝
- [ ] 寫 5 個 mode 的輸出函式
- [ ] 寫板型片段文字（最花時間的部分）
- [ ] 跑自己的資料看 profile 段落是否合理
- [ ] 調 z-score 門檻
- [ ] 文件：updates events-schema.md 加 profile 欄位描述（如有 `--export json`）

---

## 變更管理

| 版本 | 日期 | 主要變更 |
|---|---|---|
| v1.0 | 2026-05-09 | 設計討論初版（M3 完成階段） |

---

## 關聯文件

- [里程碑計畫](里程碑計畫.md) — M3 / M4 / M7 整體規劃
- [events-schema](events-schema.md) — 各 event type 欄位
- [M3-驗收測試手冊](M3-驗收測試手冊.md) — M3 功能驗收
