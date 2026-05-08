// tier2-screen — Electron screen 模組訂閱
//
// emit:
//   screen:added / screen:removed / screen:metrics-changed

const { MonitorPlugin } = require('./plugin-base');

class Tier2ScreenPlugin extends MonitorPlugin {
  static id = 'tier2-screen';
  static tier = 2;
  static capabilities = ['screen_topology'];
  static description = '多螢幕拓撲變化';

  constructor(opts) {
    super(opts);
    this._screen = null;
    this._handlers = {};
    this._tickInterval = null;
  }

  async _onStart() {
    const { screen } = require('electron');
    this._screen = screen;

    const map = {
      'display-added': 'screen:added',
      'display-removed': 'screen:removed',
      'display-metrics-changed': 'screen:metrics-changed',
    };

    for (const [src, dst] of Object.entries(map)) {
      const h = (_e, display, changedMetrics) => {
        this._heartbeat();
        this.emit(dst, {
          t: Date.now(),
          display: simplifyDisplay(display),
          ...(changedMetrics ? { changedMetrics } : {}),
        });
      };
      this._handlers[src] = h;
      screen.on(src, h);
    }

    this._tickInterval = setInterval(() => this._heartbeat(), 30 * 1000);
  }

  async _onStop() {
    if (this._tickInterval) clearInterval(this._tickInterval);
    this._tickInterval = null;
    if (this._screen) {
      for (const [src, h] of Object.entries(this._handlers)) {
        try { this._screen.removeListener(src, h); } catch (_e) {}
      }
    }
    this._handlers = {};
  }

  snapshot() {
    if (!this._screen) return { displays: [], primary_id: null };
    try {
      return {
        displays: this._screen.getAllDisplays().map(simplifyDisplay),
        primary_id: this._screen.getPrimaryDisplay()?.id ?? null,
      };
    } catch (_e) {
      return { displays: [], primary_id: null };
    }
  }
}

function simplifyDisplay(d) {
  if (!d) return null;
  return {
    id: d.id,
    bounds: d.bounds,
    workArea: d.workArea,
    scaleFactor: d.scaleFactor,
    rotation: d.rotation,
    internal: d.internal,
  };
}

module.exports = { Plugin: Tier2ScreenPlugin };
