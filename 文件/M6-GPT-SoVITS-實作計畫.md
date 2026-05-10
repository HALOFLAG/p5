# M6 — GPT-SoVITS 實作計畫

> p5 桌寵 voice-clone 語音整合的完整 step-by-step 指引。
> 實作前準備 + 用戶端 setup + Node 端開發路徑 + 維運注意事項。
>
> **狀態**：已評估，等待啟動（2026-05-10）

---

## 📋 目錄

- [§0 前置確認](#0-前置確認)
- [§1 GPT-SoVITS 環境 setup](#1-gpt-sovits-環境-setup)
- [§2 Reference audio 蒐集](#2-reference-audio-蒐集)
- [§3 WebUI 試生驗證](#3-webui-試生驗證)
- [§4 API mode 啟動](#4-api-mode-啟動)
- [§5 Node 端開發](#5-node-端開發)
- [§6 批次跑 330 句](#6-批次跑-330-句)
- [§7 風險與應對](#7-風險與應對)
- [§8 後續維護](#8-後續維護)
- [§9 驗收測試](#9-驗收測試)
- [§10 進階：fine-tune 模式](#10-進階fine-tune-模式)

---

## §0 前置確認

| 項目 | 狀態 | 備註 |
|---|---|---|
| OS | ✅ Windows 11 | 已確認 |
| GPU | ✅ NVIDIA RTX 5070 Ti（16GB VRAM）| 規格大幅超過需求 |
| Python | ⚠ 待裝 | **Python 3.10.11 specifically**（3.11 也行；3.12+ / 3.13+ / 3.14+ 太新，PyTorch / numpy 的 wheel 還沒齊全會踩坑）|
| CUDA Toolkit | ⚠ 待確認 | 12.1+ 對應 PyTorch 2.x |
| Git | ⚠ 待裝 | https://git-scm.com |
| 磁碟空間 | ⚠ 約 20 GB | repo + model + 環境 |
| 網路 | ⚠ 第一次下載需要 | 後續離線可用 |

### 前置軟體安裝順序
1. **Python 3.10.11**：[python.org/downloads/release/python-31011/](https://www.python.org/downloads/release/python-31011/) → Windows installer (64-bit)
   - 已有更新版 Python（3.11+ / 3.12+ / 3.14+）：**不要砍**，並存即可
   - 安裝時 **不要勾** "Add to PATH"（保留你既有 default Python）
   - 之後用 `py -3.10` 或絕對路徑呼叫
2. **Git**：[git-scm.com](https://git-scm.com/download/win)
3. **CUDA Toolkit**：⚠ **不必另外裝**！PyTorch 的 cu121 wheel 自帶 runtime；NVIDIA driver 591+ 已 forward-compat CUDA 12.x
4. **驗證**：
   ```powershell
   py -3.10 --version       # → Python 3.10.11（如果裝了）
   python --version         # → 你既有版本（任何都 OK）
   git --version            # → git version 2.x
   nvidia-smi               # → 列出 GPU + Driver 版本
   ```

### CUDA Driver vs CUDA Toolkit（常被搞混）
- **Driver**：`nvidia-smi` 顯示的 `CUDA Version: 13.1` 是 driver 支援的「最大」版本，**不代表 toolkit 已裝**
- **Toolkit**：PyTorch wheel 自帶必要 runtime（如 cu121 = bundled CUDA 12.1）
- **結論**：你 driver 591+ 就直接 `pip install torch ... --index-url cu121`，不必另外 install CUDA Toolkit

---

## §1 GPT-SoVITS 環境 setup

### 1.1 Clone repo
```powershell
# 在你想放專案的資料夾下（例如 D:\tools\）
cd D:\tools
git clone https://github.com/RVC-Boss/GPT-SoVITS.git
cd GPT-SoVITS

# 鎖定 release 版本（避免 main 分支不穩）
# 撰寫此計畫時最新穩定 tag 為 v2，未來可調整
git checkout tags/20240821v2 -b stable-v2
```

### 1.2 建立 Python 虛擬環境（用 Python 3.10）
```powershell
# 用 py launcher 指定 3.10（即使系統 default 是 3.14 也沒影響）
py -3.10 -m venv .venv
.\.venv\Scripts\Activate.ps1
# PowerShell 第一次跑可能要：Set-ExecutionPolicy -Scope CurrentUser RemoteSigned

# 驗證 venv 內的 python 是 3.10
python --version
# → Python 3.10.11
```

### 1.3 安裝 PyTorch（Blackwell sm_120 / sm_100 / sm_103 系列）
```powershell
# 升級 pip / setuptools / wheel
python -m pip install --upgrade pip setuptools wheel
```

⚠ Blackwell 架構（RTX 50xx 系列、Tesla B100/B200）的 PyTorch 支援演進：
- PyTorch 2.4 + cu121：sm_50–sm_90，**不支援 Blackwell**
- PyTorch 2.6 + cu124：sm_50–sm_90，**還是不支援 Blackwell**
- PyTorch 2.7+ with cu128：✅ 包含 sm_120

**RTX 50xx 系列必須用 cu128 wheel（torch 2.7+）**：

```powershell
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128
```

如 cu128 stable 還沒有對應 Python 版本的 wheel，**改用 nightly**（PyTorch nightly 對 Blackwell 支援完整且穩定，桌寵 inference 用沒問題）：

```powershell
pip install --pre torch torchvision torchaudio --index-url https://download.pytorch.org/whl/nightly/cu128
```

### 完整驗證（必跑！）
```powershell
python -c "import torch; print('CUDA:', torch.cuda.is_available()); print('Device:', torch.cuda.get_device_name(0)); print('Torch ver:', torch.__version__); print('Compute cap:', torch.cuda.get_device_capability(0)); a = torch.tensor([1.0,2.0,3.0]).cuda(); print('GPU op test:', a.sum().item())"
```

預期（**無 sm_120 not compatible 警告**）：
```
CUDA: True
Device: NVIDIA GeForce RTX 5070 Ti
Torch ver: 2.7.0+cu128  (或 2.8.x dev)
Compute cap: (12, 0)        ← Blackwell sm_120
GPU op test: 6.0            ← 實際 GPU 算過才算數
```

如還出 `sm_120 is not compatible` 警告：
1. 確認 `pip uninstall -y torch torchvision torchaudio` 完整移除
2. 確認 `--index-url cu128` 而非 cu121 / cu124
3. 仍不行 → 用 nightly build `--pre ... cu128`

### 1.4 安裝其他依賴
```powershell
pip install -r requirements.txt
# 若有 ffmpeg / librosa 等依賴錯誤，個別補裝
```

### 1.5 下載 pretrained models
GPT-SoVITS 啟動時會自動檢查 `GPT_SoVITS/pretrained_models/` 內的模型檔案。需要下載：

| 檔案 | 大小 | 來源 |
|---|---|---|
| s1bert25hz...ckpt | ~700MB | huggingface.co/lj1995/GPT-SoVITS |
| s2D488k.pth | ~50MB | 同上 |
| s2G488k.pth | ~80MB | 同上 |
| chinese-hubert-base | ~360MB | 同上 |
| chinese-roberta-wwm-ext-large | ~1.3GB | huggingface.co/hfl/chinese-roberta-wwm-ext-large |

```powershell
# 用 huggingface-cli 一次拉完
pip install -U "huggingface_hub[cli]"
huggingface-cli download lj1995/GPT-SoVITS --local-dir GPT_SoVITS/pretrained_models
```

或手動：去 huggingface 對應 repo 下載再放對位置（看 GPT-SoVITS README）。

### 1.6 第一次啟動 WebUI
```powershell
python webui.py
```
瀏覽器開 http://127.0.0.1:9874 → 看到 GPT-SoVITS WebUI。

### 1.7 第一次測試（不需 ref audio）
WebUI → 「1-GPT-SoVITS-TTS」分頁 → 用內建 demo voice → 輸入「你好世界」→ 點「合成語音」→ 應該聽到一句中文語音。

✅ **跑通這步代表環境 OK，可以進 §2**。

---

## §2 Reference audio 蒐集

### 2.1 規格要求

| 項目 | 規格 |
|---|---|
| 格式 | WAV / mp3 / flac / ogg 都行（librosa 自動解碼）。WAV 最保險；高 bitrate mp3 (256kbps+) 跟 wav 沒差 |
| Sample rate | 任意（GPT-SoVITS 內部會 resample）；偏好 ≥ 16000Hz |
| 聲道 | 單聲道最佳；立體聲可（會被自動 downmix）|
| 長度 | 5-30 秒（zero-shot），最佳 8-15 秒 |
| 內容 | 單人講話、無 BGM、無回音、正常語速 |
| 文字稿 | 必須有對應的逐字稿（給 ref_text）|
| 情緒 | 跟 persona 主要情緒一致（不要哭腔 / 笑聲過重）|

**bitrate 警告**：< 128kbps 的 mp3（YouTube 下載常見）壓縮過頭，音色細節會掉，建議找更好品質。

### 2.2 來源選項對照

| 來源 | 風險 | 取得難度 | 適合 |
|---|---|---|---|
| **動畫 / Galgame VA 樣本** | 灰色（自用 OK，公開不行）| 🟡 要剪輯 | 找心目中海音 / 莉絲音色 |
| **AISHELL / OpenSLR 開源 dataset** | ✅ 零風險 | 🟢 直接下載 | 中文 dataset，但偏新聞腔 |
| **CommonVoice (zh-TW / zh-CN)** | ✅ 零風險 | 🟢 直接下載 | 自然口語但音色雜 |
| **VOICEVOX 樣本** | ⚠ 日語為主 | 🟢 內建 | 想做日文 voice 時用 |
| **自己錄音** | ✅ 零風險 | 🔴 要設備 + 變聲 | 想做出獨特音色時 |

### 2.3 海音 ref audio 蒐集策略

**目標音色**：17 歲日本病嬌少女、甜美外表 + 內藏佔有感、紫黑長髮 + 雙馬尾形象。

**找這類聲線**：
- 偏蘿莉聲、年齡感 17-22 歲
- 帶撒嬌或佔有感的句子
- **避開**：純「kawaii」高音調（會變蠢萌不對味）/ 純哭腔 / 帶刀殺意

**搜尋關鍵字（網路找 voice sample）**：
- 「ヤンデレ ボイス サンプル」（日文：病嬌音色樣本）
- 「中文 yandere voice」
- VTuber clip 中夾帶撒嬌語氣的片段
- 同人 voice sample 站

**剪輯成 ref audio**：
- 取一句完整、自然的對白（不是「啊～」這種短嘆息）
- 例：「呐～你今天怎麼這麼晚才回來呢？」（10 秒）
- ref_text 寫：「呐～你今天怎麼這麼晚才回來呢？」（**逐字相符**）

### 2.4 莉絲 ref audio 蒐集策略

**目標音色**：22 歲溫柔女僕、黑長髮 + 蝴蝶結、結尾常帶「最愛的主人♡」+ 顏文字感。

**找這類聲線**：
- 溫柔成熟女性聲線（22-28 歲感）
- 帶服侍 / 關懷語氣
- 中文台灣腔最佳（莉絲說中文）

**搜尋關鍵字**：
- 「メイド ボイス サンプル」（日文：女僕音色樣本）
- 「溫柔 女聲 樣本」
- 「voice acting maid character」

**剪輯成 ref audio**：
- 例：「主人您回來了～莉絲為您準備了熱茶，要喝嗎？」（12 秒）
- ref_text 寫：「主人您回來了～莉絲為您準備了熱茶，要喝嗎？」

### 2.5 後製剪輯流程

工具：**Audacity**（免費，[audacityteam.org](https://www.audacityteam.org/)）

步驟：
1. 匯入原始音檔（mp4 / mp3 / wav 都可）
2. 選取目標 5-30 秒區段 → 「Edit > Copy」
3. 開新檔，貼上
4. 「Tracks > Resample」改成 16000Hz 或 22050Hz
5. 「Tracks > Mix > Mix Stereo Down to Mono」轉單聲道
6. （可選）「Effect > Noise Reduction」降噪
7. 「File > Export > Export as WAV」存成 PCM 16-bit
8. 命名：`haiyin-ref.wav` / `liss-ref.wav`
9. 對應的 ref_text 寫進 `voice-refs/haiyin-ref.txt` / `liss-ref.txt`（逐字稿）

放置：
```
專案根目錄/voice-refs/
├── haiyin-ref.wav
├── haiyin-ref.txt    （內容：「呐～你今天怎麼這麼晚才回來呢？」）
├── liss-ref.wav
└── liss-ref.txt      （內容：「主人您回來了～莉絲為您準備了熱茶，要喝嗎？」）
```

⚠ **`.gitignore` 加 `voice-refs/`** 避免不小心 push 到 GitHub。

---

## §3 WebUI 試生驗證

啟動 WebUI（`python webui.py`）→ 「1-GPT-SoVITS-TTS」分頁。

### 3.1 上傳 ref audio
- 「請上傳3~10秒內參考音頻」→ 上傳 `haiyin-ref.wav`
- 「請填寫參考文本」→ 貼上對應 ref_text
- 「參考文本語種」→ 中文

### 3.2 輸入要合成的句子
從 `personas/haiyin/dialogues.json` 抽 5 句測：
```
呐⋯⋯點得這麼急做什麼？
我等了你好久呢
你回來了！
都這個時間了⋯⋯還醒著？
誒誒～要帶我去哪？
```
語種選「中文」→ 點「合成語音」

### 3.3 評估標準

| 指標 | OK | NG → 處置 |
|---|---|---|
| 音色相似度 | 聽起來像同一個人 | NG → 換 ref audio |
| 中文發音 | 字正腔圓無怪音 | NG → ref audio 太短或品質差 |
| 情緒帶入 | 病嬌 / 撒嬌感能聽出來 | 一般 → 換更有感情的 ref audio |
| 跨句一致 | 5 句聽起來都同一人 | 飄 → 接受 zero-shot 限制，或進 fine-tune |
| 長句處理 | 30+ 字句不斷掉 | 斷掉 → 預先分段（句號處切）|

### 3.4 莉絲也跑同樣流程
換上 `liss-ref.wav`，試生：
```
請慢一點點，主人～
莉絲擔心您手累了，最愛的主人♡
都這個時間了⋯⋯莉絲幫您鋪好被子了
```

兩 persona 都過關 → 進 §4。

---

## §4 API mode 啟動

WebUI 是給人測試用的，批次處理要用 API mode。

### 4.1 啟動 API server
```powershell
# GPT-SoVITS 根目錄
.\.venv\Scripts\Activate.ps1
python api.py -dr "voice-refs/haiyin-ref.wav" -dt "呐～你今天怎麼這麼晚才回來呢？" -dl "zh"
```

預設 port 9880，改 port 加 `-p 9880`。

⚠ **重要**：`-dr` / `-dt` 是「預設」ref audio。批次 API 也可以每次 request 換 ref，所以這裡填海音的就行（每次調用時改 persona）。

### 4.2 endpoint 規格

GPT-SoVITS API 主要 endpoint：

```
POST http://127.0.0.1:9880/

Body (JSON):
{
  "refer_wav_path": "voice-refs/liss-ref.wav",
  "prompt_text": "主人您回來了～莉絲為您準備了熱茶，要喝嗎？",
  "prompt_language": "zh",
  "text": "呐～點得這麼急做什麼？",
  "text_language": "zh"
}

Response: audio/wav binary
```

### 4.3 curl 測試
```powershell
curl -X POST http://127.0.0.1:9880/ `
  -H "Content-Type: application/json" `
  -d '{
    "refer_wav_path": "voice-refs/haiyin-ref.wav",
    "prompt_text": "呐～你今天怎麼這麼晚才回來呢？",
    "prompt_language": "zh",
    "text": "誒誒～要帶我去哪？",
    "text_language": "zh"
  }' `
  -o test.wav

# 用 PowerShell 內建播放器試聽
Start-Process test.wav
```

✅ 聽到合成的「誒誒～要帶我去哪？」用海音音色 → API mode OK，可進 §5。

---

## §5 Node 端開發

**這部分由我（Claude）寫**，使用者只需要 §1-4 跑通 API mode 即可。

### 5.1 模組架構

```
src/main/voice-pipeline/
├── tts-engine.js              抽象介面：buildAudio({text, persona, lang}) → file path
├── gpt-sovits-engine.js       HTTP client → http://127.0.0.1:9880
├── batch-runner.js            佇列 + concurrency=2 + retry + progress IPC
└── voice-manifest.js          hash(text + voice) → mp3 path
```

### 5.2 IPC channels（M6 新增）

| Channel | 方向 | Payload | 用途 |
|---|---|---|---|
| `voice:check-engine` | renderer → main | — | 檢查 GPT-SoVITS API 是否在線 |
| `voice:generate-batch` | renderer → main | `{persona, mode}` | 批次跑（mode: `missing` / `all`） |
| `voice:progress` | main → renderer | `{done, total, current_id, error?}` | UI 進度條 |
| `voice:play` | main → renderer | `{file_path}` | 播放單一 mp3（DialogueDirector 觸發）|
| `voice:cancel` | renderer → main | — | 取消正在跑的批次 |
| `voice:get-config` | renderer → main | — | 讀 voice-config.json |
| `voice:set-config` | renderer → main | `{voices: {...}}` | 寫 voice-config.json |

### 5.3 對話庫管理視窗 Tab 5「🔊 語音生成」

```
┌─ Tab 5: 🔊 語音生成 ───────────────────────────────┐
│                                                    │
│ TTS 引擎：[GPT-SoVITS ▼]   狀態：● Online          │
│                                                    │
│ ── Persona 設定 ──                                 │
│ ┌──────────────────────────────────────────────┐  │
│ │ haiyin (千春海音)                              │  │
│ │   Ref audio: voice-refs/haiyin-ref.wav  [⋯]   │  │
│ │   Ref text:  呐～你今天怎麼這麼晚才回來呢？      │  │
│ │   語言:      [中文 zh ▼]                       │  │
│ │   [試聽] [儲存]                                 │  │
│ ├──────────────────────────────────────────────┤  │
│ │ liss (莉茉黛拉絲)                              │  │
│ │   ...                                          │  │
│ └──────────────────────────────────────────────┘  │
│                                                    │
│ ── 批次生成 ──                                     │
│ 範圍：[● 全部缺失]  [○ 重生全部]                    │
│ 預估：haiyin 165 句缺失 / liss 165 句缺失          │
│ [生成全部缺失]  [取消]                              │
│                                                    │
│ 進度：████████████░░░░░  120/330 (36%)             │
│ 當前：haiyin_idle_017_0 ...                        │
│ 已生時間：4:32 / 預估剩餘：8:05                     │
│                                                    │
│ ── Manifest 統計 ──                                │
│ haiyin: 已生 0/165 (0%)                            │
│ liss:   已生 0/165 (0%)                            │
└────────────────────────────────────────────────────┘
```

### 5.4 DialogueDirector 整合

```js
// src/main/dialogue-director.js handleFire 結尾加：
async _maybePlayVoice(personaId, sequenceId, lineIdx) {
  if (!this._voiceManifest) return;
  const file = await this._voiceManifest.lookup(personaId, sequenceId, lineIdx);
  if (file && this._sender) {
    this._sender('voice:play', { file_path: file });
  }
}
```

### 5.5 Phase P1-P5 開發順序（總 2.5 工日）

| Phase | 任務 | 工日 |
|---|---|---|
| **P1** | tts-engine.js 抽象 + gpt-sovits-engine.js HTTP client | 0.5 |
| **P2** | batch-runner.js（佇列 / concurrency / retry / progress IPC）| 0.4 |
| **P3** | voice-manifest.js（hash 比對 / 讀寫 manifest.json）| 0.3 |
| **P4** | Tab 5 UI（HTML / JS / IPC wiring / 進度條）| 0.8 |
| **P5** | DialogueDirector 整合 + renderer audio 播放 + smoke test | 0.5 |

---

## §6 批次跑 330 句

### 6.1 預估時間

| 場景 | 時間 |
|---|---|
| RTX 5070 Ti（你的）| 每句 ~2-3 秒，並發 2 → 330 句約 8-12 分鐘 |
| RTX 3060 | 每句 ~3-5 秒 → 330 句約 15-25 分鐘 |
| CPU only（不建議）| 30-60 秒/句 → 3-5 小時 |

### 6.2 進度監控
- UI Tab 5 進度條
- console.log 每 10 句一筆紀錄
- manifest.json 每生 1 句立刻寫，中斷可接續

### 6.3 失敗處理
- 單句失敗 retry 2 次
- 連續 5 句失敗 → 暫停批次、彈出 error
- API server 掛掉 → 顯示「請重啟 GPT-SoVITS」+ 提供「重連」按鈕

---

## §7 風險與應對

### 7.1 setup 階段常見錯誤

| 錯誤 | 原因 | 解法 |
|---|---|---|
| `torch.cuda.is_available() = False` | CUDA / PyTorch 版本對不上 | 重灌 PyTorch 對應 CUDA 版本 |
| `pip install` 卡某依賴 | Windows 編譯問題 | 找 .whl 預編譯版本 |
| `huggingface-cli` 慢/失敗 | 網路或 mirror 問題 | 用 `HF_ENDPOINT=https://hf-mirror.com` 切鏡像 |
| WebUI 啟動但模型 load 失敗 | pretrained_models/ 路徑錯 | 對照 GPT-SoVITS README 結構放對位置 |

### 7.2 Audio 品質不滿意

| 現象 | 處置 |
|---|---|
| 音色不像 ref | 換更代表性 ref audio（避開低音量段、靜音段）|
| 跨句飄音色 | zero-shot 限制；接受或進 fine-tune（§10）|
| 中文發音怪 | ref audio 太短或品質差；換成 8-15 秒清楚音 |
| 情緒平淡 | ref audio 帶更多情緒；或在 text 裡加標點 |
| 長句斷掉 | 預先按句號 / 逗號切段送 |

### 7.3 API server 不穩
- 啟動 batch 前先 `voice:check-engine` ping 一次
- batch 中每 30 秒 check 一次
- 中斷時顯示明確錯誤 + 「重連」按鈕

### 7.4 ⚠ api.py 對 inp_refs 字串路徑不相容（2026-05-10 已知 bug）

**症狀**：API server log 出 `ERROR: 'str' object has no attribute 'name'` × N（N = inp_refs 數量），合成仍 200 OK 但 inp_refs 被吞掉、退回單 ref 模式。

**原因**：api.py line 897 寫 `path.name`，預期 Gradio File 物件，但 HTTP API 送的是字串路徑。

**修法**：在 GPT-SoVITS 本機 repo 修補 api.py：

```python
# api.py line 894-902 區塊
if inp_refs:
    for path in inp_refs:
        try:
            # 兼容 Gradio File 物件（有 .name）跟純字串路徑（API 模式）
            path_str = path.name if hasattr(path, "name") else path
            refer, audio_tensor = get_spepc(hps, path_str, dtype, device, is_v2pro)
            refers.append(refer)
            if is_v2pro:
                sv_emb.append(sv_cn_model.compute_embedding3(audio_tensor))
        except Exception as e:
            logger.error(e)
```

修改後重啟 api.py 才生效。

**注意**：之後 `git pull` GPT-SoVITS 可能覆蓋此 patch。維護方式建議：
- 把這個 patch 存成 `.patch` 檔，pull 後自動 apply
- 或建立 fork 維護自己的 api.py

---

## §8 後續維護

### 8.1 dialogues.json 變動時
- 對話庫管理 Tab 2 匯入新句後 → Tab 5「生成全部缺失」一鍵補
- manifest.json 用 `hash(text + ref_audio_path)` 當 key，新文字自動視為缺失

### 8.2 voice-config 變動時
- 換 ref audio → 該 persona 全部 mp3 hash 失效 → 顯示「換了 ref，需重生 165 句」確認對話框
- 不想全部重生 → 提供「只重生新加的」選項

### 8.3 清理舊 mp3
- Tab 5 加「清理」按鈕：刪 manifest 沒記錄的孤兒 mp3
- 或刪整個 `personas/<id>/voices/zh/` 重新跑

### 8.4 .gitignore 規則
```
voice-refs/                  # ref audio + 文字稿（自用，不 commit）
personas/*/voices/*.mp3      # 大量 mp3，不 commit
personas/*/voices/manifest.json  # 已記錄在 voice-config，不 commit
```

---

## §9 驗收測試

| # | 測試 | 通過標準 |
|---|---|---|
| T6.1 | API mode 連線 | Tab 5 顯示「● Online」|
| T6.2 | 批次生成 | 點「生成全部缺失」→ voices/zh/ 出現 ~330 mp3 |
| T6.3 | 增量 | 第二次跑，已存在不重跑 |
| T6.4 | 對話有語音 | 觸發對話 → 文字 + 語音同步 |
| T6.5 | 兩 persona 音色不同 | 切 haiyin → liss 音色明顯不同（盲聽可分）|
| T6.6 | API 中斷韌性 | 模擬 server 掛 → batch 暫停 → 重啟接續 |
| T6.7 | 打斷 | 對話 A 播一半時 B 觸發 → A 立即停 |
| T6.8 | 音量控制 | settings.volume = 0.3 → 音量明顯較小 |

---

## §10 進階：fine-tune 模式

zero-shot 不夠穩時的升級路線。

### 10.1 何時考慮
- zero-shot 跨句飄音色嚴重
- 想要某 persona 音色更穩固
- 找到 1+ 分鐘的高品質 voice clip

### 10.2 流程概要
1. 蒐集 1-5 分鐘該角色乾淨對白 + 逐句文字稿
2. WebUI「2-訓練」分頁 → 上傳資料 → 訓 30-60 分鐘（GPU）
3. 訓出 `.ckpt` 模型檔
4. API 載入 `.ckpt` 取代 ref audio mode
5. 之後生成更穩

### 10.3 工日估算
- 蒐集資料：2-4 小時
- 訓練：30-60 分鐘
- 驗證 + 微調：1-2 小時
- 合計：**多 0.5-1 天**（M6 既有計畫之外）

---

## §11 多語支援擴充（M6-multilang，待 M6 主線跑通後啟動）

### 11.1 動機與時機

GPT-SoVITS 原生支援中、日、英、粵、韓多語 + cross-lingual voice cloning（同 ref 念不同語言）。
但啟動多語會增加 schema 複雜度 + 翻譯人工 review 成本，**M6 主線先做中文版**，跑通後再決定要不要進多語。

**啟動條件**（建議全部達成再啟動）：
- M6 中文語音生成完成、實際使用 1-2 週
- 確認需要日文版（例：想嘗試海音原設定的「日本東京學生」感覺、或想 cosplay 異國服侍場景）
- 願意投入 ~1-2 工日 review 翻譯結果

### 11.2 GPT-SoVITS 多語能力對照

| 場景 | 是否可行 | 結果自然度 |
|---|---|---|
| 中文 ref → 念中文 | ✅ | 100% |
| 中文 ref → 念日文 | ✅ cross-lingual | 80%（有微微中文腔）|
| **日文 ref → 念日文** | ✅ 推薦 | 100% |
| 日文 ref → 念中文 | ✅ cross-lingual | 80%（有微微日文腔）|

實務做法：**每 persona 準備兩份 ref audio**（zh + ja），切語言時切 ref。

### 11.3 三條翻譯路線

| 路線 | 工具 | 優點 | 缺點 | 評估 |
|---|---|---|---|---|
| **A. Gemma 4（推薦）** | LM Studio + 既有 Gemma | 免費、本地、能塞 persona context 保留語氣 | 要人工 review、偶爾跳針 | ⭐ 採用 |
| B. DeepL / Google API | 雲端 | 翻譯品質頂級 | 要 API key + 錢 + 上雲 | ❌ 排除（離線偏好）|
| C. M2M-100 / NLLB | 本地翻譯模型 | 純離線 | 不懂角色語氣、要再裝 Python | ❌ 弱於 A |

### 11.4 dialogues schema 擴充

兩種設計方案：

**方案 A：同檔多語（推薦）**
```jsonc
{
  "lines": [
    {
      "text": {
        "zh": "點什麼點呐～",
        "ja": "なんでそんなにクリックしてるの～"
      },
      "expression": "pout"
    }
  ]
}
```
優點：一份檔看到全部翻譯、好維護
缺點：DialogueDirector 要處理 lines.text 從 string 變成 object 的相容性

**方案 B：分檔（dialogues-zh.json / dialogues-ja.json）**
優點：schema 簡單、director 載入直接
缺點：兩檔要同步、加新句要兩邊都更新

**選擇**：採方案 A（多語 object），因為對話庫管理視窗可一次顯示「中文 / 日文」兩欄方便對照 review。

### 11.5 新增功能清單

#### 後端
- [ ] dialogues.json schema 擴充支援 `lines[].text` 為 string 或 `{lang: text}` object
- [ ] DialogueDirector 載入時依 settings.dialogue_language 抽對應 text
- [ ] 變數插值層相容多語結構
- [ ] dialogues-merger.js 處理多語 schema（merge 時決定填到哪個 lang）

#### 設定
- [ ] 設定視窗加「對話語言」dropdown（zh / ja）
- [ ] settings:set 切語言時 invalidate director cache + dismiss 既有氣泡

#### 對話庫管理
- [ ] Tab 1 瀏覽：列表多顯示一欄「日文版」（沒翻譯顯示 "—"）
- [ ] 編輯區：text 欄位變成兩欄（zh / ja 並列）
- [ ] 新 Tab 6「🌐 翻譯」：
  - persona / source language / target language 選擇
  - 「全部翻譯」按鈕
  - 進度條
  - 完成後逐句 review / edit
  - 用 LM Studio Gemma 4 跑（呼叫 http://127.0.0.1:1234）

#### M6 voice 整合
- [ ] voice-config.json 擴充：每 persona × 每 lang 一份 ref audio
- [ ] 批次生成時依當前 language 挑對應 ref audio
- [ ] manifest hash 加 lang 維度（同句不同語言要分開記）
- [ ] 設定視窗「對話語言」切換時 voice 也跟著切

### 11.6 翻譯 prompt 設計（給 Gemma 4）

```
你是專業的對白翻譯，請把以下{persona_display_name}（{persona_personality}）的中文對白翻譯成日文。

要求：
1. 保留角色語氣：{angle_specific_traits}
   - 例（haiyin）：病嬌語氣、佔有感、口吻偏 17 歲少女、對戀人不用敬語（タメ口）
   - 例（liss）：女僕語氣、稱呼用「ご主人様」、用敬語（ですます調）、結尾常加「～♡」
2. 變數 {time} {hour} {weekday} {usage_hours} {window_title} 保留不要翻譯
3. 顏文字保留（如 (*ˊᗜˋ*)）或換成日文常見等價（如 (*´ω`*)）
4. 表情標記不變

中文對白：
{lines}

請只輸出翻譯結果，每行對應一句，不要加額外說明。
```

每個 persona 跑前先讀 persona.json 的 personality / speech_style 動態組合 prompt。

### 11.7 風險與緩解

| 風險 | 機率 | 影響 | 緩解 |
|---|---|---|---|
| 角色語氣翻譯後丟失 | 中 | 中 | Prompt 工程 + 人工 review |
| 日文敬語等級錯（海音不該用敬語）| 中 | 中 | Prompt 明確指定 + persona.json 加 `language_voice_traits` 欄位 |
| 顏文字 / emoji 翻譯混亂 | 中 | 低 | Prompt 規則 + 接受微調 |
| 變數標記被翻譯 | 中 | 高 | Prompt 強調「保留 {xxx}」+ 後處理檢查 |
| Gemma 4 翻譯品質不穩 | 中 | 中 | 逐句人工 review；UI 內可手動 edit |
| 165 句 × 2 persona = 330 句 review 工時 | 高 | 中 | 漸進式：先翻一個 persona 試效果 |
| 找不到滿意的日文 ref audio | 中 | 中 | 同 §2 邏輯，動畫 VA 為主 |

### 11.8 工日估算（M6-multilang 單獨跑）

| 工項 | 工日 | 主導 |
|---|---|---|
| dialogues schema 擴充 + director 多語邏輯 | 0.4 | 我 |
| 設定視窗「對話語言」+ IPC | 0.2 | 我 |
| 對話庫管理多語顯示 + 翻譯 Tab 6 | 0.6 | 我 |
| voice-config 多 ref + manifest 加 lang 維度 | 0.3 | 我 |
| 跑翻譯 + 人工 review 165×2 句 | 0.5-1 | **你** |
| 找海音 / 莉絲 日文 ref audio | 0.2-0.5 | **你** |
| 測試 + 微調 | 0.4 | 我 |
| **小計（我寫）** | **~2 工日** | |
| **小計（你做）** | **~1-2 工日** | |

### 11.9 替代方案：「新 persona」不動 schema

不想動 schema 的話，可以走「新人格」路線：
- 新建 haiyin-ja / liss-ja 人格（自己寫日文 dialogues 不翻譯）
- 用日文 ref audio
- 切「人格」haiyin → haiyin-ja

優點：schema 不用改、persona 機制既有支援
缺點：要寫第二份 dialogues（不能利用既有翻譯）+ persona 數量倍增

**評估**：如果你只想試試日文版「不確定要不要長期用」走這條較快；如果確定多語是長期方向走 §11.5 schema 擴充比較乾淨。

### 11.10 啟動時機決策樹

```
M6 中文版完成、實際用 1-2 週
  ↓
  你問自己：我有多想要日文版？
  ↓
  ├─ 「不太想」→ 不啟動，省工
  ├─ 「試試看」→ §11.9 新 persona 路線（快、髒）
  └─ 「長期要」→ §11.5 schema 擴充路線（慢、乾淨）
```

---

## 變更管理

| 版本 | 日期 | 主要變更 |
|---|---|---|
| v1.0 | 2026-05-10 | 初版，依 5070 Ti / 動畫 VA 路線寫 |
| v1.1 | 2026-05-10 | 加 §11 多語支援擴充計畫（M6-multilang，待主線完成後啟動）|

---

## 關聯文件
- [里程碑計畫.md §M6](里程碑計畫.md) — M6 階段定義
- [gemma4_api_guide.md](gemma4_api_guide.md) — 用戶端 LM Studio 模式（GPT-SoVITS API 同概念）
- [M4-fallback-prompt-模板.md](M4-fallback-prompt-模板.md) — M4 dialogues 來源（M6 要為這些句子配音）
