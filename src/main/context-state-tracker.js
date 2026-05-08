// ContextStateTracker — Probabilistic Inference Layer
//
// 對外契約：
//   - getState()                 完整 state map
//   - getStateValue(name)        單個 state 三元組 { value, confidence, sources, evaluated_at, ttl_ms, reason }
//   - getRecentBehavior()        M4-M5 預留 stub（TemporalContext）
//   - 'changed' { name, prev, current }
//
// 設計要點（plan §5）：
//   - state 不是 boolean，是 { value, confidence, sources, evaluated_at, ttl_ms, reason }
//   - 每秒 tick 重算所有 state
//   - 缺 capability 對應 state.value = null（不是 false），fail-open
//   - TTL 60 秒：超過視為 null（防 plugin 卡住造成 suppress 死鎖）
//   - 多源融合，confidence 累加得分

const EventEmitter = require('node:events');

const TTL_MS = 60 * 1000;
const TICK_INTERVAL_MS = 1000;
const GPU_HIGH_THRESHOLD = 50;
const GPU_HIGH_DURATION_MS = 30 * 1000;

class ContextStateTracker extends EventEmitter {
  constructor({ inputMonitor, registry, appClassification, logger = console } = {}) {
    super();
    this._input = inputMonitor;
    this._registry = registry;
    this._classification = mergeClassification(appClassification);
    this._log = logger;

    this._state = {};
    this._tick = null;
    this._gpuHighSince = null;
  }

  start() {
    this._tick = setInterval(() => {
      try { this._evaluate(); } catch (err) { this._log.warn?.('[context] evaluate:', err); }
    }, TICK_INTERVAL_MS);
    this._evaluate();
  }

  stop() {
    if (this._tick) clearInterval(this._tick);
    this._tick = null;
  }

  getState() {
    const result = {};
    const now = Date.now();
    for (const [name, s] of Object.entries(this._state)) {
      const expired = (now - s.evaluated_at) > s.ttl_ms;
      result[name] = expired
        ? { ...s, value: null, confidence: 0, reason: 'ttl-expired' }
        : { ...s };
    }
    return result;
  }

  getStateValue(name) {
    const all = this.getState();
    return all[name] || null;
  }

  // M4-M5 預留：行為時序分析（最近 N 分鐘高強度工作 / 沒休息等）
  getRecentBehavior(_windowMs) {
    return null;
  }

  // 合併 plugin registry 與 InputMonitor 的 capability set
  // InputMonitor 是 Tier 1 核心，沒進 registry，但提供 keyboard_input 等 capability
  _collectActiveCapabilities() {
    const cap = new Set(this._registry?.getActiveCapabilities?.() || []);
    if (this._input && this._input.getStatus?.().healthy !== false) {
      const inputCaps = this._input.constructor?.capabilities || [];
      for (const c of inputCaps) cap.add(c);
    }
    return cap;
  }

