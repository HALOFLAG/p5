// MonitorRegistry — Plugin 載入與管理中樞
//
// 對外契約：
//   - start() / stop()                           lifecycle
//   - getActiveCapabilities() / hasCapability()  讓 ContextStateTracker / TriggerEngine 查詢
//   - getPluginByCapability(cap)                 拿到提供某 capability 的 plugin（M3 一對一）
//   - snapshot() / getStatus()                   Debug 面板用
//   - 'plugin-event' { plugin, event_name, payload }    EventLogger 訂閱
//   - 'plugin:degraded' { plugin, reason, error }       上層通知
//
// 啟用解析：plugins.json 的 monitor_level 提供 tier 預設，個別 plugin override 覆蓋。
// 失敗策略：載入或啟動失敗只在 log 寫 warning，繼續啟動其他 plugin。
// 心跳：每 60 秒檢查；超過 90 秒沒心跳標 unhealthy，ContextStateTracker 自動 fail-open。

const EventEmitter = require('node:events');

const HEALTH_CHECK_INTERVAL_MS = 60 * 1000;
const HEARTBEAT_STALE_THRESHOLD_MS = 90 * 1000;

const TIER_PRESETS = {
  'tier1':     { 2: false, 3: false },
  'tier1+2':   { 2: true,  3: false },
  'tier1+2+3': { 2: true,  3: true  },
  'custom':    { 2: false, 3: false },
};

// 已知 plugin id → 模組路徑。
// 子類檔案在 Phase 2 後續實作；此處先列出全集，缺的會在 require 時 catch 過濾。
const PLUGIN_MODULES = {
  'tier2-power':            './plugins/tier2-power',
  'tier2-screen':           './plugins/tier2-screen',
  'tier2-theme':            './plugins/tier2-theme',
  'tier2-window-tracker':   './plugins/tier2-window-tracker',
  'tier3-system-stats':     './plugins/tier3-system-stats',
  'tier3-audio-session':    './plugins/tier3-audio-session',
  'tier3-mic-cam-activity': './plugins/tier3-mic-cam-activity',
  'tier3-clipboard-watcher':'./plugins/tier3-clipboard-watcher',
};

const NON_FORWARDED_EVENTS = new Set([
  'started', 'stopped', 'plugin:degraded',
  'newListener', 'removeListener', 'error',
]);

class MonitorRegistry extends EventEmitter {
  constructor({ pluginsConfig = {}, logger = console } = {}) {
    super();
    this._log = logger;
    this._pluginsConfig = pluginsConfig;
    this._plugins = new Map();
    this._failures = new Map();
    this._healthTimer = null;
  }

  async start() {
    const enabledMap = this._resolveEnabledMap();

    for (const [id, isEnabled] of Object.entries(enabledMap)) {
      const tier = parseTierFromId(id);

      if (!isEnabled) {
        this._failures.set(id, {
          id, tier, capabilities: [], dependsOn: [],
          enabled: false, healthy: false, lastError: null, lastHeartbeat: null,
          failureReason: 'disabled-by-config',
        });
        continue;
      }

      const modPath = PLUGIN_MODULES[id];
      if (!modPath) continue;

      let PluginClass = null;
      let loadError = null;
      try {
        const mod = require(modPath);
        PluginClass = mod.Plugin || mod.default || mod;
        if (typeof PluginClass !== 'function') throw new Error('not a class');
      } catch (err) {
        loadError = err;
      }

      if (loadError || !PluginClass) {
        this._log.warn?.(`[registry] load ${id} skipped: ${loadError?.message || 'unknown'}`);
        this._failures.set(id, {
          id, tier, capabilities: [], dependsOn: [],
          enabled: false, healthy: false,
          lastError: loadError?.message || 'load failed',
          lastHeartbeat: null,
          failureReason: 'load-failed',
        });
        continue;
      }

      let inst = null;
      try {
        inst = new PluginClass({
          config: this._getPluginConfig(id),
          logger: this._log,
        });
        this._wirePluginEvents(id, inst);
        await inst.start();
        this._plugins.set(id, inst);
        this._log.info?.(
          `[registry] started ${id} -> caps=[${(PluginClass.capabilities || []).join(',')}]`
        );
      } catch (err) {
        const stackHead = err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : '';
        this._log.warn?.(`[registry] start ${id} failed: ${err.message}\n${stackHead}`);
        this._failures.set(id, {
          id, tier, capabilities: PluginClass.capabilities || [],
          dependsOn: PluginClass.dependsOn || [],
          enabled: false, healthy: false,
          lastError: err.message,
          lastErrorStack: stackHead,
          lastHeartbeat: null,
          failureReason: 'start-failed',
        });
        try { await inst?.stop?.(); } catch (_e) { /* ignore */ }
      }
    }

    this._healthTimer = setInterval(() => this._checkHealth(), HEALTH_CHECK_INTERVAL_MS);
    this.emit('started');
  }

