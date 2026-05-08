// RollupAggregator — 每小時聚合 raw events → hourly rollup
//
// 對外契約：
//   - rebuild(events)              批次處理（給 retroactive 腳本用）
//   - writeRollups(rollups)        寫成 data/rollups/<date>.jsonl
//   - startStreaming({...})        runtime 模式：訂閱感知層、整點自動 flush
//   - stop()                       關閉時 flush 最後一個（不完整）rollup
//
// rollup 結構：見 HourlyRollup.toJSON()
//
// 設計要點：
//   - hour 邊界對齊本地整點（不用 UTC，便於人類解讀）
//   - 跨 hour 的 state（如 fullscreen 持續 90 分鐘）正確拆分到對應 hour
//   - 沒事件的 hour 直接跳過（不留空 entry）
//   - rollups 永久保存（量小，一年 8760 筆 < 10MB）

const fs = require('node:fs');
const path = require('node:path');

const HOUR_MS = 60 * 60 * 1000;

class HourlyRollup {
  constructor(hourStart) {
    this.hourStart = hourStart;
    this.hourEnd = hourStart + HOUR_MS;

    // 鍵滑活動
    this.click_count = 0;
    this.key_count = 0;
    this.typing_burst_count = 0;
    this._typing_modifier_weighted_sum = 0;
    this._typing_backspace_weighted_sum = 0;
    this.mouse_distance_total_px = 0;
    this.mouse_active_ms = 0;

    // 閒置
    this.idle_minutes = 0;
    this.idle_periods = 0;

    // 應用前景時間
    this.fg_app_ms = {};
    this._lastFocusApp = null;
    this._lastFocusAt = null;

    // 系統指標
    this._cpuSamples = [];
    this._gpuSamples = [];
    this._ramSamples = [];

    // 觸發
    this.trigger_count = {};

    // 狀態時段
    this.fullscreen_ms = 0;
    this._fullscreenSince = null;
    this.screen_locked_ms = 0;
    this._lockedSince = null;
    // audio/mic/cam 用 reference counting：「至少一個 exe 活躍」算 1 倍時間
    // _xxxActiveExes 集合大小從 0→1 時記下 _xxxBlockSince；從 1→0 時累加
    this.audio_active_ms = 0;
    this._audioActiveExes = new Set();
    this._audioBlockSince = null;
    this.mic_active_ms = 0;
    this._micActiveExes = new Set();
    this._micBlockSince = null;
    this.cam_active_ms = 0;
    this._camActiveExes = new Set();
    this._camBlockSince = null;

    // 剪貼簿
    this.clipboard_changes = 0;

    // context state ms（M3 後若加 context:changed event 可填）
    this.in_meeting_ms = 0;
    this.in_game_ms = 0;
    this.watching_video_ms = 0;
    this.in_ide_ms = 0;
    this._contextSince = {}; // state name → started_at
  }

