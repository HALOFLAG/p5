// Voice Batch Runner — 批次語音生成佇列（M6 §5.1）
//
// 對外契約：
//   const runner = new BatchRunner({ engine, manifest, concurrency, onProgress, onError });
//   await runner.run(candidates);                          阻塞跑完
//   runner.cancel();                                        中斷請求
//   runner.isRunning();
//
// candidates 結構：
//   [{
//     sequence_id, line_idx, text, ref_audio, ref_text, ref_lang, lang
//   }]
//
// 行為：
//   - 用 manifest.listMissing() 過濾掉已生成 → 只跑缺的
//   - concurrency=2-3 並發（GPU 友善）
//   - 失敗 retry 2 次
//   - 連續 5 句失敗 → 暫停整批，回拋 error
//   - 每完成一句呼叫 onProgress({ done, total, current, succeeded, failed, errors })
//   - cancel() 後新請求停發；in-flight 的等完成

'use strict';

const DEFAULT_CONCURRENCY = 2;
const MAX_RETRY = 2;
const STOP_AFTER_CONSECUTIVE_FAILURES = 5;

class BatchRunner {
  constructor({
    engine,
    manifest,
    concurrency = DEFAULT_CONCURRENCY,
    onProgress = () => {},
    onError = () => {},
    logger = console,
  } = {}) {
    if (!engine) throw new Error('engine required');
    if (!manifest) throw new Error('manifest required');
    this._engine = engine;
    this._manifest = manifest;
    this._concurrency = Math.max(1, Math.min(8, concurrency));
    this._onProgress = onProgress;
    this._onError = onError;
    this._log = logger;
    this._cancelled = false;
    this._running = false;
    this._consecutiveFailures = 0;
  }

  isRunning() { return this._running; }

  cancel() { this._cancelled = true; }

  /**
   * 跑批次。回傳完成狀態 summary。
   * @param {Array} candidates 同 voice-manifest.listMissing 輸入結構
   */
  async run(candidates) {
    if (this._running) throw new Error('already running');
    this._running = true;
    this._cancelled = false;
    this._consecutiveFailures = 0;

    try {
      const missing = await this._manifest.listMissing(candidates);
      const total = missing.length;

      const state = {
        done: 0,
        total,
        succeeded: 0,
        failed: 0,
        errors: [],
        skipped: candidates.length - total,
      };

      // 沒東西要跑 → 立即回
      if (total === 0) {
        this._onProgress({ ...state, current: null, phase: 'done' });
        return state;
      }

      this._onProgress({ ...state, current: null, phase: 'start' });

      // 起 N 個 worker 共享 cursor
      let cursor = 0;
      const workers = Array.from({ length: this._concurrency }, () =>
        this._workerLoop({ missing, state, cursor: () => cursor++ })
      );
      await Promise.all(workers);

      this._onProgress({ ...state, current: null, phase: 'done' });
      return state;
    } finally {
      this._running = false;
    }
  }

  async _workerLoop({ missing, state, cursor }) {
    while (!this._cancelled && this._consecutiveFailures < STOP_AFTER_CONSECUTIVE_FAILURES) {
      const idx = cursor();
      if (idx >= missing.length) return;
      const item = missing[idx];

      this._onProgress({
        ...state,
        current: { sequence_id: item.sequence_id, line_idx: item.line_idx, idx: idx + 1 },
        phase: 'progress',
      });

      const ok = await this._processOne(item, state);
      if (ok) {
        this._consecutiveFailures = 0;
        state.succeeded++;
      } else {
        this._consecutiveFailures++;
        state.failed++;
      }
      state.done++;

      this._onProgress({
        ...state,
        current: { sequence_id: item.sequence_id, line_idx: item.line_idx, idx: idx + 1 },
        phase: 'progress',
      });
    }
  }

  async _processOne(item, state) {
    let lastErr = null;
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      if (this._cancelled) return false;
      try {
        const result = await this._engine.synthesize({
          text: item.text,
          ref_audio_path: item.ref_audio,
          ref_text: item.ref_text,
          ref_lang: item.ref_lang || 'zh',
          target_lang: item.lang || 'zh',
          inp_refs: item.inp_refs || [],
          temperature: item.temperature,
          top_k: item.top_k,
          top_p: item.top_p,
          speed: item.speed,
          fragment_interval: item.fragment_interval,
          seed: item.seed,
          repetition_penalty: item.repetition_penalty,
        });
        await this._manifest.record({
          sequence_id: item.sequence_id,
          line_idx: item.line_idx,
          text: item.text,
          ref_audio: item.ref_audio,
          lang: item.lang || 'zh',
          hash: item._hash,
          audio: result.audio,
          engine: this._engine.name,
          meta: result.meta,
        });
        return true;
      } catch (err) {
        lastErr = err;
        this._log.warn?.(
          `[batch] ${item.sequence_id}_${item.line_idx} attempt ${attempt + 1}/${MAX_RETRY + 1} failed: ${err.message}`
        );
        // retry 前 sleep 短暫
        if (attempt < MAX_RETRY) await sleep(500 * (attempt + 1));
      }
    }
    state.errors.push({
      sequence_id: item.sequence_id,
      line_idx: item.line_idx,
      message: lastErr?.message || 'unknown',
    });
    this._onError({ item, error: lastErr });
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { BatchRunner };
