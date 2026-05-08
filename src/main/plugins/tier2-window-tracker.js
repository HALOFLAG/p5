// tier2-window-tracker — 前景視窗 + 全螢幕偵測（合併在同一輪詢避免雙重開銷）
//
// 採樣：1 秒輪詢 get-windows
// emit:
//   window:focus-changed { app, title, pid, exe_path }
//   fullscreen:state     { active, confidence, app, duration_ms? }
//
// fullscreen confidence（M3 v1）：
//   + 視窗大小覆蓋 work area >= 95%       0.5
//   + 視窗大小覆蓋整個 screen bounds      0.3
//   未來可加 GPU 高使用 / topmost 進一步提分

const { MonitorPlugin } = require('./plugin-base');

const POLL_INTERVAL_MS = 1000;
const FULLSCREEN_CONFIDENCE_THRESHOLD = 0.6;

class Tier2WindowTrackerPlugin extends MonitorPlugin {
  static id = 'tier2-window-tracker';
  static tier = 2;
  static capabilities = ['foreground_window', 'fullscreen_state'];
  static description = '前景視窗 + 全螢幕偵測';

  constructor(opts) {
    super(opts);
    this._activeWindow = null;
    this._screen = null;
    this._poll = null;
    this._lastFocus = null;
    this._lastFullscreen = { active: false, confidence: 0, since: null };
  }

  async _onStart() {
    // get-windows 9.x 是 ESM-only 套件（"type": "module"），用 dynamic import
    // 跨 Electron / 純 Node 兩個 runtime 行為一致
    let gw;
    try {
      gw = await import('get-windows');
    } catch (err) {
      throw new Error(`import('get-windows') failed: ${err.message}`);
    }

    // ESM 可能放 default 或 named export
    this._activeWindow =
      (typeof gw.activeWindow === 'function' && gw.activeWindow) ||
      (typeof gw.default?.activeWindow === 'function' && gw.default.activeWindow) ||
      (typeof gw.default === 'function' && gw.default) ||
      null;

    if (typeof this._activeWindow !== 'function') {
      const keys = Object.keys(gw).join(',');
      throw new Error(
        `get-windows: activeWindow not callable (top-level keys=${keys}, ` +
        `default type=${typeof gw.default})`
      );
    }

    const { screen } = require('electron');
    this._screen = screen;

    // 第一次 tick 不阻擋啟動：失敗只標 unhealthy，plugin 仍進 _plugins Map
    this._tick().catch((err) => this._markUnhealthy('initial-tick-error', err));
    this._poll = setInterval(() => {
      this._tick().catch((err) => this._markUnhealthy('tick-error', err));
    }, POLL_INTERVAL_MS);
  }

  async _onStop() {
    if (this._poll) clearInterval(this._poll);
    this._poll = null;
  }

  async _tick() {
    let win;
    try {
      win = await this._activeWindow();
    } catch (err) {
      this._markUnhealthy('activeWindow-error', err);
      return;
    }
    this._heartbeat();
    if (!win) return;

    const exePath = win.owner?.path || '';
    const exe = (exePath.split(/[\\/]/).pop() || win.owner?.name || 'unknown').toLowerCase();
    const newFocus = {
      app: exe,
      title: win.title || '',
      pid: win.owner?.processId,
      exe_path: exePath,
    };

    if (
      !this._lastFocus
      || this._lastFocus.app !== newFocus.app
      || this._lastFocus.title !== newFocus.title
    ) {
      this._lastFocus = newFocus;
      this.emit('window:focus-changed', { t: Date.now(), ...newFocus });
    }

    const fsConf = this._calcFullscreenConfidence(win);
    const fsActive = fsConf >= FULLSCREEN_CONFIDENCE_THRESHOLD;
    const now = Date.now();

    if (fsActive !== this._lastFullscreen.active) {
      if (fsActive) {
        this._lastFullscreen = { active: true, confidence: fsConf, since: now };
        this.emit('fullscreen:state', { t: now, active: true, confidence: round2(fsConf), app: newFocus.app });
      } else {
        const duration = this._lastFullscreen.since ? now - this._lastFullscreen.since : 0;
        this._lastFullscreen = { active: false, confidence: fsConf, since: null };
        this.emit('fullscreen:state', { t: now, active: false, confidence: round2(fsConf), duration_ms: duration });
      }
    } else {
      this._lastFullscreen.confidence = fsConf;
    }
  }

  _calcFullscreenConfidence(win) {
    if (!win.bounds) return 0;
    const { x, y, width, height } = win.bounds;
    if (width <= 0 || height <= 0) return 0;

    let display;
    try {
      display = this._screen.getDisplayMatching({ x, y, width, height });
    } catch (_e) {
      display = this._screen.getPrimaryDisplay();
    }
    if (!display) return 0;

    let conf = 0;
    const winArea = width * height;
    const workAreaArea = display.workArea.width * display.workArea.height;
    const screenArea = display.bounds.width * display.bounds.height;

    if (workAreaArea > 0 && winArea / workAreaArea >= 0.95) conf += 0.5;
    if (screenArea > 0 && winArea / screenArea >= 0.99) conf += 0.3;

    return Math.min(conf, 1);
  }

  snapshot() {
    return {
      foreground: this._lastFocus,
      fullscreen: { ...this._lastFullscreen },
    };
  }
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

module.exports = { Plugin: Tier2WindowTrackerPlugin };