  // 接收 event。caller 應確保 e.t 在 [hourStart, hourEnd)
  ingest(e) {
    if (!e || e.t == null || e.t < this.hourStart || e.t >= this.hourEnd) return;
    const t = e.t;

    switch (e.type) {
      case 'click':
        this.click_count++;
        break;

      case 'typing-burst':
        this.typing_burst_count++;
        this.key_count += e.key_count || 0;
        this._typing_modifier_weighted_sum += (e.modifier_ratio || 0) * (e.key_count || 0);
        this._typing_backspace_weighted_sum += (e.backspace_ratio || 0) * (e.key_count || 0);
        break;

      case 'mouse-burst':
        this.mouse_distance_total_px += e.distance_px || 0;
        this.mouse_active_ms += e.active_ms || 0;
        break;

      case 'idle-end':
        this.idle_minutes += (e.duration_ms || 0) / 60000;
        this.idle_periods++;
        break;

      case 'window:focus-changed':
        this._closeFgSpan(t);
        this._lastFocusApp = e.app;
        this._lastFocusAt = t;
        break;

      case 'fullscreen:state':
        if (e.active) {
          if (this._fullscreenSince == null) this._fullscreenSince = t;
        } else {
          this._closeSpan('_fullscreenSince', 'fullscreen_ms', t);
        }
        break;

      case 'power:lock':
        if (this._lockedSince == null) this._lockedSince = t;
        break;
      case 'power:unlock':
        this._closeSpan('_lockedSince', 'screen_locked_ms', t);
        break;

      case 'audio:session-started':
        this._refOpen('audio', e.exe, t);
        break;
      case 'audio:session-ended':
        this._refClose('audio', e.exe, t);
        break;

      case 'mic:recent-access-by':
        this._refOpen('mic', e.exe, t);
        break;
      case 'mic:released-by':
        this._refClose('mic', e.exe, t);
        break;

      case 'cam:recent-access-by':
        this._refOpen('cam', e.exe, t);
        break;
      case 'cam:released-by':
        this._refClose('cam', e.exe, t);
        break;

      case 'system:stats-tick':
        if (e.cpu_pct != null) this._cpuSamples.push(e.cpu_pct);
        if (e.gpu_pct != null) this._gpuSamples.push(e.gpu_pct);
        if (e.ram_pct != null) this._ramSamples.push(e.ram_pct);
        break;

      case 'trigger:fired':
        if (e.category) {
          this.trigger_count[e.category] = (this.trigger_count[e.category] || 0) + 1;
        }
        break;

      case 'clipboard:changed':
        this.clipboard_changes++;
        break;

      case 'context:changed':
        // M3 後加：state 為 in_meeting/in_game/watching_video/in_ide 的時段累計
        this._handleContextChange(e, t);
        break;

      default:
        break;
    }
  }

  // 結算：處理仍 active 但跨到下個 hour 的 state
  finalize(boundary) {
    const end = Math.min(boundary, this.hourEnd);

    if (this._lastFocusApp && this._lastFocusAt != null) {
      this._addFgSpan(this._lastFocusApp, this._lastFocusAt, end);
    }
    if (this._fullscreenSince != null) {
      this.fullscreen_ms += Math.max(0, end - Math.max(this._fullscreenSince, this.hourStart));
    }
    if (this._lockedSince != null) {
      this.screen_locked_ms += Math.max(0, end - Math.max(this._lockedSince, this.hourStart));
    }
    // reference counting：仍 active 的話加上 [blockSince, end] 那段
    if (this._audioActiveExes.size > 0 && this._audioBlockSince != null) {
      this.audio_active_ms += Math.max(0, end - this._audioBlockSince);
    }
    if (this._micActiveExes.size > 0 && this._micBlockSince != null) {
      this.mic_active_ms += Math.max(0, end - this._micBlockSince);
    }
    if (this._camActiveExes.size > 0 && this._camBlockSince != null) {
      this.cam_active_ms += Math.max(0, end - this._camBlockSince);
    }
    for (const [name, since] of Object.entries(this._contextSince)) {
      const ms = Math.max(0, end - Math.max(since, this.hourStart));
      this._addContextMs(name, ms);
    }
  }

  // 從上一個 hour 繼承仍 active 的 exes / state（跨 hour 邊界精準計時）
  inheritActiveState(prev) {
    if (!prev) return;

    // audio / mic / cam：把上 hour 仍活著的 exes 帶過來，blockSince 設為 hourStart
    for (const exe of prev._audioActiveExes) this._audioActiveExes.add(exe);
    if (this._audioActiveExes.size > 0) this._audioBlockSince = this.hourStart;

    for (const exe of prev._micActiveExes) this._micActiveExes.add(exe);
    if (this._micActiveExes.size > 0) this._micBlockSince = this.hourStart;

    for (const exe of prev._camActiveExes) this._camActiveExes.add(exe);
    if (this._camActiveExes.size > 0) this._camBlockSince = this.hourStart;

    // single-state（only one at a time）
    if (prev._fullscreenSince != null) this._fullscreenSince = this.hourStart;
    if (prev._lockedSince != null) this._lockedSince = this.hourStart;
    if (prev._lastFocusApp) {
      this._lastFocusApp = prev._lastFocusApp;
      this._lastFocusAt = this.hourStart;
    }

    // context state 沿用
    for (const name of Object.keys(prev._contextSince)) {
      this._contextSince[name] = this.hourStart;
    }
  }

