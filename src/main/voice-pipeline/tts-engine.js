// TTS Engine — 抽象介面（M6）
//
// 對外契約：
//   await engine.healthCheck()                  → boolean，service 是否在線
//   await engine.synthesize(opts)               → { audio: Buffer, meta }
//   engine.name                                 → 'gpt-sovits' / 'chattts' / ...
//
// synthesize opts：
//   {
//     text: string,                             目標台詞
//     ref_audio_path: string,                   ref audio 絕對路徑（或 ./voice-refs/...）
//     ref_text: string,                         ref audio 對應文字稿
//     ref_lang: string ('zh' / 'ja' / 'en'),    ref 語言
//     target_lang: string,                      target text 語言
//     speed?: number,                           語速倍率，預設 1.0
//     temperature?: number,                     生成溫度，預設 1.0
//   }
//
// 設計：
//   - 純抽象 class，子類實作 healthCheck / synthesize
//   - 不碰檔案 IO（caller 拿 Buffer 自己決定要存哪）
//   - 不碰 batch / queue（那是 batch-runner.js 的事）

'use strict';

class TTSEngine {
  constructor({ name, logger = console } = {}) {
    if (new.target === TTSEngine) {
      throw new Error('TTSEngine is abstract');
    }
    this.name = name;
    this._log = logger;
  }

  async healthCheck() {
    throw new Error('not implemented');
  }

  async synthesize(_opts) {
    throw new Error('not implemented');
  }
}

module.exports = { TTSEngine };
