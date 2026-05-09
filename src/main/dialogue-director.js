// DialogueDirector — 輸出層（行為決策→實際話）
//
// 對外契約：
//   - load()                       啟動時讀 recent-dialogues.json
//   - handleFire({ rule_name, category, context })
//   - invalidatePersonaCache()     設定切人格時呼叫
//   - getRecentEntries()           Debug 面板用
//
// 設計要點（plan §8 Phase 3）：
//   - 從 active persona 載入 dialogues.json，category → sequences
//   - recent ring buffer (50)：過濾近 50 句不重複；不夠則 fallback 全集
//   - 變數插值在 line.text 上跑
//   - 寫 EventLogger trigger:fired
//   - 透過 sender callback 推送 dialogue:show（main.js 接 mainWindow.webContents.send）

const fs = require('node:fs');
const path = require('node:path');
const { interpolate, ALLOWED_VARS } = require('./variable-interpolator');
const { redactSensitive } = require('./redact');

const RING_SIZE = 50;
const VAR_SCAN_RE = /\{(\w+)\}/g;
const ALLOWED_VAR_SET = new Set(ALLOWED_VARS);
const DIALOGUES_SAVE_DEBOUNCE_MS = 5000;

class DialogueDirector {
  constructor({
    personasDir,
    recentDialoguesPath,
    getActivePersona,
    sender,
    eventLogger = null,
    monitorRegistry = null,
    logger = console,
  } = {}) {
    this._personasDir = personasDir;
    this._recentPath = recentDialoguesPath;
    this._getActivePersona = getActivePersona;
    this._sender = sender;
    this._eventLogger = eventLogger;
    this._registry = monitorRegistry;
    this._log = logger;

    this._cache = new Map();
    this._recent = { ring_size: RING_SIZE, entries: [] };
    this._loaded = false;
    this._dirtyPersonas = new Set();
    this._saveTimer = null;
  }

  async load() {
    try {
      const text = await fs.promises.readFile(this._recentPath, 'utf-8');
      const data = JSON.parse(text);
      if (data && Array.isArray(data.entries)) {
        this._recent = { ring_size: data.ring_size || RING_SIZE, entries: data.entries };
      }
    } catch (_e) {
      // 不存在或損毀，從零開始
    }
    this._loaded = true;
  }

  invalidatePersonaCache() {
    this._cache.clear();
  }

  getRecentEntries() {
    return [...this._recent.entries];
  }

  async handleFire({ rule_name, category, context, fired_at }) {
    const personaId = (this._getActivePersona && this._getActivePersona()) || 'default';
    const dialogues = await this._loadPersona(personaId);
    if (!dialogues) {
      this._log.warn?.(`[director] no dialogues for persona "${personaId}"`);
      return;
    }

    const cat = dialogues.categories?.[category];
    const sequences = cat?.sequences || [];
    if (sequences.length === 0) {
      this._log.warn?.(`[director] no sequences in ${personaId}/${category}`);
      return;
    }

    const recentIds = new Set(this._recent.entries.map((e) => e.sequence_id));
    const fresh = sequences.filter((s) => !recentIds.has(s.sequenceId));
    const pool = fresh.length > 0 ? fresh : sequences;
    const chosen = pool[Math.floor(Math.random() * pool.length)];

    chosen._meta = chosen._meta || {
      created_at: new Date().toISOString(),
      source_batch: 'unknown',
      weight: 1,
      edited_at: null,
      fire_count_lifetime: 0,
    };
    chosen._meta.fire_count_lifetime = (chosen._meta.fire_count_lifetime || 0) + 1;
    this._scheduleDialoguesSave(personaId);

    let fgTitle = '';
    try {
      const fgPlugin = this._registry?.getPluginByCapability?.('foreground_window');
      fgTitle = fgPlugin?.snapshot?.()?.foreground?.title || '';
    } catch (err) {
      this._log.warn?.('[director] fg snapshot failed:', err.message);
    }
    const enrichedCtx = { ...(context || {}), fg_app_title: redactSensitive(fgTitle) };

    const sequence = cloneAndInterpolate(chosen, enrichedCtx);

    if (this._sender) {
      try { this._sender('dialogue:show', sequence); } catch (err) {
        this._log.warn?.('[director] sender failed:', err);
      }
    }

    const now = fired_at || Date.now();
    this._recent.entries.push({ t: now, category, sequence_id: chosen.sequenceId });
    while (this._recent.entries.length > (this._recent.ring_size || RING_SIZE)) {
      this._recent.entries.shift();
    }
    await this._saveRecent().catch((err) => this._log.warn?.('[director] save recent:', err));

    this._eventLogger?.log({
      type: 'trigger:fired',
      t: now,
      rule_name,
      category,
      sequence_id: chosen.sequenceId,
      persona: personaId,
    });
  }