  toJSON() {
    return {
      type: 'hourly-rollup',
      hour_start: this.hourStart,
      hour_iso: new Date(this.hourStart).toISOString(),
      hour_local: localHourString(this.hourStart),
      duration_ms: HOUR_MS,

      click_count: this.click_count,
      key_count: this.key_count,
      typing_burst_count: this.typing_burst_count,
      modifier_ratio_avg: this.key_count > 0 ? round3(this._typing_modifier_weighted_sum / this.key_count) : 0,
      backspace_ratio_avg: this.key_count > 0 ? round3(this._typing_backspace_weighted_sum / this.key_count) : 0,
      mouse_distance_total_px: Math.round(this.mouse_distance_total_px),
      mouse_active_ms: Math.round(this.mouse_active_ms),

      idle_minutes: round1(this.idle_minutes),
      idle_periods: this.idle_periods,

      fg_app_ms: roundMsObject(this.fg_app_ms),

      cpu_avg_pct: this._cpuSamples.length > 0 ? round1(avg(this._cpuSamples)) : null,
      gpu_avg_pct: this._gpuSamples.length > 0 ? round1(avg(this._gpuSamples)) : null,
      ram_avg_pct: this._ramSamples.length > 0 ? round1(avg(this._ramSamples)) : null,

      trigger_count: this.trigger_count,

      fullscreen_ms: Math.round(this.fullscreen_ms),
      screen_locked_ms: Math.round(this.screen_locked_ms),
      audio_active_ms: Math.round(this.audio_active_ms),
      mic_active_ms: Math.round(this.mic_active_ms),
      cam_active_ms: Math.round(this.cam_active_ms),
      clipboard_changes: this.clipboard_changes,

      in_meeting_ms: Math.round(this.in_meeting_ms),
      in_game_ms: Math.round(this.in_game_ms),
      watching_video_ms: Math.round(this.watching_video_ms),
      in_ide_ms: Math.round(this.in_ide_ms),
    };
  }

  // ── 內部 helpers ──────────────
  _closeFgSpan(t) {
    if (this._lastFocusApp && this._lastFocusAt != null) {
      this._addFgSpan(this._lastFocusApp, this._lastFocusAt, t);
    }
  }

  _addFgSpan(app, since, end) {
    const span = Math.max(0, end - Math.max(since, this.hourStart));
    if (span > 0) this.fg_app_ms[app] = (this.fg_app_ms[app] || 0) + span;
  }

  _closeSpan(sinceField, msField, t) {
    if (this[sinceField] != null) {
      const span = Math.max(0, t - Math.max(this[sinceField], this.hourStart));
      this[msField] += span;
      this[sinceField] = null;
    }
  }

  _closeMapSpan(map, key, msField, t) {
    if (map[key] != null) {
      const span = Math.max(0, t - Math.max(map[key], this.hourStart));
      this[msField] += span;
      delete map[key];
    }
  }

  // reference counting：「至少一個 exe 活躍」算 1 倍時間
  _refOpen(kind, exe, t) {
    const set = this[`_${kind}ActiveExes`];
    const sinceField = `_${kind}BlockSince`;
    if (set.has(exe)) return;
    if (set.size === 0) this[sinceField] = Math.max(t, this.hourStart);
    set.add(exe);
  }

  _refClose(kind, exe, t) {
    const set = this[`_${kind}ActiveExes`];
    const sinceField = `_${kind}BlockSince`;
    const msField = `${kind}_active_ms`;
    if (!set.has(exe)) return;
    set.delete(exe);
    if (set.size === 0 && this[sinceField] != null) {
      this[msField] += Math.max(0, Math.min(t, this.hourEnd) - this[sinceField]);
      this[sinceField] = null;
    }
  }

