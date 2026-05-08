// EventLogger — append-only JSONL 事件落地
//
// 對外契約：
//   - subscribe(source, eventNames)        外部模組可主動掛入感官層
//   - log(event)                           供 TriggerEngine / DialogueDirector 直寫
//   - flushNow() / purgeAll()              Debug 面板用
//   - getStatsSnapshot()                   IPC 回傳當前計數
//   - readRange(from, to)                  M7 預留
//
// 設計要點（依 plan §1.4 / §4.4 / §11）：
//   - events/*.jsonl 是 source of truth；stats.json 是 cache（程式重啟可重建）
//   - 1 秒 buffer flush，避免每事件 syscall
//   - 30 秒寫一次 stats.json
//   - 30 天 gzip 歸檔、60 天刪除
//   - 黑名單應用（settings.logger_blacklist）的 focus event 整個丟棄
//   - 視窗標題 / 名稱欄位過 redact

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const EventEmitter = require('node:events');
const { redactSensitive } = require('./redact');

const FLUSH_INTERVAL_MS = 1000;
const STATS_INTERVAL_MS = 30 * 1000;
const ROTATE_INTERVAL_MS = 60 * 60 * 1000;
const ARCHIVE_AFTER_DAYS = 30;
const PURGE_AFTER_DAYS = 60;
const REDACT_FIELDS = ['title', 'window_title'];

class EventLogger extends EventEmitter {
  constructor({ dataDir, blacklist = [], logger = console } = {}) {
    super();
    if (!dataDir) throw new Error('EventLogger: dataDir required');
    this._dataDir = dataDir;
    this._eventsDir = path.join(dataDir, 'events');
    this._statsPath = path.join(dataDir, 'stats.json');
    this._blacklist = new Set(blacklist.map((s) => String(s).toLowerCase()));
    this._log = logger;

    this._buffer = [];
    this._flushTimer = null;
    this._statsTimer = null;
    this._rotateTimer = null;
    this._currentDate = null;
    this._currentFd = null;
    this._lastError = null;

    this._lifetime = { first_seen: null, total_events: 0, total_triggers_fired: 0 };
    this._todayDate = null;
    this._todayCounters = emptyTodayCounters();

    this._subscriptions = [];
  }

  async start() {
    await fs.promises.mkdir(this._eventsDir, { recursive: true });
    await this._loadStatsCache();

    this._flushTimer = setInterval(() => {
      this._flush().catch((err) => this._onError(err));
    }, FLUSH_INTERVAL_MS);
    this._statsTimer = setInterval(() => {
      this._saveStats().catch((err) => this._log.warn?.('[EventLogger] stats save:', err));
    }, STATS_INTERVAL_MS);
    this._rotateTimer = setInterval(() => {
      this._rotate().catch((err) => this._log.warn?.('[EventLogger] rotate:', err));
    }, ROTATE_INTERVAL_MS);

    this._rotate().catch((err) => this._log.warn?.('[EventLogger] rotate (initial):', err));
  }

  async stop() {
    if (this._flushTimer) clearInterval(this._flushTimer);
    if (this._statsTimer) clearInterval(this._statsTimer);
    if (this._rotateTimer) clearInterval(this._rotateTimer);
    this._flushTimer = this._statsTimer = this._rotateTimer = null;

    this._unsubscribeAll();
    await this._flush();
    await this._saveStats();

    if (this._currentFd) {
      await this._currentFd.close().catch(() => {});
      this._currentFd = null;
    }
  }

  // 外部模組（如 InputMonitor、MonitorRegistry）可主動把多個事件名掛進來
  subscribe(source, eventMap) {
    if (!source || typeof source.on !== 'function') {
      throw new Error('EventLogger.subscribe: source must be EventEmitter-like');
    }
    const handlers = {};
    for (const [evtName, payloadType] of Object.entries(eventMap)) {
      const type = payloadType || evtName;
      const h = (payload) => this.log({ type, ...(payload || {}) });
      source.on(evtName, h);
      handlers[evtName] = h;
    }
    this._subscriptions.push({ source, handlers });
  }

  log(event) {
    if (!event || typeof event !== 'object') return;

    if (event.type === 'window:focus-changed' && this._isBlacklisted(event.app)) {
      return;
    }

    if (!event.t) {
      event.t = event.ended_at || event.started_at || Date.now();
    }

    for (const f of REDACT_FIELDS) {
      if (typeof event[f] === 'string') {
        event[f] = redactSensitive(event[f]);
      }
    }

    this._updateStats(event);
    this._buffer.push(event);
  }

  async flushNow() {
    await this._flush();
    await this._saveStats();
  }

  async purgeAll() {
    if (this._currentFd) {
      try { await this._currentFd.close(); } catch (_e) { /* ignore */ }
      this._currentFd = null;
    }
    this._currentDate = null;
    this._buffer = [];

    const files = await fs.promises.readdir(this._eventsDir).catch(() => []);
    await Promise.all(
      files.map((f) => fs.promises.unlink(path.join(this._eventsDir, f)).catch(() => {}))
    );

    this._lifetime = { first_seen: null, total_events: 0, total_triggers_fired: 0 };
    this._todayCounters = emptyTodayCounters();
    this._todayDate = null;

    await this._saveStats();
    this.emit('purged');
  }

