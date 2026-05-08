# 對話氣泡類型分析

> 版本：v1.0
> 確認日期：2026-05-08
> 對應：M2 已實作 speech + transient + advance；本文件規劃 M2.5 擴充與後續路線

---

## 0. 設計原則

桌寵的「對話氣泡」其實是**多維設計空間**，不是單一形態。把它拆成四個獨立維度後，**任何維度組合都成立**且各有用途。

設計目標：
- **一次設計 schema、分階段實作**（避免日後遷移）
- M2.5 只實作 ~80% 用法，剩 20% 推到 M3 之後
- 對 AI（Stage 1）友善：能用簡單規則教會它何時用哪種

---

## 1. 四個獨立維度

### 維度 1 — 來源（誰/什麼在說？）

| 類型 | 視覺 | 用途 |
|---|---|---|
| **Speech 對話** | 圓角氣泡 + 尾巴指角色 | 角色直接對使用者說 |
| **Thought 想法** | 雲朵形/虛線邊 + 小泡泡尾巴 | 角色內心 OS、看似自言自語 |
| **Narration 旁白** | 矩形/無尾巴/斜體 | 第三方觀察、狀態描述 |
| **System 系統** | 藍色調 + icon + 等寬字 | 程式自身訊息（重生中、設定變更…） |
| **Whisper 低語** | 小字、半透明、無尾巴 | 偷偷碎念，不打擾 |

**運作邏輯差異**：
- **Speech / Thought / Whisper** 是「角色發出的」 → 跟人格綁定，AI 生成
- **Narration / System** 是「程式發出的」 → 與人格無關，由系統觸發

### 維度 2 — 持續性（怎麼關？）

| 類型 | 怎麼關 | 多句行為 | 用途 |
|---|---|---|---|
| **Transient 短暫** | 12 秒自動關 / 點完關 | 點過所有句後自動關閉 | 一般對話（M2 預設） |
| **Persistent 持續** | **只能 ✕ / ESC 關** | **循環顯示**（最後一句點本體 → 回第一句重來） | 循環提醒（喝水、伸懶腰…）、互動式重複 |
| **Sticky 條件解除** | 條件解除才關（如「離開閒置」） | — | 狀態指示 |
| **Pinned 釘選** | **只能 ✕ / ESC 關**；點本體無作用 | 不循環、停在第一句 | 靜態狀態指示器（DND 啟用中…） |

**Persistent vs Pinned 的核心差異**：

| | Persistent | Pinned |
|---|---|---|
| 點本體 | 推進 / 循環 | **無作用** |
| 多句循環 | ✓ | ✗ |
| 視覺 | 一般 | 左上角有 📌 |
| 適合場景 | 想讓使用者反覆看不同提醒 | 想讓使用者意識到某狀態正啟用 |

### 維度 3 — 互動方式（使用者怎麼回應？）

| 類型 | 互動 | 用途 |
|---|---|---|
| **Display 純顯示** | 沒互動，看了就好 | 想法、旁白、系統訊息 |
| **Advance 點擊推進** | 點氣泡推進序列（M2 預設） | 標準對話 |
| **Choice 選項分支** | 2-4 顆按鈕 → 分支 | 「要休息嗎？要 / 不要 / 等等再說」 |
| **Binary Split 二元分區** | 氣泡內左/右兩區，hover 變色，點區即選 | 嚴格二元（是/否、接受/拒絕） |
| **Timed Choice 時間敏感** | 倒數內回應 → 分支；超時也分支 | 快回 / 慢回 / 不回 各自不同台詞 |

#### Choice vs Binary Split 何時用哪個？

| 場景 | 建議 |
|---|---|
| 2-4 個選項、不對立 | Choice（多按鈕） |
| **嚴格二元、語意對立**（同意/拒絕、是/否） | Binary Split（左綠右紅，視覺立即可懂） |
| 選項標籤長 | Choice |
| 選項是 1-3 字短詞 | 任一皆可 |
| 重要決定要慎重 | Choice（按鈕分明，不易誤觸） |
| 高頻日常二元 | Binary Split（節省垂直空間） |

### 維度 4 — 觸發/出現條件

| 類型 | 描述 |
|---|---|
| **Triggered** | 條件命中即觸發（M2 預設） |
| **Scheduled** | 預定時間出現（早安、午餐、月底重生提示） |
| **Conditional** | 條件持續為真期間都顯示（搭配 sticky） |

