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
    voiceLookup = null,        // M6: async (personaId, sequenceId, lineIdx) => { file_path } | null
    timeVoiceLookup = null,    // P3: async (personaId, timeKey) => { file_path } | null
  } = {}) {
    this._personasDir = personasDir;
    this._recentPath = recentDialoguesPath;
    this._getActivePersona = getActivePersona;
    this._sender = sender;
    this._eventLogger = eventLogger;
    this._registry = monitorRegistry;
    this._log = logger;
    this._voiceLookup = voiceLookup;
    this._timeVoiceLookup = timeVoiceLookup;

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

  async handleFire({ rule_name, category, context, fired_at, voice_prefix }) {
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
    let fresh = sequences.filter((s) => !recentIds.has(s.sequenceId));

    // P5: click_character category 依 rule_name 用 streak_level 過濾
    //   click_streak rule → 強制挑 streak_level=high
    //   click_character rule → 挑 low/mid（或無設定）
    if (category === 'click_character') {
      const filterByStreak = rule_name === 'click_streak'
        ? (s) => s._meta?.streak_level === 'high'
        : (s) => {
            const lv = s._meta?.streak_level;
            return !lv || lv === 'low' || lv === 'mid';
          };
      const filtered = fresh.filter(filterByStreak);
      // 若篩完空 → fallback 全集（保證一定能 fire）
      if (filtered.length > 0) fresh = filtered;
      else {
        const allFiltered = sequences.filter(filterByStreak);
        if (allFiltered.length > 0) fresh = allFiltered;
      }
    }

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

    // M6/P3 voice：查 manifest + 依 voice_prefix 組時間音串接路徑
    if (this._voiceLookup && this._sender && Array.isArray(sequence.lines)) {
      this._dispatchVoice(personaId, sequence, { voice_prefix, fired_at }).catch((err) => {
        this._log.warn?.('[director] voice dispatch failed:', err.message || err);
      });
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

      // 補齊保護：如果 dialogues-initial.json 有 category 而 dialogues.json 缺，
      // 自動把 initial 的對應 category 補進 dialogues.json（避免之前手動編 dialogues.json
      // 被 director debounced save 覆蓋的 race condition）。
      await this._mergeMissingCategoriesFromInitial(personaId, data, initialFile);

      this._validateVars(personaId, data);
      this._lintNextRefs(personaId, data);
      this._cache.set(personaId, data);
      return data;
    } catch (err) {
      this._log.warn?.(`[director] load ${personaId}/dialogues.json:`, err.message);
      return null;
    }
  }

  async _mergeMissingCategoriesFromInitial(personaId, data, initialFile) {
    let initialData;
    try {
      const text = await fs.promises.readFile(initialFile, 'utf-8');
      initialData = JSON.parse(text);
    } catch (_e) {
      return; // 沒 initial 檔，跳過
    }
    if (!initialData?.categories || typeof initialData.categories !== 'object') return;
    if (!data.categories) data.categories = {};

    const added = [];
    for (const [catName, catData] of Object.entries(initialData.categories)) {
      if (data.categories[catName]) continue; // 主檔已有，跳過
      // 深複製避免 cache 共用
      data.categories[catName] = JSON.parse(JSON.stringify(catData));
      added.push(catName);
    }
    if (added.length > 0) {
      this._log.info?.(
        `[director] ${personaId}: 從 initial 補齊缺少 category：[${added.join(', ')}]`
      );
      // 標 dirty，觸發 debounce save 寫回 dialogues.json
      this._scheduleDialoguesSave(personaId);
    }
  }

  // Phase A: 掃描所有 response.next 引用是否存在
  _lintNextRefs(personaId, data) {
    const cats = data?.categories;
    if (!cats || typeof cats !== 'object') return;
    // 先建索引：所有 sequenceId
    const allIds = new Set();
    for (const cat of Object.values(cats)) {
      for (const seq of (cat?.sequences || [])) {
        if (seq?.sequenceId) allIds.add(seq.sequenceId);
      }
    }
    // 掃描每個 response.next
    let warned = 0;
    for (const [catName, cat] of Object.entries(cats)) {
      for (const seq of (cat?.sequences || [])) {
        const refs = [];
        if (Array.isArray(seq?.choices)) {
          for (const c of seq.choices) if (c?.response?.next) refs.push(c.response.next);
        }
        if (seq?.binary) {
          for (const side of ['yes', 'no']) {
            const n = seq.binary[side]?.response?.next;
            if (n) refs.push(n);
          }
        }
        for (const ref of refs) {
          if (!allIds.has(ref)) {
            warned++;
            this._log.warn?.(
              `[director] dangling next ref "${ref}" in ${personaId}/${catName}/${seq.sequenceId}`
            );
          }
        }
      }
    }
    if (warned > 0) {
      this._log.warn?.(`[director] ${personaId}: ${warned} 條 dangling next ref（互動鏈會卡住）`);
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

  /**
   * M6: 抽 sequence 第一行的 voice 檔（如果有）→ 推 voice:play 給 renderer。
   * 多行 sequence 暫時只播第一行（M2.5 advance 機制下其他行使用者點下一句才出來，
   * 之後可在 advance 時補播）。
   */
  /**
   * 處理使用者點 choice / binary 後的後續 response（P1）
   * payload: { sequenceId, choiceIndex?, side?, action? }
   *   - choice 互動帶 choiceIndex（0/1/2/...）
   *   - binary 互動帶 side（'yes' / 'no'，legacy 'left'/'right' 也接受）
   */
  async handleChoiceSelected({ sequenceId, choiceIndex, side, action } = {}) {
    if (!sequenceId) return;
    const personaId = (this._getActivePersona && this._getActivePersona()) || 'default';
    const dialogues = await this._loadPersona(personaId);
    if (!dialogues?.categories) return;

    // 跨 categories 找 sequenceId
    let parent = null;
    for (const cat of Object.values(dialogues.categories)) {
      const seq = (cat.sequences || []).find((s) => s.sequenceId === sequenceId);
      if (seq) { parent = seq; break; }
    }
    if (!parent) {
      this._log.warn?.(`[director] choice-selected: 找不到 sequence ${sequenceId}`);
      return;
    }

    // 取出 response 資料 + 算 voice subkey（給後續 P3 voice batch 用）
    let response = null;
    let voiceSubKey = null;
    if (parent.interaction === 'choice' && Array.isArray(parent.choices) && Number.isFinite(choiceIndex)) {
      const c = parent.choices[choiceIndex];
      if (c?.response) {
        response = c.response;
        voiceSubKey = `choice_${choiceIndex}`;
      }
    } else if (parent.interaction === 'binary' && parent.binary) {
      const sideKey = (side === 'left') ? 'yes' : (side === 'right') ? 'no' : side;
      const b = parent.binary[sideKey];
      if (b?.response) {
        response = b.response;
        voiceSubKey = `binary_${sideKey}`;
      }
    }
    if (!response || !response.text) {
      this._log.info?.(`[director] choice-selected: ${sequenceId} 無對應 response（可能 action only）`);
      return;
    }

    // 組成回應 sequence（一條 line，display only）— 雙語：line 帶 voice_text / voice_lang
    const responseLine = { text: response.text };
    if (response.expression) responseLine.expression = response.expression;
    if (response.voice_text) responseLine.voice_text = response.voice_text;
    if (response.voice_lang) responseLine.voice_lang = response.voice_lang;

    const responseSeq = {
      sequenceId: `${sequenceId}__${voiceSubKey}`,
      type: response.type || 'speech',
      interaction: 'display',
      auto_close_ms: response.auto_close_ms || 4500,
      lines: [responseLine],
      _meta: { from_choice: { parent: sequenceId, sub: voiceSubKey } },
    };

    // 略延遲 250ms 推 dialogue:show，讓前一個 choice bubble dismiss 動畫跑完
    setTimeout(() => {
      if (this._sender) {
        try { this._sender('dialogue:show', responseSeq); }
        catch (err) { this._log.warn?.('[director] sender failed (response):', err); }
      }
    }, 250);

    // 試查 response 對應 voice（同 line.voice_lang override）
    if (this._voiceLookup && this._sender) {
      try {
        const found = await this._voiceLookup(personaId, responseSeq.sequenceId, 0, response.voice_lang || null);
        if (found?.file_path) {
          setTimeout(() => {
            try { this._sender('voice:play', { file_paths: [found.file_path], sequence_id: responseSeq.sequenceId, line_idx: 0 }); }
            catch (err) { this._log.warn?.('[director] voice:play (response) failed:', err); }
          }, 280);
        }
      } catch (_e) { /* 安靜失敗 */ }
    }

    // 紀錄事件（給統計用）
    this._eventLogger?.log({
      type: 'dialogue:choice-selected',
      t: Date.now(),
      sequence_id: sequenceId,
      sub: voiceSubKey,
      action: action || null,
      persona: personaId,
    });

    // Phase A: response.next 鏈結 — 推完 response 後，等延遲再 fire 下一個 sequence
    if (response.next) {
      const nextDelay = Number.isFinite(response.next_delay_ms) ? response.next_delay_ms
        : (response.auto_close_ms || 2500);
      setTimeout(() => {
        this._fireNextSequence(personaId, response.next, parent).catch((err) =>
          this._log.warn?.('[director] next chain failed:', err.message || err)
        );
      }, 250 + nextDelay);
    }
  }

  // Phase A: 鏈到 next sequence（從目前 persona 整體 dialogues 內查）
  async _fireNextSequence(personaId, nextSequenceId, fromParentSeq) {
    if (!nextSequenceId) return;
    const dialogues = await this._loadPersona(personaId);
    if (!dialogues?.categories) return;
    let nextSeq = null;
    for (const cat of Object.values(dialogues.categories)) {
      const s = (cat.sequences || []).find((x) => x.sequenceId === nextSequenceId);
      if (s) { nextSeq = s; break; }
    }
    if (!nextSeq) {
      this._log.warn?.(`[director] next chain: sequence "${nextSequenceId}" not found（dangling ref，from parent ${fromParentSeq?.sequenceId}）`);
      return;
    }
    // 重用 dispatch 邏輯（不過 rule_name 用 chain 標記，事件 log 區分）
    const ctx = {};
    const cloned = JSON.parse(JSON.stringify(nextSeq));
    if (this._sender) {
      try { this._sender('dialogue:show', cloned); }
      catch (err) { this._log.warn?.('[director] sender failed (next):', err); }
    }
    // voice 走 dispatch（next sequence 是正常 sequence，有自己的 voice）
    if (this._voiceLookup) {
      this._dispatchVoice(personaId, cloned, { fired_at: Date.now() }).catch((err) =>
        this._log.warn?.('[director] voice dispatch (next) failed:', err.message || err)
      );
    }
    this._eventLogger?.log({
      type: 'trigger:fired',
      t: Date.now(),
      rule_name: 'choice_chain',
      category: 'click_character',
      sequence_id: cloned.sequenceId,
      persona: personaId,
      chain_from: fromParentSeq?.sequenceId,
    });
  }

  async _dispatchVoice(personaId, sequence, opts = {}) {
    if (!sequence?.sequenceId || !Array.isArray(sequence.lines) || sequence.lines.length === 0) return;
    const { voice_prefix, fired_at } = opts;
    const filePaths = [];

    // 雙語架構：voice_lang 從 line 取（per-sequence override），缺則用 persona default 從 lookup 內部解析
    const firstLine = sequence.lines[0];
    const lineVoiceLang = firstLine?.voice_lang || null;

    // P3: 依 voice_prefix 加時間語音段（lang 跟主情境音對齊）
    if (voice_prefix && this._timeVoiceLookup) {
      try {
        const timeKey = resolveTimeVoiceKey(voice_prefix, fired_at || Date.now());
        if (timeKey) {
          const tv = await this._timeVoiceLookup(personaId, timeKey, lineVoiceLang);
          if (tv?.file_path) filePaths.push(tv.file_path);
          else this._log.info?.(`[director] time voice not found: ${personaId}/${timeKey}（語音將跳過時間段）`);
        }
      } catch (err) {
        this._log.warn?.('[director] time voice lookup failed:', err.message || err);
      }
    }

    // 主情境語音（per-sequence voice_lang override）
    try {
      const found = await this._voiceLookup(personaId, sequence.sequenceId, 0, lineVoiceLang);
      if (found?.file_path) filePaths.push(found.file_path);
    } catch (err) {
      this._log.warn?.('[director] voice lookup failed:', err.message || err);
    }

    if (filePaths.length === 0) return;
    try {
      this._sender('voice:play', {
        file_paths: filePaths,
        sequence_id: sequence.sequenceId,
        line_idx: 0,
        pad_ms: filePaths.length > 1 ? 150 : 0,
      });
    } catch (err) {
      this._log.warn?.('[director] voice:play send failed:', err);
    }
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

// P3: voice_prefix → time voice key
//   "hour_dynamic"        → hour_HH (依 firedAt 的小時)
//   "hour_period_dynamic" → morning/lunch/evening/night（依小時段）
//   固定字串（"morning" / "lunch" / etc）→ 直接當 key
function resolveTimeVoiceKey(voicePrefix, firedAtMs) {
  if (!voicePrefix) return null;
  if (voicePrefix === 'hour_dynamic') {
    const h = new Date(firedAtMs).getHours();
    return `hour_${String(h).padStart(2, '0')}`;
  }
  if (voicePrefix === 'hour_period_dynamic') {
    const h = new Date(firedAtMs).getHours();
    if (h >= 5 && h < 11) return 'morning';
    if (h >= 11 && h < 14) return 'lunch';
    if (h >= 14 && h < 19) return 'evening';
    return 'night';
  }
  return voicePrefix;   // 固定詞 (morning/lunch/evening/night/...)
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