  _handleContextChange(e, t) {
    const name = e.state_name;
    if (!CONTEXT_STATE_TRACKED.includes(name)) return;
    const wasTrue = this._contextSince[name] != null;
    const isTrue = e.new_value === true;

    if (isTrue && !wasTrue) {
      this._contextSince[name] = t;
    } else if (!isTrue && wasTrue) {
      const ms = Math.max(0, t - Math.max(this._contextSince[name], this.hourStart));
      this._addContextMs(name, ms);
      delete this._contextSince[name];
    }
  }

  _addContextMs(name, ms) {
    if (name === 'in_meeting') this.in_meeting_ms += ms;
    else if (name === 'in_game') this.in_game_ms += ms;
    else if (name === 'watching_video') this.watching_video_ms += ms;
    else if (name === 'in_ide') this.in_ide_ms += ms;
  }
}

const CONTEXT_STATE_TRACKED = ['in_meeting', 'in_game', 'watching_video', 'in_ide'];

class RollupAggregator {
  constructor({ rollupsDir, logger = console } = {}) {
    if (!rollupsDir) throw new Error('RollupAggregator: rollupsDir required');
    this._rollupsDir = rollupsDir;
    this._log = logger;

    // streaming 模式
    this._streamRollup = null;
    this._initialTimeout = null;
    this._hourlyInterval = null;
    this._subscriptions = [];
  }

  /**
   * 批次處理：對 events 陣列做 rollup（給 retroactive 腳本用）
   * @returns rollups[] (toJSON 後的陣列)
   */
  rebuild(events) {
    if (!Array.isArray(events) || events.length === 0) return [];

    const sorted = [...events].sort((a, b) => (a.t || 0) - (b.t || 0));
    const rollups = [];
    let current = null;
    let prevForInherit = null;

    for (const e of sorted) {
      if (e.t == null) continue;
      const hour = floorToHour(e.t);

      if (current && hour !== current.hourStart) {
        // 切到新 hour：先 finalize 舊的（用 hourEnd），保留以便下個 hour 繼承
        current.finalize(current.hourEnd);
        rollups.push(current.toJSON());
        prevForInherit = current;
        current = null;
      }

      if (!current) {
        current = new HourlyRollup(hour);
        if (prevForInherit) current.inheritActiveState(prevForInherit);
      }

      current.ingest(e);
    }

    if (current) {
      const lastT = sorted[sorted.length - 1].t || current.hourEnd;
      current.finalize(Math.min(lastT, current.hourEnd));
      rollups.push(current.toJSON());
    }

    return rollups;
  }

  /**
   * 把 rollups 寫到 data/rollups/<date>.jsonl
   * 同一日期的 rollups 整檔覆寫（rebuild 用）
   */
  async writeRollups(rollups) {
    if (rollups.length === 0) return;
    await fs.promises.mkdir(this._rollupsDir, { recursive: true });

    const byDate = new Map();
    for (const r of rollups) {
      const date = r.hour_iso.slice(0, 10);
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(r);
    }

    for (const [date, list] of byDate) {
      const file = path.join(this._rollupsDir, `${date}.jsonl`);
      const content = list.map((r) => JSON.stringify(r)).join('\n') + '\n';
      await fs.promises.writeFile(file, content);
    }
  }

  /**
   * 附加單一 rollup 到對應日期檔（streaming 用）
   */
  async appendRollup(rollup) {
    await fs.promises.mkdir(this._rollupsDir, { recursive: true });
    const date = rollup.hour_iso.slice(0, 10);
    const file = path.join(this._rollupsDir, `${date}.jsonl`);
    await fs.promises.appendFile(file, JSON.stringify(rollup) + '\n');
  }

