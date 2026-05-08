// tier3-audio-session — Audio 活動偵測（M3 降目標版）
//
// 設計妥協（plan §11 / §12 風險矩陣）：
//   完整 WASAPI session 列舉（IAudioMeterInformation）需要大量 koffi + COM
//   呼叫，工程量過重。M3 採弱判定：
//     - 1 秒輪詢「已知影音應用 process」是否存活
//     - hysteresis: 存活 ≥ 3 秒才算 started；連 5 秒不見才算 ended
//     - emit audio:session-started / audio:session-ended
//   ContextStateTracker 對 watching_video 採雙源融合（audio + 前景視窗），
//   弱判定足以驅動。M5/M6 時可升級為真正 WASAPI 列舉。
//
// koffi smoke test：載入 kernel32.dll 並呼叫 GetCurrentProcessId 驗證 native
//   bridge 可用，為未來 WASAPI 路徑鋪路。

const { MonitorPlugin } = require('./plugin-base');

const POLL_INTERVAL_MS = 1000;
const ACTIVE_THRESHOLD_MS = 3000;
const SILENT_THRESHOLD_MS = 5000;

const KNOWN_AUDIO_APPS = new Set([
  // 影音播放
  'spotify.exe',
  'vlc.exe',
  'mpc-hc.exe',
  'mpc-hc64.exe',
  'potplayer.exe',
  'potplayermini64.exe',
  'mpv.exe',
  'aimp.exe',
  'foobar2000.exe',
  'wmplayer.exe',
  // 瀏覽器（精度低但涵蓋 YouTube/Bilibili 等網頁影音）
  'chrome.exe',
  'msedge.exe',
  'firefox.exe',
  'brave.exe',
  // 通訊軟體（語音/視訊通話也算 audio activity）
  'discord.exe',
  'teams.exe',
  'ms-teams.exe',
  'zoom.exe',
  'cpthost.exe',
  'slack.exe',
  'skype.exe',
  'webex.exe',
  'webexmta.exe',
  'lync.exe',
]);

class Tier3AudioSessionPlugin extends MonitorPlugin {
  static id = 'tier3-audio-session';
  static tier = 3;
  static capabilities = ['audio_activity'];
  static description = 'Audio 活動偵測（M3 簡化版：依已知影音 exe）';

  constructor(opts) {
    super(opts);
    this._si = null;
    this._poll = null;
    this._sessions = new Map(); // exe → { since, started, lastSeen }
    this._smokeTestPassed = false;
  }

  async _onStart() {
    this._si = require('systeminformation');
    this._smokeTestPassed = await this._koffiSmokeTest();
    if (!this._smokeTestPassed) {
      this._log.warn?.('[audio-session] koffi smoke test failed; native path disabled');
    }

    this._poll = setInterval(() => {
      this._tick().catch((err) => this._markUnhealthy('tick-error', err));
    }, POLL_INTERVAL_MS);
  }

  async _onStop() {
    if (this._poll) clearInterval(this._poll);
    this._poll = null;
    this._sessions.clear();
  }

  async _koffiSmokeTest() {
    try {
      const koffi = require('koffi');
      const kernel32 = koffi.load('kernel32.dll');
      const GetCurrentProcessId = kernel32.func('uint32 GetCurrentProcessId()');
      const pid = GetCurrentProcessId();
      this._log.info?.(`[audio-session] koffi smoke test pid=${pid}`);
      return typeof pid === 'number' && pid > 0;
    } catch (err) {
      this._log.warn?.('[audio-session] koffi smoke test exception:', err.message);
      return false;
    }
  }

  async _tick() {
    let processes;
    try {
      processes = await this._si.processes();
    } catch (err) {
      this._markUnhealthy('processes-error', err);
      return;
    }
    this._heartbeat();

    const now = Date.now();
    const seen = new Set();

    for (const p of processes.list || []) {
      const exe = (p.name || '').toLowerCase();
      if (!KNOWN_AUDIO_APPS.has(exe)) continue;
      seen.add(exe);

      let info = this._sessions.get(exe);
      if (!info) {
        info = { since: now, started: false, lastSeen: now };
        this._sessions.set(exe, info);
      }
      info.lastSeen = now;
    }

    for (const [exe, info] of this._sessions) {
      const aliveDuration = now - info.since;
      if (!info.started && seen.has(exe) && aliveDuration >= ACTIVE_THRESHOLD_MS) {
        info.started = true;
        this.emit('audio:session-started', { t: now, exe });
        continue;
      }
      if (info.started && now - info.lastSeen > SILENT_THRESHOLD_MS) {
        this.emit('audio:session-ended', {
          t: now,
          exe,
          duration_ms: now - info.since,
        });
        this._sessions.delete(exe);
        continue;
      }
      if (!info.started && !seen.has(exe)) {
        // 還沒進入 started，process 也不見了 → 直接清掉不 emit
        this._sessions.delete(exe);
      }
    }
  }

  snapshot() {
    const active = [];
    for (const [exe, info] of this._sessions) {
      if (info.started) active.push({ exe, since: info.since });
    }
    return {
      smoke_test_passed: this._smokeTestPassed,
      active_sessions: active,
    };
  }
}

module.exports = { Plugin: Tier3AudioSessionPlugin };