---

## 2. 實際組合範例

| 組合 | 用法範例 |
|---|---|
| Speech + Transient + Advance | 「凌晨三點了還不睡」 — M2 預設 |
| **Thought + Transient + Display** | 路過浮現「（這人又熬夜了…）」 — 不是對你說，只是給你看到他在想什麼 |
| **Speech + Persistent + Choice** | 「你連續工作 4 小時了，要不要：[休息 5 分鐘] [關掉通知] [不用管我]」 |
| **System + Persistent + Display** | 「正在生成新台詞庫… 67%」直到完成才消失 |
| **Speech + Sticky + Display** | 「請勿打擾模式啟用中（09:00–18:00）」時段內持續顯示 |
| **Speech + Transient + Timed Choice** | 「快回答！3 秒內」+ 倒數條 → 快回 / 慢回 / 不回 各自不同台詞 |
| **Whisper + Transient + Display** | 「（小聲）你電量剩 18% 了喔」 |
| Narration + Transient + Display | 「使用者已連續工作 5 小時」客觀觀察 |

---

## 3. 統一 Schema 設計

新欄位都有預設值，**舊資料不需遷移**：

```jsonc
{
  "id": "long_idle_001",
  "type": "speech",              // speech | thought | narration | system | whisper
  "persistence": "transient",    // transient | persistent | sticky | pinned
  "interaction": "advance",      // display | advance | choice | timed_choice
  "lines": [
    { "text": "你發呆多久了", "expression": "annoyed" }
  ],

  // 持續性參數
  "auto_close_ms": 12000,        // null/0 = 不自動關（用於 persistent）
  "until": { "type": "idle_ends" },  // for sticky；條件解除即關閉

  // 互動參數
  "choices": [                   // for choice / timed_choice
    { "label": "我休息一下", "next": "rest_path", "action": null },
    { "label": "別管我",     "next": "ignored_path" }
  ],
  "time_branches": [             // for timed_choice
    { "max_response_ms": 2000,  "next": "fast_response" },
    { "max_response_ms": 10000, "next": "normal_response" },
    { "max_response_ms": null,  "next": "no_response" }   // 超時
  ],

  "expression": "annoyed",
  "motion": "tilt_head"
}
```

**預設值規則**：
- 未指定 `type` → `speech`
- 未指定 `persistence` → `transient`
- 未指定 `interaction` → `advance`
- 未指定 `auto_close_ms`：transient → 12000；其餘 → null

**驗證規則**：
- `interaction: 'choice' | 'timed_choice'` 必須有 `choices` 或 `time_branches`
- `persistence: 'sticky'` 必須有 `until`
- `persistence: 'pinned'` 必須有手動關閉路徑（UI 上會出現 ✕ 鈕）
- `next` 引用的 sequence ID 必須在同一 dialogues.json 內存在

---

## 4. 實作複雜度

| 類型 | 視覺改 | 邏輯改 | 工日 | 何時做 |
|---|---|---|---|---|
| Thought 視覺 | ✓ | — | 0.3 | M2.5 |
| Narration 視覺 | ✓ | — | 0.3 | M2.5 |
| System 視覺 | ✓ | — | 0.3 | M2.5 |
| Whisper 視覺 | ✓ | — | 0.2 | M2.5（可選） |
| Persistent（不自動關） | — | 小 | 0.2 | M2.5 |
| Pinned | — | 小 | 0.3 | M2.5 |
| Choice 多按鈕 | ✓ | 中 | 1.0 | M2.5 |
| Sticky + until 條件 | — | 中 | 1.0 | M3 之後（依賴 trigger engine） |
| Timed Choice + 倒數視覺 | ✓ | 高 | 1.5 | M3 之後 |
| 分支跳轉（next 鏈） | — | 高 | 1.0 | M2.5 + M3 整合 |

---

## 5. 已採路線：Path A（2026-05-08 確認）

### M2.5 範圍（含 B1，~2 天）

**新增類型**：
- type: speech / thought / narration / system / whisper
- persistence: transient（既有）/ persistent / pinned
- interaction: display / advance（既有）/ choice / **binary_split**

**M2.5 不做**（推到 M3 後）：
- Sticky（依賴 trigger engine 的條件追蹤）
- Timed Choice（高互動複雜度）
- Schedule trigger（可在 M3 後一起做）
- Inline 詞點擊（待評估，與 M7 prompt 工程一起設計）
- 速度判定（待評估，與 timed_choice 一起設計）

