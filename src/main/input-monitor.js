// InputMonitor — Tier 1 感知層核心
//
// 對外契約：
//   - extends EventEmitter
//   - emit 'typing-burst' / 'mouse-burst' / 'click-burst'  → 給 EventLogger
//   - emit 'click'                                          → 給 TriggerEngine 即時觸發
//   - emit 'idle-start' / 'idle-end'                        → 給 EventLogger / TriggerEngine
//   - emit 'plugin:degraded' { reason }                     → uiohook 啟動失敗時
//   - snapshot()                                            → 給 TriggerEngine pull
//   - resetSinceLastTrigger()                               → 觸發後清計數
//   - capabilities = ['keyboard_input', 'mouse_input', 'idle_detection']
//
// 設計要點（依 plan §4 Event Coalescing）：
//   - 鍵盤不 emit 個別 key，改 emit typing-burst 摘要
//   - 滑鼠 mousemove 每秒聚合為 mouse-burst
//   - click 即時 emit + 5 秒視窗 click-burst summary 雙軌

const EventEmitter = require('events');

const TYPING_BURST_GAP_MS = 1500;
const MOUSE_BURST_WINDOW_MS = 1000;
const CLICK_BURST_WINDOW_MS = 5000;
const IDLE_THRESHOLD_MS = 5 * 60 * 1000;
const KEY_RING_RETENTION_MS = 30 * 1000;
const UIOHOOK_BACKSPACE_KEYCODE = 14;

class InputMonitor extends EventEmitter {
  static capabilities = ['keyboard_input', 'mouse_input', 'idle_detection'];

  constructor({ logger } = {}) {
    super();
    this._log = logger || console;
    this._uIOhook = null;

    this._started = false;
    this._healthy = false;
    this._lastError = null;

    this._counters = {
      clicks_total: 0,
      keys_total: 0,
      clicks_since_last_trigger: 0,
      keys_since_last_trigger: 0,
      mouse_distance_total_px: 0,
    };

    this._lastInputAt = null;
    this._sessionStartAt = null;

    this._typingBurst = null;
    this._typingBurstFlushTimer = null;
    this._lastTypingBurstSummary = null;

    this._mouseBurst = null;
    this._mouseFlushInterval = null;
    this._lastMouseBurstSummary = null;

    this._clickBurst = null;
    this._clickFlushTimer = null;

    this._isIdle = false;
    this._idleStartAt = null;
    this._idleCheckInterval = null;

    this._recentKeyTimestamps = [];

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseDown = this._onMouseDown.bind(this);
  }

  start() {
    if (this._started) return;

    try {
      const mod = require('uiohook-napi');
      this._uIOhook = mod.uIOhook;
      this._uIOhook.on('keydown', this._onKeyDown);
      this._uIOhook.on('mousemove', this._onMouseMove);
      this._uIOhook.on('mousedown', this._onMouseDown);
      this._uIOhook.start();
    } catch (err) {
      this._lastError = err;
      this._healthy = false;
      this._log.error?.('[InputMonitor] uiohook start failed:', err);
      this.emit('plugin:degraded', { reason: 'uiohook-failed', error: String(err) });
      return;
    }

    this._mouseFlushInterval = setInterval(() => this._flushMouseBurst(), MOUSE_BURST_WINDOW_MS);
    this._idleCheckInterval = setInterval(() => this._checkIdle(), 5000);

    this._started = true;
    this._healthy = true;
    this.emit('started');
  }

  stop() {
    if (!this._started) return;

    try {
      this._uIOhook?.stop();
      this._uIOhook?.removeAllListeners?.();
    } catch (err) {
      this._log.warn?.('[InputMonitor] uiohook stop error:', err);
    }

    if (this._mouseFlushInterval) clearInterval(this._mouseFlushInterval);
    if (this._idleCheckInterval) clearInterval(this._idleCheckInterval);
    if (this._typingBurstFlushTimer) clearTimeout(this._typingBurstFlushTimer);
    if (this._clickFlushTimer) clearTimeout(this._clickFlushTimer);

    this._flushTypingBurst();
    this._flushMouseBurst(true);
    this._flushClickBurst();

    this._started = false;
    this._healthy = false;
    this.emit('stopped');
  }

