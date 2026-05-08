# 設計參考與未來考慮點

> 版本：v1.0
> 確認日期：2026-05-08
> 用途：紀錄業界對話 / 氣泡 UI 的設計範本，標出「現在不做、未來可評估」的點，避免日後忘記。

---

## 0. 為什麼有這份文件

我們調查了視覺小說、遊戲對話系統、桌寵、漫畫、聊天 UI 五大領域後，發現**現有架構已涵蓋核心**，不需要重新設計。但有 5-7 個值得**標記後評估**的點 — 不是現在加，但等「真實使用後發現缺什麼」時可以拿來參考。

---

## 1. 已採用（驗證對齊業界做法）

| 我們的設計 | 業界對應 | 來源 |
|---|---|---|
| type=speech（圓角 + 尾巴向下） | 漫畫標準、Ren'Py bottom_left | [Ren'Py docs](https://www.renpy.org/doc/html/bubble.html) |
| type=thought（雲朵 + 圓點尾巴） | 漫畫 50 年標準、Ren'Py thought | 漫畫業 / Ren'Py |
| type=narration（矩形 + 斜體 + 無尾） | 視覺小說 NVL 模式、Phoenix Wright 旁白 | VN 業界 |
| type=system（icon + 等寬字） | Persona 5、Cyberpunk holocall | 遊戲業 |
| persistence=transient | 大部分聊天/通知 | 通用 |
| persistence=persistent + ✕ 鈕 | Telegram inline keyboard | Telegram Bot API |
| interaction=advance | Ren'Py 標準 | Ren'Py |
| interaction=choice（多按鈕） | Mass Effect、Telegram、Slack | 廣泛 |
| interaction=binary_split（左綠右紅） | Tinder swipe、二元決策 | 廣泛 |

---

## 2. 未來可評估（按優先順序）

> 這些**不是現在加**。等實際使用 2-4 週後，若體感發現對應痛點，再回頭評估。

### 2.1 ⭐ Ren'Py Retain Mode — 多氣泡堆疊

**痛點假設**：使用 pinned 後發現「pinned 卡住、新氣泡無處顯示」很煩。

**做法**：氣泡可標記 `retain=true`，新氣泡來時堆疊不互相覆蓋。需要：
- 多氣泡並存的版面管理（避免重疊）
- `clear_retain_statements` — 在某些情境（如重啟、新對話開始）自動清除
- 配合事件：DND 啟用 → pin 一個小狀態氣泡；DND 解除 → 自動清

**估時**：1.5-2 天（要重新設計版面管理）
**何時做**：M3 後若用過 pinned 覺得「擋路」就考慮

**參考**：[Ren'Py Speech Bubbles - Retain mode](https://www.renpy.org/doc/html/bubble.html)

### 2.2 字體變化（情緒驅動）— Phoenix Wright 風格

**痛點假設**：M5a 後發現「光換表情 + 換氣泡 type 不夠生動，台詞情緒不顯眼」。

**做法**：氣泡內字體本身隨情緒變：
- 害怕 → 顫抖、斜體
- 驚訝 → 粗體、字大
- 困倦 → 字小、淡色
- 生氣 → 加粗、紅邊

**Schema 擴充**：`lines[].emphasis: 'normal'|'shaky'|'shouting'|'tiny'|'angry'`

**估時**：1 天（CSS 動畫 + schema 擴充）
**何時做**：M5a 後、有空時加；不影響功能

### 2.3 ⭐ Choice Label「具體優於模糊」原則 — Mass Effect 教訓

**這個今天就應該記下來**，不需要等 — 影響 M7 prompt 工程。

**規則**：
- ✅ 具體：「休息 5 分鐘」「關掉通知」「打開夜間模式」
- ❌ 模糊：「同意」「拒絕」「Sarcastic」「OK」

**寫進 prompt**：
```
choice 的 label 必須是動作描述（動詞 + 受詞），不是情緒/態度。
範例：✓「喝杯水」 ✗「好」
範例：✓「關掉通知 30 分鐘」 ✗「同意」
若選項僅二元（是/否），考慮用 binary_split 而非 choice。
```

**何時做**：M7 預生成管線開工時直接寫入 prompt 模板。

### 2.4 Disco Elysium 思考暗櫃 — 長期 Thought

**痛點假設**：覺得 thought 氣泡太短暫、沒法表達「角色一直在想某件事」。

**做法**：thought 氣泡可帶 `duration_hours`，於數小時內偶爾以淡色形式重新浮現。需要：
- 跨重啟的 thought 持續性（寫入 data/）
- 視覺：淡入時間長、半透明、低存在感

**估時**：1.5 天
**何時做**：M3 後、覺得角色「個性不夠連貫」時

**參考**：Disco Elysium 思考暗櫃機制

### 2.5 Telegram Inline Keyboard 多行排列

**痛點假設**：M2.5 的 choice 是「縱向一列按鈕」，4-5 個選項時垂直空間吃緊。

**做法**：choices schema 支援二維陣列：
```jsonc
"choices": [
  [{ "label": "好" }, { "label": "不要" }],     // 第一行：二元
  [{ "label": "我看一下再說" }]                   // 第二行：延遲
]
```

**估時**：0.5 天
**何時做**：實際發現選項擠時再加

**參考**：[Telegram Bot API - InlineKeyboardMarkup](https://core.telegram.org/bots/api#inlinekeyboardmarkup)

### 2.6 Mass Effect 圓形對話輪（Dialogue Wheel）

**痛點假設**：發現 4 個選項時直線排列「有上下對立感（接受 vs 拒絕）」需要視覺強化。

**做法**：選項排成圓形，用方位編碼意圖（上=正、下=負、左=查、右=動）。

**估時**：2 天（不簡單；要做圓周布局 + 滑鼠移動偵測）
**何時做**：**通常不建議**，桌寵高頻短互動不適合複雜 UI；除非你某天真的覺得「直線太呆」才考慮

### 2.7 Cyberpunk 全螢幕對話 / 通話

**痛點假設**：覺得小氣泡不夠戲劇化，重要時刻想「全螢幕對話」效果。

**做法**：特定 sequence type=`fullscreen`，整個透明覆蓋區用作對話 UI。

**估時**：1.5 天
**何時做**：通常不建議；桌寵不該打擾。除非「劇情大事件」（如月底重生提示）

---

## 3. 不採用（明確理由）

| 做法 | 為什麼不用 |
|---|---|
| Mass Effect 圓形對話輪 | 需要 gamepad / 學習成本高，桌寵不適合 |
| 拖曳氣泡分支（左拖拒絕、右拖接受） | 與「拖曳角色」手勢衝突 |
| 點擊角色身體部位分支（hit-area） | 靜態圖難做精準 hit-area；Live2D 才適用，且需教學 |
| 點擊速度判定（隱形分支） | 不可預期、易挫折；除非作為**彩蛋**少量使用 |
| 鍵盤快捷鍵選 choice（數字鍵） | 已決定純滑鼠路徑，鍵盤為加分項而非主要 |

---

## 4. 一條重要的「整體啟發」

業界對話 UI 設計的**共通原則**（多個來源驗證）：

> **選項要顯示「會發生什麼」，不要顯示「角色語氣」。**

對應我們：
- ❌「我要溫柔地拒絕」→ 看不出後果
- ❌「Sarcastic」→ 一頭霧水
- ✅「不要，繼續工作」→ 明確
- ✅「休息 5 分鐘」→ 明確

這是 Fallout 4 失敗、Mass Effect / Dragon Age Inquisition 成功的核心差異。**寫進 M7 prompt 規則的優先項**。

---

## 5. 主要參考來源

- [Ren'Py Speech Bubbles](https://www.renpy.org/doc/html/bubble.html) — 最直接相關
- [Ren'Py Dialogue](https://www.renpy.org/doc/html/dialogue.html) — 對話設計
- [In Defense of Dialogue Wheels (Medium)](https://medium.com/@malikwalkerux/in-defense-of-dialogue-wheels-aaf3ea72af08) — Mass Effect 設計分析
- [Mass Effect: How to Indoctrinate Users with UX Consistency](https://medium.com/super-jump/mass-effect-how-to-indoctrinate-users-with-ux-consistency-1aaff84afe68) — UX 一致性研究
- [VPet (LorisYounger)](https://github.com/LorisYounger/VPet) — 桌寵類最相關
- [Telegram Bot API](https://core.telegram.org/bots/api#inlinekeyboardmarkup) — choice 按鈕模式

---

## 6. 何時回來看這份文件

- **M3 完成後**：實際跑 1 週累積使用感受，回來看哪些痛點命中
- **M7 開工前**：抽出 §2.3 寫進 prompt 模板
- **M5a 後**：考慮 §2.2 字體變化
- **任何時候覺得 UI 有不滿時**：先看 §2 對照看有沒有現成方案

不需要主動回來重讀；有問題時當參考即可。
