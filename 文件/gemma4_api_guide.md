# Gemma 4 本地 API 使用說明

> 透過 LM Studio 在本機運行 Gemma 4 26B A4B，完全離線，免費無限制

---

## 連線資訊

| 項目 | 值 |
|------|-----|
| Base URL | `http://127.0.0.1:1234/v1` |
| API Key | `lm-studio`（任意字串即可，本地不驗證） |
| Model ID | `google/gemma-4-26b-a4b` |
| Port | `1234` |

---

## 使用前確認

1. 打開 LM Studio
2. 左側點選 **Developer** 頁籤
3. 確認左上角 **Status: Running**（綠燈）
4. 確認模型 `google/gemma-4-26b-a4b` 狀態為 **READY**

---

## 程式碼範例

### cURL

```bash
curl http://127.0.0.1:1234/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "google/gemma-4-26b-a4b",
    "messages": [
      {"role": "system", "content": "你是專業助手"},
      {"role": "user", "content": "你好"}
    ]
  }'
```

### Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:1234/v1",
    api_key="lm-studio"  # 任意字串即可
)

response = client.chat.completions.create(
    model="google/gemma-4-26b-a4b",
    messages=[
        {"role": "system", "content": "你是專業助手"},
        {"role": "user", "content": "你好"}
    ]
)

print(response.choices[0].message.content)
```

### JavaScript / Node.js

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:1234/v1",
  apiKey: "lm-studio",
});

const res = await client.chat.completions.create({
  model: "google/gemma-4-26b-a4b",
  messages: [
    { role: "system", content: "你是專業助手" },
    { role: "user", content: "你好" },
  ],
});

console.log(res.choices[0].message.content);
```

---

## 可用的 Endpoints

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/v1/chat/completions` | 對話（OpenAI 相容格式，推薦） |
| GET  | `/v1/models` | 列出已載入的模型 |
| POST | `/api/v1/chat` | 對話（LM Studio 原生格式） |
| POST | `/v1/embeddings` | 文字向量化 |

---

## 其他軟體接入設定

所有支援「自訂 API Endpoint」的軟體，填入以下設定即可：

- **Base URL**：`http://127.0.0.1:1234/v1`
- **API Key**：隨便填（例如 `lm-studio`）
- **Model**：`google/gemma-4-26b-a4b`

### 支援的軟體列表

- 任何 OpenAI 官方 SDK（Python、Node.js、C# 等）
- LangChain / LlamaIndex
- Continue.dev（VS Code AI 程式助手）
- n8n / Flowise（自動化工作流）
- Open WebUI（本地 ChatGPT 介面）
- Cursor / Cline（AI 程式碼編輯器）

---

## 區域網路共享

若要讓同網路的其他裝置也能連線，將 `127.0.0.1` 改成這台電腦的區域網路 IP：

```
http://192.168.x.x:1234/v1
```

並在 LM Studio Server 設定中，將監聽位址改為 `0.0.0.0`。

---

## 注意事項

- LM Studio 本地 Server **不需要驗證**，API Key 填任何非空字串即可
- 若 API 回傳錯誤，可用 `GET /v1/models` 確認模型 ID 是否正確
- 模型需保持載入（READY 狀態）才能接受請求
- 此服務完全在本地運行，不會傳送任何資料到雲端