### 視覺規格（M2.5 實作目標）

| 類型 | 背景 | 邊框 | 尾巴 | 字型 | 字色 |
|---|---|---|---|---|---|
| Speech | rgba(28,32,48,.92) | 藍紫色實線 | 三角向下 | 系統字 | 白 |
| Thought | rgba(48,48,56,.85) | 灰色虛線 | 三個小圓點漸縮 | 系統字 | 淡灰 |
| Narration | rgba(20,20,20,.78) | 暗金色細線 | 無 | **斜體** | 米白 |
| System | rgba(40,80,140,.92) | 亮藍實線 | 無 | 等寬字 + ⚙ icon | 亮白 |
| Whisper | rgba(28,32,48,.55) | 淡邊 | 無 | 小一級字 | 淡白 |

### Schema 部分啟用

```jsonc
// M2.5 階段，schema 完整存在但只實作部分行為
{
  "type": "thought",            // ✓ 完全支援
  "persistence": "persistent",  // ✓ 完全支援
  "interaction": "choice",      // ✓ 完全支援
  "choices": [...],             // ✓ 完全支援

  // 或：
  "interaction": "binary_split", // ✓ 完全支援
  "binary": {                   // ✓ 完全支援
    "left":  { "label": "好啊", "next": "..." },
    "right": { "label": "不要", "next": null }
  },

  // M2.5 階段這些欄位「可寫但暫不啟用」
  "until": {...},               // ⏳ M3 後啟用
  "time_branches": [...]        // ⏳ M3 後啟用
}
```

---

## 6. AI Prompt 影響（M7 才會接到）

新類型對 Stage 1 prompt 工程的影響：要教 AI **何時用哪種**，否則它會全部都用 speech。

範例 prompt 補強：

```
你撰寫的台詞要在三種類型中選擇恰當的：
- speech：直接對使用者說的話。對話佔多數時用。
- thought：角色的內心想法，使用者只是「看到」而非「被說」。
  用在角色覺得無奈、好笑、無聊但又不想直接說的場合。
- system：app 自身告知（重生中、設定變更等）。極少用，由系統觸發。

每組分類至少 70% speech，10-20% thought，0-10% system。
```

對 choice 類的補強：

```
某些情境（連續使用太久、深夜、閒置長時間）適合給使用者選項而非單向說教。
這種時候用 interaction: "choice" + 2-3 個 choices。
選項要有「順從」「拒絕」「閃避」三種傾向，而不是單一引導。
```

---

## 7. UI/UX 細節（M2.5 實作時要決定）

### 7.1 Choice 按鈕 UI

```
┌─────────────────────────────┐
│ 你連續工作 4 小時了，要不要：│
│                             │
│  ▶                          │
└──┬──────────────────────────┘
   │
┌──┴──────────────────────────┐
│ [ 休息 5 分鐘 ]             │
│ [ 關掉通知    ]             │
│ [ 不用管我    ]             │
└─────────────────────────────┘
```

選項按鈕在氣泡下方，視覺一致但獨立。Hover 高亮。鍵盤操作（1/2/3 數字鍵）為加分項。

### 7.2 Persistent 氣泡的關閉

Persistent 沒自動關，需明顯關閉路徑：
- 右上角 ✕ 小鈕
- 或 ESC 鍵
- 或 tray 選單「關閉所有氣泡」

### 7.3 Choice 選後

選 → 立刻關閉氣泡 → 觸發 `next` 對應 sequence（M2.5 階段先簡化為「直接展示同 dialogues.json 內的 next sequence」，M3 後再考慮跨類別跳轉）

---

## 8. 待決事項

| 項目 | 何時前要定 |
|---|---|
| Whisper 是否做（vs 跳過） | M2.5 開工前 |
| Choice 是否支援鍵盤快捷鍵（數字鍵） | M2.5 開工前 |
| Persistent 氣泡的關閉鈕視覺 | M2.5 開工前 |
| AI 各類型佔比參考值 | M7 前（接 prompt 工程時） |

---

## 9. 關聯文件

- [REQUIREMENTS.md](REQUIREMENTS.md) §8 對話氣泡 — 主需求（M2 為現狀，M2.5 補充見此）
- [SPECIFICATION.md](SPECIFICATION.md) §2.3 dialogues.json — schema 細節
- [MILESTONES.md](MILESTONES.md) M2.5 — 實作交付
