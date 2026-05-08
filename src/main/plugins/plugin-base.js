// MonitorPlugin — Tier 2/3 感官層的抽象基類
//
// 子類必須宣告 static metadata：
//   static id            string  唯一識別（如 'tier3-audio-session'）
//   static tier          1 | 2 | 3
//   static capabilities  string[] 對外暴露的能力（如 ['audio_activity']）
//   static dependsOn     string[] 依賴的其他 plugin id（少用）
//   static description   string
//
// 子類覆寫 _onStart / _onStop / snapshot；運轉期間定期呼叫 this._heartbeat()。
// 失敗時呼叫 this._markUnhealthy(reason, err) — registry 會看到，不會連鎖崩潰。

const EventEmitter = require('node:events');

const HEARTBEAT_INTERVAL_MS = 30 * 1000;

class MonitorPlugin extends EventEmitter {
  static id = '';
  static tier = 0;
  static capabilities = [];
  static dependsOn = [];
  static description = '';

  constructor({ config = {}, logger = console } = {}) {
    super();
    this._config = config;
    this._log = logger;

    this._started = false;
    this._healthy = false;
    this._lastError = null;
    this._lastHeartbeat = null;
    this._heartbeatInterval = null;
  }

  async start() {
    if (this._started) return;
    this._lastError = null;
    try {
      await this._onStart();
      this._started = true;
      this._healthy = true;
      this._heartbeat();
      this._heartbeatInterval = setInterval(() => this._heartbeat(), HEARTBEAT_INTERVAL_MS);
      this.emit('started');
    } catch (err) {
      this._lastError = err;
      this._healthy = false;
      this._log.warn?.(`[plugin:${this.constructor.id}] start failed:`, err);
      this.emit('plugin:degraded', { reason: 'start-failed', error: String(err) });
      throw err;
    }
  }

  async stop() {
    if (!this._started) return;
    if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);
    this._heartbeatInterval = null;

    try {
      await this._onStop();
    } catch (err) {
      this._log.warn?.(`[plugin:${this.constructor.id}] stop error:`, err);
    }
    this._started = false;
    this._healthy = false;
    this.emit('stopped');
  }

  snapshot() {
    return null; // 子類覆寫
  }

  getStatus() {
    return {
      id: this.constructor.id,
      tier: this.constructor.tier,
      capabilities: this.constructor.capabilities || [],
      dependsOn: this.constructor.dependsOn || [],
      enabled: this._started,
      healthy: this._healthy,
      lastHeartbeat: this._lastHeartbeat,
      lastError: this._lastError ? String(this._lastError) : null,
    };
  }

  _heartbeat() {
    this._lastHeartbeat = Date.now();
  }

  _markUnhealthy(reason, err = null) {
    this._healthy = false;
    if (err) this._lastError = err;
    this._log.warn?.(`[plugin:${this.constructor.id}] degraded (${reason}):`, err || '');
    this.emit('plugin:degraded', { reason, error: err ? String(err) : null });
  }

  // 子類覆寫
  async _onStart() {}
  async _onStop() {}
}

module.exports = { MonitorPlugin, HEARTBEAT_INTERVAL_MS };