  snapshot() {
    const now = Date.now();
    const idleSec = this._lastInputAt ? Math.floor((now - this._lastInputAt) / 1000) : 0;
    const sessionSec = this._sessionStartAt ? Math.floor((now - this._sessionStartAt) / 1000) : 0;

    const fiveSecAgo = now - 5000;
    const tenSecAgo = now - 10000;
    let recentIn5s = 0;
    let recentIn10s = 0;
    for (let i = this._recentKeyTimestamps.length - 1; i >= 0; i--) {
      const t = this._recentKeyTimestamps[i];
      if (t < tenSecAgo) break;
      recentIn10s++;
      if (t >= fiveSecAgo) recentIn5s++;
    }

    return {
      ...this._counters,
      last_input_at: this._lastInputAt,
      session_start_at: this._sessionStartAt,
      idle_sec: idleSec,
      session_sec: sessionSec,
      is_idle: this._isIdle,
      is_typing: recentIn5s >= 5,
      is_typing_intense: recentIn10s >= 30,
      recent_typing_burst: this._lastTypingBurstSummary,
      recent_mouse_burst: this._lastMouseBurstSummary,
    };
  }

  getStatus() {
    return {
      enabled: this._started,
      healthy: this._healthy,
      lastError: this._lastError ? String(this._lastError) : null,
    };
  }

  resetSinceLastTrigger() {
    this._counters.clicks_since_last_trigger = 0;
    this._counters.keys_since_last_trigger = 0;
  }

  _onKeyDown(e) {
    const now = Date.now();
    this._touchInput(now);
    this._counters.keys_total++;
    this._counters.keys_since_last_trigger++;

    this._recentKeyTimestamps.push(now);
    const cutoff = now - KEY_RING_RETENTION_MS;
    while (this._recentKeyTimestamps.length && this._recentKeyTimestamps[0] < cutoff) {
      this._recentKeyTimestamps.shift();
    }

    if (!this._typingBurst || now - this._typingBurst.last_at > TYPING_BURST_GAP_MS) {
      this._flushTypingBurst();
      this._typingBurst = {
        started_at: now,
        last_at: now,
        key_count: 0,
        modifier_count: 0,
        backspace_count: 0,
      };
    } else {
      this._typingBurst.last_at = now;
    }

    this._typingBurst.key_count++;
    if (e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) {
      this._typingBurst.modifier_count++;
    }
    if (e.keycode === UIOHOOK_BACKSPACE_KEYCODE) {
      this._typingBurst.backspace_count++;
    }

    if (this._typingBurstFlushTimer) clearTimeout(this._typingBurstFlushTimer);
    this._typingBurstFlushTimer = setTimeout(
      () => this._flushTypingBurst(),
      TYPING_BURST_GAP_MS + 100
    );
  }

  _flushTypingBurst() {
    if (!this._typingBurst) return;
    const b = this._typingBurst;
    const summary = {
      started_at: b.started_at,
      ended_at: b.last_at,
      duration_ms: b.last_at - b.started_at,
      key_count: b.key_count,
      modifier_ratio: b.key_count > 0 ? round3(b.modifier_count / b.key_count) : 0,
      backspace_ratio: b.key_count > 0 ? round3(b.backspace_count / b.key_count) : 0,
    };
    this._lastTypingBurstSummary = summary;
    this._typingBurst = null;
    if (this._typingBurstFlushTimer) {
      clearTimeout(this._typingBurstFlushTimer);
      this._typingBurstFlushTimer = null;
    }
    this.emit('typing-burst', summary);
  }

