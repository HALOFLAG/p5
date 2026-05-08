// tier3-clipboard-watcher — 剪貼簿變動偵測
//
// 採樣：2 秒 / 次（Electron clipboard.readText + sha1 比對）
// emit: clipboard:changed { hash, length, has_url, has_email_pattern }
//
// 安全：raw text 永不外傳、永不寫 log，只記 metadata。

const crypto = require('node:crypto');
const { MonitorPlugin } = require('./plugin-base');

const POLL_INTERVAL_MS = 2000;
const URL_RE = /\bhttps?:\/\//i;
const EMAIL_RE = /\b[\w.-]+@[\w.-]+\.\w+\b/;

class Tier3ClipboardWatcherPlugin extends MonitorPlugin {
  static id = 'tier3-clipboard-watcher';
  static tier = 3;
  static capabilities = ['clipboard_metadata'];
  static description = '剪貼簿變動偵測（永不傳 raw text）';

  constructor(opts) {
    super(opts);
    this._clipboard = null;
    this._poll = null;
    this._lastHash = null;
    this._lastChangedAt = null;
  }

  async _onStart() {
    this._clipboard = require('electron').clipboard;
    this._poll = setInterval(() => this._tick(), POLL_INTERVAL_MS);
  }

  async _onStop() {
    if (this._poll) clearInterval(this._poll);
    this._poll = null;
  }

  _tick() {
    try {
      const text = this._clipboard.readText();
      this._heartbeat();
      if (!text) return;

      const hash = crypto.createHash('sha1').update(text).digest('hex');
      if (hash === this._lastHash) return;
      this._lastHash = hash;
      this._lastChangedAt = Date.now();

      this.emit('clipboard:changed', {
        t: this._lastChangedAt,
        hash,
        length: text.length,
        has_url: URL_RE.test(text),
        has_email_pattern: EMAIL_RE.test(text),
      });
    } catch (err) {
      this._markUnhealthy('clipboard-read-error', err);
    }
  }

  snapshot() {
    return {
      last_hash: this._lastHash,
      last_changed_at: this._lastChangedAt,
    };
  }
}

module.exports = { Plugin: Tier3ClipboardWatcherPlugin };
