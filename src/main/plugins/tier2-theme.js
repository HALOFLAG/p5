// tier2-theme — Electron nativeTheme 訂閱
//
// emit: theme:dark-mode-changed { isDark }

const { MonitorPlugin } = require('./plugin-base');

class Tier2ThemePlugin extends MonitorPlugin {
  static id = 'tier2-theme';
  static tier = 2;
  static capabilities = ['theme_state'];
  static description = '系統深色模式變化';

  constructor(opts) {
    super(opts);
    this._nativeTheme = null;
    this._handler = null;
    this._isDark = false;
    this._tickInterval = null;
  }

  async _onStart() {
    const { nativeTheme } = require('electron');
    this._nativeTheme = nativeTheme;
    this._isDark = nativeTheme.shouldUseDarkColors;

    this._handler = () => {
      const isDark = nativeTheme.shouldUseDarkColors;
      if (isDark !== this._isDark) {
        this._isDark = isDark;
        this._heartbeat();
        this.emit('theme:dark-mode-changed', { t: Date.now(), isDark });
      }
    };
    nativeTheme.on('updated', this._handler);

    this._tickInterval = setInterval(() => this._heartbeat(), 30 * 1000);
  }

  async _onStop() {
    if (this._tickInterval) clearInterval(this._tickInterval);
    this._tickInterval = null;
    if (this._nativeTheme && this._handler) {
      try { this._nativeTheme.removeListener('updated', this._handler); } catch (_e) {}
    }
    this._handler = null;
  }

  snapshot() {
    return { isDark: this._isDark };
  }
}

module.exports = { Plugin: Tier2ThemePlugin };