  _onMouseMove(e) {
    const now = Date.now();
    this._touchInput(now);

    if (!this._mouseBurst) {
      this._mouseBurst = {
        started_at: now,
        last_x: e.x,
        last_y: e.y,
        distance_px: 0,
        active_ms: 0,
        last_move_at: now,
        max_speed_px_per_sec: 0,
      };
      return;
    }

    const dx = e.x - this._mouseBurst.last_x;
    const dy = e.y - this._mouseBurst.last_y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    this._mouseBurst.distance_px += dist;

    const dt = now - this._mouseBurst.last_move_at;
    if (dt > 0 && dt < 100) {
      this._mouseBurst.active_ms += dt;
      const speed = (dist / dt) * 1000;
      if (speed > this._mouseBurst.max_speed_px_per_sec) {
        this._mouseBurst.max_speed_px_per_sec = speed;
      }
    }

    this._mouseBurst.last_x = e.x;
    this._mouseBurst.last_y = e.y;
    this._mouseBurst.last_move_at = now;
  }

  _flushMouseBurst(force = false) {
    if (!this._mouseBurst) return;
    const b = this._mouseBurst;
    if (!force && b.distance_px === 0 && b.active_ms === 0) {
      this._mouseBurst = null;
      return;
    }
    const summary = {
      started_at: b.started_at,
      ended_at: b.last_move_at,
      duration_ms: b.last_move_at - b.started_at,
      distance_px: Math.round(b.distance_px),
      active_ms: b.active_ms,
      max_speed_px_per_sec: Math.round(b.max_speed_px_per_sec),
    };
    this._counters.mouse_distance_total_px += summary.distance_px;
    this._lastMouseBurstSummary = summary;
    this._mouseBurst = null;
    this.emit('mouse-burst', summary);
  }

  _onMouseDown(e) {
    const now = Date.now();
    this._touchInput(now);
    this._counters.clicks_total++;
    this._counters.clicks_since_last_trigger++;

    const buttonName = mapMouseButton(e.button);

    this.emit('click', { t: now, button: buttonName });

    if (!this._clickBurst) {
      this._clickBurst = {
        started_at: now,
        count: 0,
        by_button: { left: 0, right: 0, middle: 0, other: 0 },
      };
      this._clickFlushTimer = setTimeout(() => this._flushClickBurst(), CLICK_BURST_WINDOW_MS);
    }
    this._clickBurst.count++;
    if (this._clickBurst.by_button[buttonName] !== undefined) {
      this._clickBurst.by_button[buttonName]++;
    } else {
      this._clickBurst.by_button.other++;
    }
  }

  _flushClickBurst() {
    if (!this._clickBurst) return;
    const b = this._clickBurst;
    const now = Date.now();
    const summary = {
      started_at: b.started_at,
      ended_at: now,
      duration_ms: now - b.started_at,
      count: b.count,
      by_button: b.by_button,
    };
    this._clickBurst = null;
    if (this._clickFlushTimer) {
      clearTimeout(this._clickFlushTimer);
      this._clickFlushTimer = null;
    }
    this.emit('click-burst', summary);
  }

  _touchInput(now) {
    this._lastInputAt = now;
    if (!this._sessionStartAt) {
      this._sessionStartAt = now;
    }
    if (this._isIdle) {
      const startedAt = this._idleStartAt;
      const duration = now - startedAt;
      this._isIdle = false;
      this._idleStartAt = null;
      this.emit('idle-end', { started_at: startedAt, ended_at: now, duration_ms: duration });
    }
  }

  _checkIdle() {
    if (!this._lastInputAt) return;
    const now = Date.now();
    if (!this._isIdle && now - this._lastInputAt >= IDLE_THRESHOLD_MS) {
      this._isIdle = true;
      this._idleStartAt = this._lastInputAt;
      this.emit('idle-start', { started_at: this._idleStartAt });
    }
  }
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

function mapMouseButton(code) {
  switch (code) {
    case 1: return 'left';
    case 2: return 'right';
    case 3: return 'middle';
    case 4: return 'button4';
    case 5: return 'button5';
    default: return 'other';
  }
}

module.exports = { InputMonitor };