  /**
   * Runtime 模式：訂閱感知層，整點自動 flush rollup
   */
  startStreaming({ inputMonitor, monitorRegistry, contextStateTracker } = {}) {
    const now = Date.now();
    this._streamRollup = new HourlyRollup(floorToHour(now));

    if (inputMonitor) {
      const handlers = {
        'typing-burst': (p) => this._ingestStream({ type: 'typing-burst', t: p?.ended_at || Date.now(), ...p }),
        'mouse-burst':  (p) => this._ingestStream({ type: 'mouse-burst', t: p?.ended_at || Date.now(), ...p }),
        'click':        (p) => this._ingestStream({ type: 'click', t: p?.t || Date.now(), ...p }),
        'idle-end':     (p) => this._ingestStream({ type: 'idle-end', t: p?.ended_at || Date.now(), ...p }),
      };
      for (const [evt, h] of Object.entries(handlers)) inputMonitor.on(evt, h);
      this._subscriptions.push({ source: inputMonitor, handlers });
    }

    if (monitorRegistry) {
      const handler = ({ event_name, payload }) => {
        this._ingestStream({ type: event_name, t: payload?.t || Date.now(), ...(payload || {}) });
      };
      monitorRegistry.on('plugin-event', handler);
      this._subscriptions.push({ source: monitorRegistry, handlers: { 'plugin-event': handler } });
    }

    if (contextStateTracker) {
      const handler = ({ name, prev, current }) => {
        this._ingestStream({
          type: 'context:changed',
          t: current?.evaluated_at || Date.now(),
          state_name: name,
          prev_value: prev,
          new_value: current?.value,
        });
      };
      contextStateTracker.on('changed', handler);
      this._subscriptions.push({ source: contextStateTracker, handlers: { changed: handler } });
    }

    // 整點 flush 排程
    const nextHour = floorToHour(now) + HOUR_MS;
    const msUntilNext = nextHour - now;
    this._initialTimeout = setTimeout(() => {
      this._flushAndStartNext().catch((e) => this._log.warn?.('[rollup] flush:', e));
      this._hourlyInterval = setInterval(() => {
        this._flushAndStartNext().catch((e) => this._log.warn?.('[rollup] flush:', e));
      }, HOUR_MS);
    }, msUntilNext);
  }

  async stop() {
    if (this._initialTimeout) clearTimeout(this._initialTimeout);
    if (this._hourlyInterval) clearInterval(this._hourlyInterval);
    this._initialTimeout = null;
    this._hourlyInterval = null;

    for (const { source, handlers } of this._subscriptions) {
      for (const [evt, h] of Object.entries(handlers)) {
        try { source.removeListener(evt, h); } catch (_e) { /* ignore */ }
      }
    }
    this._subscriptions = [];

    // flush 不完整的 rollup
    if (this._streamRollup) {
      this._streamRollup.finalize(Date.now());
      const r = { ...this._streamRollup.toJSON(), partial: true };
      await this.appendRollup(r).catch(() => {});
      this._streamRollup = null;
    }
  }

  _ingestStream(event) {
    if (!this._streamRollup) return;
    const hour = floorToHour(event.t);
    if (hour !== this._streamRollup.hourStart) {
      // 跨過 hour 邊界（罕見，因為有定時 flush）
      const prev = this._streamRollup;
      prev.finalize(prev.hourEnd);
      const r = prev.toJSON();
      this.appendRollup(r).catch((e) => this._log.warn?.('[rollup] append:', e));
      this._streamRollup = new HourlyRollup(hour);
      this._streamRollup.inheritActiveState(prev);
    }
    this._streamRollup.ingest(event);
  }

  async _flushAndStartNext() {
    if (!this._streamRollup) return;
    const prev = this._streamRollup;
    prev.finalize(prev.hourEnd);
    const r = prev.toJSON();
    await this.appendRollup(r);
    this._streamRollup = new HourlyRollup(floorToHour(Date.now()));
    this._streamRollup.inheritActiveState(prev);
  }
}

// ── pure helpers ──────────────────────────────────────────
function floorToHour(t) {
  return Math.floor(t / HOUR_MS) * HOUR_MS;
}

function avg(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function round1(x) { return Math.round(x * 10) / 10; }
function round3(x) { return Math.round(x * 1000) / 1000; }

function roundMsObject(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = Math.round(v);
  return out;
}

function localHourString(t) {
  const d = new Date(t);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:00`;
}

module.exports = { RollupAggregator, HourlyRollup };