  async stop() {
    if (this._healthTimer) clearInterval(this._healthTimer);
    this._healthTimer = null;

    for (const [id, inst] of this._plugins) {
      try { await inst.stop(); } catch (err) {
        this._log.warn?.(`[registry] stop ${id}:`, err.message);
      }
    }
    this._plugins.clear();
    this.emit('stopped');
  }

  getActiveCapabilities() {
    const set = new Set();
    for (const [, inst] of this._plugins) {
      if (inst._healthy) {
        for (const cap of inst.constructor.capabilities || []) set.add(cap);
      }
    }
    return set;
  }

  hasCapability(cap) {
    for (const [, inst] of this._plugins) {
      if (inst._healthy && (inst.constructor.capabilities || []).includes(cap)) return true;
    }
    return false;
  }

  getPluginByCapability(cap) {
    for (const [, inst] of this._plugins) {
      if (inst._healthy && (inst.constructor.capabilities || []).includes(cap)) return inst;
    }
    return null;
  }

  getPlugin(id) {
    return this._plugins.get(id) || null;
  }

  snapshot() {
    const result = {};
    for (const [id, inst] of this._plugins) {
      result[id] = {
        status: inst.getStatus(),
        snapshot: safeCall(() => inst.snapshot()),
      };
    }
    return result;
  }

  getStatus() {
    const result = {};
    for (const [id, inst] of this._plugins) {
      result[id] = inst.getStatus();
    }
    for (const [id, fail] of this._failures) {
      if (!result[id]) result[id] = fail;
    }
    return result;
  }

  _resolveEnabledMap() {
    const level = this._pluginsConfig.monitor_level || 'tier1+2+3';
    const preset = TIER_PRESETS[level] || TIER_PRESETS['custom'];
    const overrides = this._pluginsConfig.plugins || {};

    const result = {};
    for (const id of Object.keys(PLUGIN_MODULES)) {
      const m = id.match(/^tier(\d+)/);
      const tier = m ? parseInt(m[1], 10) : 0;
      const presetEnabled = preset[tier] ?? false;
      const override = overrides[id];
      result[id] = override && typeof override.enabled === 'boolean'
        ? override.enabled
        : presetEnabled;
    }
    return result;
  }

  _getPluginConfig(id) {
    const all = this._pluginsConfig.plugins || {};
    return all[id] || {};
  }

  _wirePluginEvents(id, inst) {
    // 把 plugin 的所有 event（除 lifecycle）forward 為 registry 的 'plugin-event'
    const origEmit = inst.emit.bind(inst);
    inst.emit = (eventName, payload, ...rest) => {
      const handled = origEmit(eventName, payload, ...rest);
      if (!NON_FORWARDED_EVENTS.has(eventName)) {
        this.emit('plugin-event', { plugin: id, event_name: eventName, payload });
      }
      return handled;
    };

    inst.on('plugin:degraded', (info) => {
      this.emit('plugin:degraded', { plugin: id, ...info });
    });
  }

  _checkHealth() {
    const now = Date.now();
    for (const [id, inst] of this._plugins) {
      if (!inst._healthy) continue;
      if (!inst._lastHeartbeat) continue;
      if (now - inst._lastHeartbeat > HEARTBEAT_STALE_THRESHOLD_MS) {
        inst._markUnhealthy('heartbeat-stale');
        this.emit('plugin:degraded', { plugin: id, reason: 'heartbeat-stale' });
      }
    }
  }
}

function safeCall(fn) {
  try { return fn(); } catch (_e) { return null; }
}

function parseTierFromId(id) {
  const m = String(id).match(/^tier(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

module.exports = { MonitorRegistry, PLUGIN_MODULES, TIER_PRESETS };