  async _loadPersona(personaId) {
    if (this._cache.has(personaId)) return this._cache.get(personaId);
    const file = path.join(this._personasDir, personaId, 'dialogues.json');
    const initialFile = path.join(this._personasDir, personaId, 'dialogues-initial.json');

    // 若 dialogues.json 不存在，從 dialogues-initial.json 複製（首次安裝場景）
    try {
      await fs.promises.access(file);
    } catch (_e) {
      try {
        await fs.promises.access(initialFile);
        await fs.promises.copyFile(initialFile, file);
        this._log.info?.(`[director] 從 dialogues-initial.json 初始化 ${personaId}/dialogues.json`);
      } catch (initErr) {
        this._log.warn?.(`[director] ${personaId}: 找不到 dialogues.json 也沒 initial`, initErr.message);
        return null;
      }
    }

    try {
      const text = await fs.promises.readFile(file, 'utf-8');
      const data = JSON.parse(text);
      this._validateVars(personaId, data);
      this._cache.set(personaId, data);
      return data;
    } catch (err) {
      this._log.warn?.(`[director] load ${personaId}/dialogues.json:`, err.message);
      return null;
    }
  }

  _validateVars(personaId, data) {
    const cats = data?.categories;
    if (!cats || typeof cats !== 'object') return;
    for (const [catName, cat] of Object.entries(cats)) {
      const seqs = cat?.sequences;
      if (!Array.isArray(seqs)) continue;
      for (const seq of seqs) {
        if (!Array.isArray(seq?.lines)) continue;
        for (const line of seq.lines) {
          if (typeof line?.text !== 'string') continue;
          let m;
          VAR_SCAN_RE.lastIndex = 0;
          while ((m = VAR_SCAN_RE.exec(line.text)) !== null) {
            if (!ALLOWED_VAR_SET.has(m[1])) {
              this._log.warn?.(
                `[director] unknown var {${m[1]}} in ${personaId}/${catName}/${seq.sequenceId}`
              );
            }
          }
        }
      }
    }
  }

  async _saveRecent() {
    if (!this._loaded) return;
    // unique tmp 避免並發 fire 時兩個 saveRecent 互踩
    const tmp = `${this._recentPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await fs.promises.mkdir(path.dirname(this._recentPath), { recursive: true });
    await fs.promises.writeFile(tmp, JSON.stringify(this._recent, null, 2));
    await fs.promises.rename(tmp, this._recentPath);
  }

  _scheduleDialoguesSave(personaId) {
    this._dirtyPersonas.add(personaId);
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      const ids = Array.from(this._dirtyPersonas);
      this._dirtyPersonas.clear();
      for (const id of ids) {
        this._saveDialogues(id).catch((err) =>
          this._log.warn?.(`[director] save dialogues ${id}:`, err.message || err)
        );
      }
    }, DIALOGUES_SAVE_DEBOUNCE_MS);
    if (typeof this._saveTimer.unref === 'function') this._saveTimer.unref();
  }

  async flushPendingSaves() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    const ids = Array.from(this._dirtyPersonas);
    this._dirtyPersonas.clear();
    for (const id of ids) {
      try {
        await this._saveDialogues(id);
      } catch (err) {
        this._log.warn?.(`[director] flush dialogues ${id}:`, err.message || err);
      }
    }
  }

  async _saveDialogues(personaId) {
    const data = this._cache.get(personaId);
    if (!data) return;
    const file = path.join(this._personasDir, personaId, 'dialogues.json');
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.promises.rename(tmp, file);
  }
}

function cloneAndInterpolate(sequence, context) {
  const cloned = JSON.parse(JSON.stringify(sequence));
  if (Array.isArray(cloned.lines)) {
    cloned.lines = cloned.lines.map((line) => ({
      ...line,
      text: typeof line.text === 'string' ? interpolate(line.text, context) : line.text,
    }));
  }
  return cloned;
}

module.exports = { DialogueDirector };
