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
const { interpolate } = require('./variable-interpolator');

const RING_SIZE = 50;

class DialogueDirector {
  constructor({
    personasDir,
    recentDialoguesPath,
    getActivePersona,
    sender,
    eventLogger = null,
    logger = console,
  } = {}) {
    this._personasDir = personasDir;
    this._recentPath = recentDialoguesPath;
    this._getActivePersona = getActivePersona;
    this._sender = sender;
    this._eventLogger = eventLogger;
    this._log = logger;

    this._cache = new Map();
    this._recent = { ring_size: RING_SIZE, entries: [] };
    this._loaded = false;
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

    const sequence = cloneAndInterpolate(chosen, context);

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
    try {
      const text = await fs.promises.readFile(file, 'utf-8');
      const data = JSON.parse(text);
      this._cache.set(personaId, data);
      return data;
    } catch (err) {
      this._log.warn?.(`[director] load ${personaId}/dialogues.json:`, err.message);
      return null;
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
