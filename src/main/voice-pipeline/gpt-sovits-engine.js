// GPT-SoVITS Engine — HTTP client（M6 §5.1）
//
// 對應 GPT-SoVITS 官方 api.py（port 9880 預設）。
// 跟 LM Studio 同模式：使用者啟動 `python api.py`，本程式當 client。
//
// API spec（GPT-SoVITS v2/v3/v4 通用）：
//   POST /
//   Body: {
//     refer_wav_path, prompt_text, prompt_language,
//     text, text_language,
//     top_k?, top_p?, temperature?, speed?
//   }
//   Response: audio/wav binary（成功）/ JSON {code, message}（失敗）
//
//   GET /                                     → API server 是否在線（不確定 v 別都有，我們用 POST 一個輕量 request 當 health check）

'use strict';

const { TTSEngine } = require('./tts-engine');

const DEFAULT_BASE_URL = 'http://127.0.0.1:9880';
const DEFAULT_TIMEOUT_MS = 60_000; // 單句最多 60 秒（長句 + GPU 溫機）

class GPTSoVITSEngine extends TTSEngine {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    logger = console,
  } = {}) {
    super({ name: 'gpt-sovits', logger });
    this._baseUrl = baseUrl.replace(/\/$/, '');
    this._timeoutMs = timeoutMs;
  }

  /**
   * Ping API server。
   *
   * GPT-SoVITS api.py 的 GET / 會把 query params 當預設值跑 TTS（無 query 時走 default），
   * 不能當 health check（會 timeout）。改用 fastapi 自動生成的 /docs（Swagger UI HTML）。
   * 任何 fastapi server 都有 /docs，回應快、不會觸發 inference。
   */
  async healthCheck() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3_000);
      const res = await fetch(this._baseUrl + '/docs', {
        method: 'GET',
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      return res.status < 500;
    } catch (err) {
      this._log.warn?.(`[gpt-sovits] healthCheck failed: ${err.message}`);
      return false;
    }
  }

  /**
   * 合成單句語音。
   * @param {object} opts
   * @param {string} opts.text                    target text
   * @param {string} opts.ref_audio_path          主 ref（要對應 ref_text）
   * @param {string} opts.ref_text                主 ref 的逐字稿
   * @param {string} [opts.ref_lang='zh']
   * @param {string} [opts.target_lang='zh']
   * @param {Array<string>} [opts.inp_refs=[]]    額外平均融合 ref（不需文字稿，建議同性別）
   * @param {number} [opts.speed]                 語速（0.5-2.0）
   * @param {number} [opts.temperature]           採樣溫度（0-1，越高越隨機）
   * @param {number} [opts.top_k]                 採樣 top-K
   * @param {number} [opts.top_p]                 採樣 top-P
   * @param {number} [opts.fragment_interval]     片段間靜音秒（0-1，預設 0.3）
   * @param {number} [opts.seed]                  隨機種子（reproducible TTS）
   * @param {number} [opts.repetition_penalty]    重複懲罰（1.0-2.0，預設 1.35）
   * @returns {Promise<{ audio: Buffer, meta: { engine, base_url, ms } }>}
   */
  async synthesize(opts) {
    const {
      text,
      ref_audio_path,
      ref_text,
      ref_lang = 'zh',
      target_lang = 'zh',
      inp_refs = [],
      speed,
      temperature,
      top_k,
      top_p,
      fragment_interval,
      seed,
      repetition_penalty,
    } = opts || {};

    if (!text || !ref_audio_path || !ref_text) {
      throw new Error('synthesize: text / ref_audio_path / ref_text required');
    }

    const body = {
      refer_wav_path: ref_audio_path,
      prompt_text: ref_text,
      prompt_language: ref_lang,
      text,
      text_language: target_lang,
    };
    if (Array.isArray(inp_refs) && inp_refs.length > 0) body.inp_refs = inp_refs;
    if (Number.isFinite(speed)) body.speed = speed;
    if (Number.isFinite(temperature)) body.temperature = temperature;
    if (Number.isFinite(top_k)) body.top_k = top_k;
    if (Number.isFinite(top_p)) body.top_p = top_p;
    if (Number.isFinite(fragment_interval)) body.fragment_interval = fragment_interval;
    if (Number.isFinite(seed)) body.seed = seed;
    if (Number.isFinite(repetition_penalty)) body.repetition_penalty = repetition_penalty;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this._timeoutMs);

    const startedAt = Date.now();
    let res;
    try {
      res = await fetch(this._baseUrl + '/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const ms = Date.now() - startedAt;

    if (!res.ok) {
      // 試讀 error JSON
      let detail = '';
      try {
        const err = await res.json();
        detail = ` ${err.code || ''} ${err.message || ''}`.trim();
      } catch (_e) {
        try { detail = await res.text(); } catch (_e2) { detail = ''; }
      }
      throw new Error(`GPT-SoVITS HTTP ${res.status}${detail ? ': ' + detail : ''}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const audio = Buffer.from(arrayBuffer);

    if (!audio || audio.length < 100) {
      throw new Error(`GPT-SoVITS returned empty/invalid audio (${audio?.length || 0} bytes)`);
    }

    return {
      audio,
      meta: {
        engine: this.name,
        base_url: this._baseUrl,
        ms,
        bytes: audio.length,
      },
    };
  }
}

module.exports = { GPTSoVITSEngine, DEFAULT_BASE_URL };
