// tier2-power — Electron powerMonitor 訂閱
//
// emit:
//   power:lock / power:unlock / power:sleep / power:resume / power:ac / power:battery

const { MonitorPlugin } = require('./plugin-base');

const EVENT_MAP = {
  'lock-screen':   'power:lock',
  'unlock-screen': 'power:unlock',
  'suspend':       'power:sleep',
  'resume':        'power:resume',
  'on-ac':         'power:ac',
  'on-battery':    'power:battery',
};

class Tier2PowerPlugin extends MonitorPlugin {
  static id = 'tier2-power';
  static tier = 2;
  static capabilities = ['power_state'];
  static description = '螢幕鎖屏 / 電源狀態（Electron powerMonitor）';

  constructor(opts) {
    super(opts);
    this._powerMonitor = null;
    this._handlers = {};
    this._state = {
      isLocked: false,
      isOnBattery: false,
      lastEvent: null,
      lastEventAt: null,
    };
    this._tickInterval = null;
  }

  async _onStart() {
    const { powerMonitor } = require('electron');
    this._powerMonitor = powerMonitor;

    for (const [src, dst] of Object.entries(EVENT_MAP)) {
      const h = () => this._onEvent(src, dst);
      this._handlers[src] = h;
      powerMonitor.on(src, h);
    }

    try {
      this._state.isOnBattery = powerMonitor.isOnBatteryPower();
    } catch (_e) { /* not fatal */ }

    // power 事件稀疏，固定 30 秒 heartbeat 維持 healthy
    this._tickInterval = setInterval(() => this._heartbeat(), 30 * 1000);
  }

  async _onStop() {
    if (this._tickInterval) clearInterval(this._tickInterval);
    this._tickInterval = null;
    if (this._powerMonitor) {
      for (const [src, h] of Object.entries(this._handlers)) {
        try { this._powerMonitor.removeListener(src, h); } catch (_e) {}
      }
    }
    this._handlers = {};
  }

  _onEvent(srcEvent, dstEvent) {
    const now = Date.now();
    this._state.lastEvent = dstEvent;
    this._state.lastEventAt = now;
    if (dstEvent === 'power:lock') this._state.isLocked = true;
    if (dstEvent === 'power:unlock') this._state.isLocked = false;
    if (dstEvent === 'power:battery') this._state.isOnBattery = true;
    if (dstEvent === 'power:ac') this._state.isOnBattery = false;

    this._heartbeat();
    this.emit(dstEvent, { t: now });
  }

  snapshot() {
    return { ...this._state };
  }
}

module.exports = { Plugin: Tier2PowerPlugin };