  _evaluate() {
    const now = Date.now();
    const cap = this._collectActiveCapabilities();

    const power = snap(this._registry.getPluginByCapability('power_state'));
    const theme = snap(this._registry.getPluginByCapability('theme_state'));
    const fg    = snap(this._registry.getPluginByCapability('foreground_window'));
    const fs    = snap(this._registry.getPluginByCapability('fullscreen_state'));
    const sys   = snap(this._registry.getPluginByCapability('system_resource'));
    const audio = snap(this._registry.getPluginByCapability('audio_activity'));
    const mic   = snap(this._registry.getPluginByCapability('mic_recent_access'));
    const input = this._input?.snapshot();

    // ── screen_locked / on_battery ──
    if (cap.has('power_state') && power) {
      this._set('screen_locked', power.isLocked === true, 1.0, ['power_state'], now);
      this._set('on_battery', power.isOnBattery === true, 1.0, ['power_state'], now);
    } else {
      this._setMissing('screen_locked', now);
      this._setMissing('on_battery', now);
    }

    // ── dark_mode ──
    if (cap.has('theme_state') && theme) {
      this._set('dark_mode', theme.isDark === true, 1.0, ['theme_state'], now);
    } else {
      this._setMissing('dark_mode', now);
    }

    // ── in_ide ──
    if (cap.has('foreground_window') && fg?.foreground) {
      const exe = fg.foreground.app;
      const isIde = this._classification.ides.includes(exe);
      this._set('in_ide', isIde, isIde ? 0.9 : 0, isIde ? ['ide_exe'] : [], now);
    } else {
      this._setMissing('in_ide', now);
    }

    // ── in_meeting ──
    // 雙源融合策略：
    //   - 前景是通訊軟體：+0.5
    //   - 麥克風被持有：+0.5
    //   - mic + audio 雙信號（典型語音通話特徵）：+0.2
    //   覆蓋場景：
    //     Discord 通話 + Discord 前景 = 1.2 -> in_meeting (cap 1)
    //     Discord 通話 + 玩遊戲/寫 code（Discord 在背景）= 0.5 + 0.2 = 0.7 -> in_meeting
    //     Discord 開著沒通話 = 0（無 mic_active）-> 不誤觸發
    //     單獨錄音（mic 但無 audio）= 0.5 -> 不觸發 meeting_silence (min 0.7)
    if (cap.has('foreground_window') && (cap.has('mic_recent_access') || cap.has('audio_activity'))) {
      const sources = [];
      let confidence = 0;
      const fgExe = fg?.foreground?.app;
      const micActive = cap.has('mic_recent_access') && mic?.mic_recent_access_by?.length > 0;
      const audioActive = cap.has('audio_activity') && audio?.active_sessions?.length > 0;

      if (fgExe && this._classification.meeting_apps.includes(fgExe)) {
        sources.push('foreground_meeting_app');
        confidence += 0.5;
      }
      if (micActive) {
        sources.push('mic_active');
        confidence += 0.5;
      }
      if (micActive && audioActive) {
        sources.push('audio_mic_combo');
        confidence += 0.2;
      }

      this._set('in_meeting', confidence >= 0.6, confidence, sources, now);
    } else {
      this._setMissing('in_meeting', now);
    }

    // ── in_game ──
    if (cap.has('foreground_window') && cap.has('fullscreen_state')) {
      const sources = [];
      let confidence = 0;

      if (fs?.fullscreen?.active && fs.fullscreen.confidence > 0.7) {
        sources.push('fullscreen');
        confidence += 0.4;
      }

      if (cap.has('system_resource') && sys?.gpu_pct != null) {
        if (sys.gpu_pct > GPU_HIGH_THRESHOLD) {
          if (!this._gpuHighSince) this._gpuHighSince = now;
          if (now - this._gpuHighSince >= GPU_HIGH_DURATION_MS) {
            sources.push('gpu_high');
            confidence += 0.3;
          }
        } else {
          this._gpuHighSince = null;
        }
      }

      const fgExe = fg?.foreground?.app;
      if (fgExe && this._classification.games.includes(fgExe)) {
        sources.push('game_exe');
        confidence += 0.3;
      } else if (fgExe && this._classification.game_launchers.includes(fgExe)) {
        sources.push('game_launcher');
        confidence += 0.1;
      }

      this._set('in_game', confidence >= 0.6, confidence, sources, now);
    } else {
      this._setMissing('in_game', now);
    }

    // ── watching_video ──
    if (cap.has('audio_activity') && cap.has('foreground_window')) {
      const sources = [];
      let confidence = 0;

      const audioActive = audio?.active_sessions?.length > 0;
      const fgExe = fg?.foreground?.app;
      const fgTitle = (fg?.foreground?.title || '').toLowerCase();

      if (audioActive) { sources.push('audio_active'); confidence += 0.3; }

      const micFree = !cap.has('mic_recent_access') || !(mic?.mic_recent_access_by?.length > 0);
      if (audioActive && micFree) { sources.push('mic_free'); confidence += 0.1; }

      if (fgExe && this._classification.video_apps.includes(fgExe)) {
        sources.push('video_app');
        confidence += 0.4;
      }
      if (fgTitle && this._classification.video_keywords.some((k) => fgTitle.includes(k))) {
        sources.push('video_keyword');
        confidence += 0.3;
      }

      this._set('watching_video', confidence >= 0.6, confidence, sources, now);
    } else {
      this._setMissing('watching_video', now);
    }

    // ── focused_work ──
    if (cap.has('keyboard_input') && cap.has('foreground_window')) {
      const sources = [];
      let confidence = 0;

      if (input?.is_typing) { sources.push('typing'); confidence += 0.4; }
      if (input?.is_typing_intense) { sources.push('typing_intense'); confidence += 0.2; }

      const fgExe = fg?.foreground?.app;
      if (fgExe && this._classification.ides.includes(fgExe)) {
        sources.push('ide');
        confidence += 0.4;
      }

      this._set('focused_work', confidence >= 0.6, confidence, sources, now);
    } else {
      this._setMissing('focused_work', now);
    }
  }

  _set(name, value, confidence, sources, now) {
    const prev = this._state[name];
    const next = {
      value,
      confidence: round2(Math.min(confidence, 1)),
      sources,
      evaluated_at: now,
      ttl_ms: TTL_MS,
      reason: null,
    };
    this._state[name] = next;
    if (!prev || prev.value !== next.value) {
      this.emit('changed', { name, prev: prev?.value, current: next });
    }
  }

  _setMissing(name, now) {
    const prev = this._state[name];
    const next = {
      value: null,
      confidence: 0,
      sources: [],
      evaluated_at: now,
      ttl_ms: TTL_MS,
      reason: 'capability-missing',
    };
    this._state[name] = next;
    if (!prev || prev.value !== next.value) {
      this.emit('changed', { name, prev: prev?.value, current: next });
    }
  }
}

function snap(plugin) {
  if (!plugin) return null;
  try { return plugin.snapshot(); } catch (_e) { return null; }
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

function mergeClassification(input) {
  const empty = {
    ides: [], meeting_apps: [], video_apps: [], video_keywords: [],
    games: [], game_launchers: [],
  };
  return { ...empty, ...(input || {}) };
}

module.exports = { ContextStateTracker };