  getStatsSnapshot() {
    const today = todayString();
    return {
      today,
      today_counters: {
        ...this._todayCounters,
        by_category: { ...this._todayCounters.by_category },
      },
      lifetime: { ...this._lifetime },
    };
  }

  async readRange(fromTs, toTs) {
    const files = (await fs.promises.readdir(this._eventsDir).catch(() => []))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(f))
      .sort();

    const out = [];
    for (const file of files) {
      const dateStr = file.slice(0, 10);
      const dayStart = new Date(dateStr).getTime();
      if (dayStart > toTs) break;
      if (dayStart + 24 * 3600 * 1000 < fromTs) continue;

      const full = path.join(this._eventsDir, file);
      const content = file.endsWith('.gz')
        ? zlib.gunzipSync(await fs.promises.readFile(full)).toString('utf-8')
        : await fs.promises.readFile(full, 'utf-8');

      for (const line of content.split('\n')) {
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.t >= fromTs && ev.t <= toTs) out.push(ev);
        } catch (_e) { /* skip malformed */ }
      }
    }
    return out;
  }

  async _flush() {
    if (this._buffer.length === 0) return;
    const today = todayString();

    if (today !== this._currentDate) {
      if (this._currentFd) {
        try { await this._currentFd.close(); } catch (_e) { /* ignore */ }
        this._currentFd = null;
      }
      this._currentDate = today;
      const filePath = path.join(this._eventsDir, `${today}.jsonl`);
      this._currentFd = await fs.promises.open(filePath, 'a');
    }

    const batch = this._buffer.splice(0);
    const lines = batch.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await this._currentFd.write(lines);
  }

  async _saveStats() {
    const snap = this.getStatsSnapshot();
    const tmp = this._statsPath + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(snap, null, 2));
    await fs.promises.rename(tmp, this._statsPath);
  }

  async _loadStatsCache() {
    try {
      const text = await fs.promises.readFile(this._statsPath, 'utf-8');
      const data = JSON.parse(text);
      if (data.lifetime) this._lifetime = data.lifetime;
      const today = todayString();
      if (data.today === today && data.today_counters) {
        this._todayCounters = { by_category: {}, ...data.today_counters };
        this._todayDate = today;
      }
    } catch (_e) {
      // 不存在或損毀 — 從零開始
    }
  }

  async _rotate() {
    const files = await fs.promises.readdir(this._eventsDir).catch(() => []);
    const now = Date.now();

    for (const file of files) {
      const m = file.match(/^(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/);
      if (!m) continue;
      const ageDays = (now - new Date(m[1]).getTime()) / (24 * 3600 * 1000);
      const full = path.join(this._eventsDir, file);

      if (ageDays > PURGE_AFTER_DAYS) {
        await fs.promises.unlink(full).catch(() => {});
      } else if (ageDays > ARCHIVE_AFTER_DAYS && !file.endsWith('.gz')) {
        await this._gzipFile(full);
      }
    }
  }

  _gzipFile(filePath) {
    return new Promise((resolve, reject) => {
      const gzPath = filePath + '.gz';
      const src = fs.createReadStream(filePath);
      const gz = zlib.createGzip();
      const dst = fs.createWriteStream(gzPath);
      src.on('error', reject);
      gz.on('error', reject);
      dst.on('error', reject);
      dst.on('close', () => {
        fs.promises.unlink(filePath).then(resolve).catch(reject);
      });
      src.pipe(gz).pipe(dst);
    });
  }

  _updateStats(event) {
    const today = todayString();
    if (today !== this._todayDate) {
      this._todayCounters = emptyTodayCounters();
      this._todayDate = today;
    }

    if (!this._lifetime.first_seen) {
      this._lifetime.first_seen = new Date().toISOString();
    }
    this._lifetime.total_events++;

    switch (event.type) {
      case 'typing-burst':
        this._todayCounters.keys += event.key_count || 0;
        break;
      case 'click':
        this._todayCounters.clicks++;
        break;
      case 'click-burst':
        // click 已在 'click' 計過，不重複
        break;
      case 'trigger:fired':
        this._todayCounters.triggers_fired++;
        this._lifetime.total_triggers_fired++;
        if (event.category) {
          this._todayCounters.by_category[event.category] =
            (this._todayCounters.by_category[event.category] || 0) + 1;
        }
        break;
      default:
        break;
    }
  }

  _isBlacklisted(app) {
    if (!app) return false;
    return this._blacklist.has(String(app).toLowerCase());
  }

  _unsubscribeAll() {
    for (const { source, handlers } of this._subscriptions) {
      for (const [evtName, h] of Object.entries(handlers)) {
        try { source.removeListener(evtName, h); } catch (_e) { /* ignore */ }
      }
    }
    this._subscriptions = [];
  }

  _onError(err) {
    this._lastError = err;
    this._log.error?.('[EventLogger] error:', err);
  }
}

function emptyTodayCounters() {
  return { keys: 0, clicks: 0, triggers_fired: 0, by_category: {} };
}

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = { EventLogger };
