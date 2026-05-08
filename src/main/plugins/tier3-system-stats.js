// tier3-system-stats — CPU/GPU/RAM 採樣
//
// 採樣：30 秒 / 次（systeminformation）
//   原 5 秒：events 量級過高且系統指標非行為畫像核心
//   30 秒：in_game 判定的 GPU 持續 30 秒閾值仍能滿足，events 量級降 6 倍
// emit: system:stats-tick { cpu_pct, gpu_pct, ram_pct, sampled_at }

const { MonitorPlugin } = require('./plugin-base');

const POLL_INTERVAL_MS = 30 * 1000;

class Tier3SystemStatsPlugin extends MonitorPlugin {
  static id = 'tier3-system-stats';
  static tier = 3;
  static capabilities = ['system_resource'];
  static description = 'CPU/GPU/RAM 採樣';

  constructor(opts) {
    super(opts);
    this._si = null;
    this._poll = null;
    this._lastStats = null;
  }

  async _onStart() {
    this._si = require('systeminformation');
    await this._sample();
    this._poll = setInterval(() => {
      this._sample().catch((err) => this._markUnhealthy('sample-error', err));
    }, POLL_INTERVAL_MS);
  }

  async _onStop() {
    if (this._poll) clearInterval(this._poll);
    this._poll = null;
  }

  async _sample() {
    const [cpu, mem, gfx] = await Promise.all([
      this._si.currentLoad().catch(() => null),
      this._si.mem().catch(() => null),
      this._si.graphics().catch(() => ({ controllers: [] })),
    ]);
    this._heartbeat();

    const cpuPct = cpu ? round1(cpu.currentLoad || 0) : null;
    const ramPct = mem && mem.total > 0 ? round1((mem.active / mem.total) * 100) : null;
    const gpuController = (gfx?.controllers || []).find((c) => c.utilizationGpu != null);
    const gpuPct = gpuController?.utilizationGpu != null ? round1(gpuController.utilizationGpu) : null;

    const now = Date.now();
    this._lastStats = {
      cpu_pct: cpuPct,
      gpu_pct: gpuPct,
      ram_pct: ramPct,
      sampled_at: now,
    };
    this.emit('system:stats-tick', { t: now, ...this._lastStats });
  }

  snapshot() {
    return this._lastStats || { cpu_pct: null, gpu_pct: null, ram_pct: null, sampled_at: null };
  }
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

module.exports = { Plugin: Tier3SystemStatsPlugin };
