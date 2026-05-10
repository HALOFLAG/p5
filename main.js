const { app, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const {
  createMainWindow,
  createSettingsWindow,
  createDebugPanelWindow,
  createDialoguesManagerWindow,
} = require('./src/main/window-mgr');
const dialoguesMerger = require('./src/main/dialogues-merger');
const { buildPrompt: buildLLMPrompt } = require('./src/main/llm-prompt-builder');
const { GPTSoVITSEngine } = require('./src/main/voice-pipeline/gpt-sovits-engine');
const { VoiceManifest } = require('./src/main/voice-pipeline/voice-manifest');
const { BatchRunner } = require('./src/main/voice-pipeline/batch-runner');
const { createTray } = require('./src/main/tray');
const { ConfigStore } = require('./src/main/config-store');
const { WindowState } = require('./src/main/window-state');

// M3：感知 / 推導 / 決策 / 輸出
const { InputMonitor } = require('./src/main/input-monitor');
const { EventLogger } = require('./src/main/event-logger');
const { MonitorRegistry } = require('./src/main/monitor-registry');
const { ContextStateTracker } = require('./src/main/context-state-tracker');
const { TriggerEngine } = require('./src/main/trigger-engine');
const { DialogueDirector } = require('./src/main/dialogue-director');
const { RollupAggregator } = require('./src/main/rollup-aggregator');

const PROJECT_ROOT = __dirname;
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'settings.json');
const TRIGGERS_PATH = path.join(PROJECT_ROOT, 'config', 'triggers.json');
const PLUGINS_PATH = path.join(PROJECT_ROOT, 'config', 'plugins.json');
const APP_CLASSIFICATION_PATH = path.join(PROJECT_ROOT, 'config', 'app-classification.json');
const WINDOW_STATE_PATH = path.join(PROJECT_ROOT, 'data', 'window-state.json');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const RECENT_DIALOGUES_PATH = path.join(DATA_DIR, 'recent-dialogues.json');
const ROLLUPS_DIR = path.join(DATA_DIR, 'rollups');
const PERSONAS_DIR = path.join(PROJECT_ROOT, 'personas');
const VOICE_CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'voice-config.json');
const VOICE_REFS_DIR = path.join(PROJECT_ROOT, 'voice-refs');

const argv = process.argv.slice(1);
const IS_DEV = argv.includes('--dev');

let mainWindow = null;
let settingsWindow = null;
let debugPanelWindow = null;
let dialoguesManagerWindow = null;

// M6 voice
let voiceBatchRunner = null;       // 當前進行中的 batch（同時只能一個）
let voiceEngineInstance = null;    // 共用的 GPT-SoVITS engine 實例
let tray = null;
let config = null;
let windowState = null;
let saveStateDebounce = null;

// M3 模組
let inputMonitor = null;
let monitorRegistry = null;
let contextStateTracker = null;
let eventLogger = null;
let triggerEngine = null;
let dialogueDirector = null;
let rollupAggregator = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
    }
  });

  app.whenReady().then(bootstrap).catch((err) => {
    console.error('[main] bootstrap failed:', err);
    app.quit();
  });

  app.on('window-all-closed', (e) => {
    e.preventDefault();
    // tray 控制生命週期
  });

  app.on('before-quit', async () => {
    try {
      if (saveStateDebounce) clearTimeout(saveStateDebounce);
      if (windowState) await windowState.save();
      if (config) await config.save();

      try { await rollupAggregator?.stop(); } catch (e) { console.warn('[main] rollup stop:', e.message); }
      try { await dialogueDirector?.flushPendingSaves(); } catch (e) { console.warn('[main] director flush:', e.message); }
      try { triggerEngine?.stop(); } catch (e) { console.warn('[main] trigger stop:', e.message); }
      try { contextStateTracker?.stop(); } catch (e) { console.warn('[main] context stop:', e.message); }
      try { inputMonitor?.stop(); } catch (e) { console.warn('[main] input stop:', e.message); }
      try { await monitorRegistry?.stop(); } catch (e) { console.warn('[main] registry stop:', e.message); }
      try { await eventLogger?.stop(); } catch (e) { console.warn('[main] logger stop:', e.message); }
    } catch (err) {
      console.warn('[main] save on quit failed:', err.message);
    }
  });
}

async function bootstrap() {
  config = new ConfigStore(CONFIG_PATH);
  await config.load();

  windowState = new WindowState(WINDOW_STATE_PATH);
  await windowState.load();

  const settings = config.getAll();

  // 載入 M3 設定檔（缺檔走預設值，不阻斷啟動）
  const [pluginsCfg, triggersCfg, appClassification] = await Promise.all([
    loadJsonOr(PLUGINS_PATH, { monitor_level: 'tier1+2+3', plugins: {} }),
    loadJsonOr(TRIGGERS_PATH, { rules: [], dynamic_cooldown: null }),
    loadJsonOr(APP_CLASSIFICATION_PATH, {}),
  ]);

  // ── Tier 1 InputMonitor ────────────────────────────────
  inputMonitor = new InputMonitor({ logger: console });
  if (!settings.disable_input_monitor) {
    inputMonitor.start();
  } else {
    console.warn('[main] InputMonitor disabled by settings.disable_input_monitor');
  }

  // ── Tier 2/3 MonitorRegistry ───────────────────────────
  monitorRegistry = new MonitorRegistry({ pluginsConfig: pluginsCfg, logger: console });
  await monitorRegistry.start();

  // ── EventLogger（append-only JSONL） ───────────────────
  eventLogger = new EventLogger({
    dataDir: DATA_DIR,
    blacklist: settings.logger_blacklist || [],
    logger: console,
  });
  await eventLogger.start();

  eventLogger.subscribe(inputMonitor, {
    'typing-burst': 'typing-burst',
    'mouse-burst': 'mouse-burst',
    'click': 'click',
    'idle-start': 'idle-start',
    'idle-end': 'idle-end',
  });
  monitorRegistry.on('plugin-event', ({ plugin, event_name, payload }) => {
    eventLogger.log({ type: event_name, source_plugin: plugin, ...(payload || {}) });
  });
  monitorRegistry.on('plugin:degraded', (info) => {
    eventLogger.log({ type: 'plugin:degraded', ...info });
    console.warn('[main] plugin degraded:', info);
  });

  // ── ContextStateTracker ────────────────────────────────
  contextStateTracker = new ContextStateTracker({
    inputMonitor,
    registry: monitorRegistry,
    appClassification,
    logger: console,
  });
  contextStateTracker.start();

  // 把 context state 變化也寫進 events（rollup 之後可以據此算各情境時段）
  contextStateTracker.on('changed', ({ name, prev, current }) => {
    eventLogger.log({
      type: 'context:changed',
      t: current?.evaluated_at || Date.now(),
      state_name: name,
      prev_value: prev,
      new_value: current?.value,
      confidence: current?.confidence,
      sources: current?.sources,
    });
  });

  // ── TriggerEngine ──────────────────────────────────────
  triggerEngine = new TriggerEngine({
    inputMonitor,
    contextState: contextStateTracker,
    registry: monitorRegistry,
    getSettings: () => config.getAll(),
    logger: console,
  });
  triggerEngine.loadRules(triggersCfg);

  // ── DialogueDirector ───────────────────────────────────
  dialogueDirector = new DialogueDirector({
    personasDir: PERSONAS_DIR,
    recentDialoguesPath: RECENT_DIALOGUES_PATH,
    getActivePersona: () => config.getAll().active_persona,
    sender: (channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, payload);
      }
    },
    eventLogger,
    monitorRegistry,
    logger: console,
    voiceLookup: voiceLookupForDirector,
  });
  await dialogueDirector.load();

  triggerEngine.on('fire', (info) => {
    if (IS_DEV) {
      console.log(`[trigger] FIRE -> ${info.rule_name} (${info.category})`);
    }
    dialogueDirector.handleFire(info).catch((err) => console.warn('[main] handleFire:', err));
  });
  triggerEngine.on('rule:disabled', (info) => {
    console.warn(`[trigger] rule disabled: ${info.rule_name} (missing: ${info.missing_capabilities.join(', ')})`);
  });

  triggerEngine.start();

  // ── RollupAggregator（每整點 flush hourly summary） ───
  rollupAggregator = new RollupAggregator({ rollupsDir: ROLLUPS_DIR, logger: console });
  rollupAggregator.startStreaming({ inputMonitor, monitorRegistry, contextStateTracker });

  // ── 視窗 / 系統匣 ──────────────────────────────────────
  mainWindow = createMainWindow();

  mainWindow.webContents.once('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-state:initial', windowState.get());
    }
  });

  setupIpc();
  tray = createTray({ getMainWindow: () => mainWindow, projectRoot: PROJECT_ROOT });

  if (IS_DEV) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    console.log(
      `[main] M3 ready | level=${pluginsCfg.monitor_level} | plugins=${
        Object.keys(monitorRegistry.getStatus()).join(',')
      }`
    );
  }
}

async function loadJsonOr(filePath, defaultData) {
  try {
    const text = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(text);
  } catch (_e) {
    return defaultData;
  }
}

// ── M6 voice helpers ─────────────────────────────────
function getVoiceEngine() {
  if (!voiceEngineInstance) {
    voiceEngineInstance = new GPTSoVITSEngine();
  }
  return voiceEngineInstance;
}

const DEFAULT_VOICE_CONFIG = {
  engine: 'gpt-sovits',
  base_url: 'http://127.0.0.1:9880',
  // 共用 sampling params；單 persona 內也可覆寫
  sampling: {
    temperature: 0.8,    // 桌寵情境推薦：低於預設 1.0 提升跨句穩定度
    top_k: 15,
    top_p: 1.0,
  },
  voices: {
    // persona_id: {
    //   ref_audio: 'voice-refs/xxx.mp3',
    //   ref_text: '...',
    //   lang: 'zh',
    //   additional_refs: ['voice-refs/yyy.mp3', 'voice-refs/zzz.mp3'],   // 平均融合（同性別）
    //   sampling: { temperature: 0.7 },                                  // 可選覆寫
    // }
  },
};

async function loadVoiceConfig() {
  return await loadJsonOr(VOICE_CONFIG_PATH, DEFAULT_VOICE_CONFIG);
}

async function saveVoiceConfig(cfg) {
  await fs.mkdir(path.dirname(VOICE_CONFIG_PATH), { recursive: true });
  const tmp = `${VOICE_CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2));
  await fs.rename(tmp, VOICE_CONFIG_PATH);
}

// director 用：handleFire 時查 voice manifest 是否有對應 wav 檔
const _voiceManifestCache = new Map();   // key=`${personaId}:${lang}` → VoiceManifest
async function voiceLookupForDirector(personaId, sequenceId, lineIdx) {
  if (!personaId) return null;
  const cfg = await loadVoiceConfig();
  const lang = cfg.voices?.[personaId]?.lang || 'zh';
  const key = `${personaId}:${lang}`;
  let manifest = _voiceManifestCache.get(key);
  if (!manifest) {
    manifest = new VoiceManifest({ personaPath: path.join(PERSONAS_DIR, personaId), lang });
    await manifest.load();
    _voiceManifestCache.set(key, manifest);
  }
  return await manifest.lookup(sequenceId, lineIdx);
}

// 批次完成 / 設定變動時清掉，下次 fire 重讀新 manifest
function invalidateVoiceManifestCache() { _voiceManifestCache.clear(); }

// ref audio 相對路徑解析成絕對（GPT-SoVITS server 跑在自己目錄、相對路徑會找不到）
function resolveRefAudioPath(refPath) {
  if (!refPath) return refPath;
  if (path.isAbsolute(refPath)) return refPath;
  return path.resolve(PROJECT_ROOT, refPath);
}

function setupIpc() {
  // ── 設定 ──────────────────────────────────────────────
  ipcMain.handle('settings:get', () => config.getAll());
  ipcMain.handle('settings:set', async (_e, partial) => {
    const before = config.getAll();
    config.update(partial);
    const after = config.getAll();
    // 切人格時清快取 + dismiss 舊氣泡 + 通知 renderer 換 stage 表現
    if (before.active_persona !== after.active_persona) {
      dialogueDirector?.invalidatePersonaCache();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('dialogue:dismiss', { reason: 'persona-changed' });
        mainWindow.webContents.send('persona:changed', { id: after.active_persona });
      }
    }
    // 立刻寫硬碟（之前只在 before-quit 才寫，異常退出會丟設定）
    try {
      await config.save();
    } catch (err) {
      console.warn('[settings:set] save failed:', err.message || err);
    }
    return after;
  });

  ipcMain.handle('personas:get', async (_e, payload) => {
    const id = payload?.id;
    if (!id) throw new Error('id required');
    const file = path.join(PERSONAS_DIR, id, 'persona.json');
    try {
      const text = await fs.readFile(file, 'utf-8');
      const persona = JSON.parse(text);

      // M5a-real: 解析 appearance.image 為絕對 file:// URL（renderer 用）
      // appearance.image 的路徑相對於 persona.json 所在目錄
      if (persona?.appearance?.image) {
        const imageRel = persona.appearance.image;
        const imageAbs = path.resolve(path.dirname(file), imageRel);
        try {
          await fs.access(imageAbs);
          // file:// URL on Windows 要用正斜線
          persona.appearance._image_url = 'file:///' + imageAbs.replace(/\\/g, '/');
        } catch (_e) {
          // 圖檔不存在 → 不加 _image_url，renderer 會 fallback color-block
          console.warn(`[personas:get] image not found: ${imageAbs}`);
        }
      }

      return persona;
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  });

  // ── M4 Phase 2：Settings 視窗 ─────────────────────────
  ipcMain.handle('settings:open', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      if (settingsWindow.isMinimized()) settingsWindow.restore();
      settingsWindow.show();
      settingsWindow.focus();
      return true;
    }
    settingsWindow = createSettingsWindow();
    settingsWindow.on('closed', () => {
      settingsWindow = null;
    });
    return true;
  });

  ipcMain.on('settings-window:close', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.close();
    }
  });

  ipcMain.handle('personas:list', async () => {
    try {
      const entries = await fs.readdir(PERSONAS_DIR, { withFileTypes: true });
      const result = [];
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const id = ent.name;
        const personaPath = path.join(PERSONAS_DIR, id, 'persona.json');
        let display_name = id;
        try {
          const text = await fs.readFile(personaPath, 'utf-8');
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed.display_name === 'string' && parsed.display_name.trim()) {
            display_name = parsed.display_name;
          }
        } catch (_e) {
          // 缺 persona.json 或 JSON 壞掉 → 用 id 當 display_name
        }
        result.push({ id, display_name });
      }
      return result;
    } catch (err) {
      console.warn('[main] personas:list failed:', err.message);
      return [];
    }
  });

  // ── M4 Phase 3：Debug 面板視窗 ────────────────────────
  ipcMain.on('debug-panel:open', () => {
    if (debugPanelWindow && !debugPanelWindow.isDestroyed()) {
      if (debugPanelWindow.isMinimized()) debugPanelWindow.restore();
      debugPanelWindow.show();
      debugPanelWindow.focus();
      return;
    }
    debugPanelWindow = createDebugPanelWindow();
    debugPanelWindow.on('closed', () => {
      debugPanelWindow = null;
    });
  });

  ipcMain.on('debug-panel-window:close', () => {
    if (debugPanelWindow && !debugPanelWindow.isDestroyed()) {
      debugPanelWindow.close();
    }
  });

  // ── M4.5：對話庫管理視窗 ────────────────────────────
  ipcMain.handle('dialogues-manager:open', () => {
    if (dialoguesManagerWindow && !dialoguesManagerWindow.isDestroyed()) {
      if (dialoguesManagerWindow.isMinimized()) dialoguesManagerWindow.restore();
      dialoguesManagerWindow.show();
      dialoguesManagerWindow.focus();
      return true;
    }
    dialoguesManagerWindow = createDialoguesManagerWindow();
    dialoguesManagerWindow.on('closed', () => {
      dialoguesManagerWindow = null;
    });
    return true;
  });

  ipcMain.on('dialogues-manager-window:close', () => {
    if (dialoguesManagerWindow && !dialoguesManagerWindow.isDestroyed()) {
      dialoguesManagerWindow.close();
    }
  });

  ipcMain.handle('dialogues:read', async (_e, { persona }) => {
    if (!persona) throw new Error('persona required');
    const dialoguesPath = path.join(PERSONAS_DIR, persona, 'dialogues.json');
    const data = await dialoguesMerger.loadDialogues(dialoguesPath);
    return data;
  });

  ipcMain.handle('dialogues:read-initial', async (_e, { persona }) => {
    if (!persona) throw new Error('persona required');
    const initialPath = path.join(PERSONAS_DIR, persona, 'dialogues-initial.json');
    const data = await dialoguesMerger.loadDialogues(initialPath);
    return data;
  });

  ipcMain.handle('dialogues:save', async (_e, { persona, data }) => {
    if (!persona || !data) throw new Error('persona and data required');
    const dialoguesPath = path.join(PERSONAS_DIR, persona, 'dialogues.json');
    // 先 flush director 的 pending count save，避免覆蓋 UI 編輯
    try { await dialogueDirector?.flushPendingSaves(); } catch (_e) {}
    await dialoguesMerger.saveDialogues(dialoguesPath, data, { backup: true });
    // 立刻清 director cache，下次 fire 才看到新內容
    try { dialogueDirector?.invalidatePersonaCache(); } catch (_e) {}
    return { ok: true };
  });

  ipcMain.handle('dialogues:batch-import', async (_e, payload) => {
    const { persona, category, batch_tag, raw_text, mode, format } = payload || {};
    if (!persona || !category || !raw_text) {
      throw new Error('persona / category / raw_text required');
    }
    const dialoguesPath = path.join(PERSONAS_DIR, persona, 'dialogues.json');
    const data = await dialoguesMerger.loadDialogues(dialoguesPath);
    if (!data) throw new Error(`${persona}/dialogues.json 不存在`);

    const warnings = [];
    let parsed;
    if (format === 'csv') {
      parsed = dialoguesMerger.parseCSV(raw_text);
    } else {
      parsed = dialoguesMerger.parseTxtLines(raw_text, persona, category, {
        onWarn: (msg) => warnings.push(msg),
      });
    }

    const summary = dialoguesMerger.mergeIntoDialogues({
      data,
      persona,
      entries: parsed.entries,
      replace: mode === 'replace',
      batchTag: batch_tag || `manual-${new Date().toISOString().slice(0, 10)}`,
    });

    // dry-run 模式：不寫檔，只返回預覽
    if (payload.dryRun) {
      return { ok: true, dryRun: true, summary, warnings, parsed: { valid: parsed.valid, skipped: parsed.skipped } };
    }

    try { await dialogueDirector?.flushPendingSaves(); } catch (_e) {}
    await dialoguesMerger.saveDialogues(dialoguesPath, data, { backup: true });
    try { dialogueDirector?.invalidatePersonaCache(); } catch (_e) {}
    return { ok: true, summary, warnings, parsed: { valid: parsed.valid, skipped: parsed.skipped } };
  });

  ipcMain.handle('dialogues:gen-prompt', async (_e, { persona, category, count }) => {
    if (!persona || !category) throw new Error('persona / category required');
    const personaPath = path.join(PERSONAS_DIR, persona, 'persona.json');
    const initialPath = path.join(PERSONAS_DIR, persona, 'dialogues-initial.json');
    const personaText = await fs.readFile(personaPath, 'utf-8');
    const personaData = JSON.parse(personaText);
    let initialData = null;
    try {
      const initialText = await fs.readFile(initialPath, 'utf-8');
      initialData = JSON.parse(initialText);
    } catch (_e) {
      // 沒 initial 檔，buildPrompt fallback voice_samples
    }
    const prompt = buildLLMPrompt({
      persona: personaData,
      category,
      count: count || 30,
      dialoguesInitial: initialData,
    });
    return { prompt };
  });

  ipcMain.handle('dialogues:fire-stats', async (_e, { persona, days }) => {
    if (!persona) throw new Error('persona required');
    const since = Number.isFinite(days) && days > 0
      ? Date.now() - days * 86400000
      : 0;  // 0 = 全部
    const events = await eventLogger.readRange(since, Date.now());
    const counts = {};
    for (const e of events) {
      if (e.type !== 'trigger:fired') continue;
      if (e.persona && e.persona !== persona) continue;
      if (!e.sequence_id) continue;
      counts[e.sequence_id] = (counts[e.sequence_id] || 0) + 1;
    }
    return { counts, since, until: Date.now() };
  });

  // ── M6 Voice：GPT-SoVITS 整合 ──────────────────────
  ipcMain.handle('voice:check-engine', async () => {
    const engine = getVoiceEngine();
    const online = await engine.healthCheck();
    return { online, base_url: engine._baseUrl };
  });

  ipcMain.handle('voice:get-config', async () => {
    return await loadVoiceConfig();
  });

  ipcMain.handle('voice:set-config', async (_e, cfg) => {
    if (!cfg || typeof cfg !== 'object') throw new Error('config required');
    await saveVoiceConfig(cfg);
    invalidateVoiceManifestCache();
    return { ok: true };
  });

  ipcMain.handle('voice:test-tts', async (_e, { persona, text, lang }) => {
    if (!persona || !text) throw new Error('persona and text required');
    const cfg = await loadVoiceConfig();
    const voice = cfg.voices?.[persona];
    if (!voice?.ref_audio || !voice?.ref_text) {
      throw new Error(`persona "${persona}" 還沒設 ref audio / ref text（先到 Tab 5 設定）`);
    }
    const inpRefs = (voice.additional_refs || [])
      .filter((p) => typeof p === 'string' && p.trim())
      .map(resolveRefAudioPath);
    const sampling = { ...(cfg.sampling || {}), ...(voice.sampling || {}) };

    const engine = getVoiceEngine();
    const result = await engine.synthesize({
      text,
      ref_audio_path: resolveRefAudioPath(voice.ref_audio),
      ref_text: voice.ref_text,
      ref_lang: voice.lang || 'zh',
      target_lang: lang || voice.lang || 'zh',
      inp_refs: inpRefs,
      temperature: sampling.temperature,
      top_k: sampling.top_k,
      top_p: sampling.top_p,
    });
    // 寫到暫存檔，回傳 file path 給 renderer 試聽
    const tmpDir = path.join(DATA_DIR, '_voice_test');
    await fs.mkdir(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `${persona}_${Date.now()}.wav`);
    await fs.writeFile(tmpFile, result.audio);
    return { file_path: tmpFile, ms: result.meta.ms, bytes: result.meta.bytes };
  });

  ipcMain.handle('voice:list-stats', async (_e, { persona, lang = 'zh' }) => {
    if (!persona) throw new Error('persona required');
    const personaPath = path.join(PERSONAS_DIR, persona);
    const dialogues = await dialoguesMerger.loadDialogues(path.join(personaPath, 'dialogues.json'));
    if (!dialogues) return { total_lines: 0, generated: 0, missing: 0 };

    let totalLines = 0;
    for (const cat of Object.values(dialogues.categories || {})) {
      for (const seq of cat.sequences || []) {
        totalLines += (seq.lines || []).length;
      }
    }

    const manifest = new VoiceManifest({ personaPath, lang });
    await manifest.load();
    const stats = await manifest.stats();
    return {
      total_lines: totalLines,
      generated: stats.total,
      missing: Math.max(0, totalLines - stats.total),
    };
  });

  ipcMain.handle('voice:generate-batch', async (_e, { persona, mode = 'missing', lang = 'zh' }) => {
    if (!persona) throw new Error('persona required');
    if (voiceBatchRunner?.isRunning()) {
      throw new Error('已有批次在跑，請先取消或等完成');
    }

    const cfg = await loadVoiceConfig();
    const voice = cfg.voices?.[persona];
    if (!voice?.ref_audio || !voice?.ref_text) {
      throw new Error(`persona "${persona}" 還沒設 ref audio / ref text`);
    }

    const personaPath = path.join(PERSONAS_DIR, persona);
    const dialogues = await dialoguesMerger.loadDialogues(path.join(personaPath, 'dialogues.json'));
    if (!dialogues) throw new Error(`${persona}/dialogues.json 不存在`);

    const refAudioAbs = resolveRefAudioPath(voice.ref_audio);
    const inpRefsAbs = (voice.additional_refs || [])
      .filter((p) => typeof p === 'string' && p.trim())
      .map(resolveRefAudioPath);
    const sampling = { ...(cfg.sampling || {}), ...(voice.sampling || {}) };

    // 蒐集所有候選（每個 line 一筆）
    const candidates = [];
    for (const cat of Object.values(dialogues.categories || {})) {
      for (const seq of cat.sequences || []) {
        const lines = seq.lines || [];
        for (let i = 0; i < lines.length; i++) {
          if (typeof lines[i].text !== 'string') continue;
          candidates.push({
            sequence_id: seq.sequenceId,
            line_idx: i,
            text: lines[i].text,
            // batch-runner 把 ref_audio 透傳給 engine.synthesize，所以這裡就要絕對路徑
            ref_audio: refAudioAbs,
            ref_text: voice.ref_text,
            ref_lang: voice.lang || 'zh',
            lang,
            inp_refs: inpRefsAbs,
            temperature: sampling.temperature,
            top_k: sampling.top_k,
            top_p: sampling.top_p,
          });
        }
      }
    }

    const manifest = new VoiceManifest({ personaPath, lang });
    await manifest.load();

    // mode='all' 時清空 manifest 強制全部重生
    if (mode === 'all') {
      manifest._data.entries = {};
      await manifest._save();
    }

    const engine = getVoiceEngine();
    voiceBatchRunner = new BatchRunner({
      engine,
      manifest,
      concurrency: 2,
      onProgress: (state) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('voice:progress', { persona, lang, ...state });
        }
        if (dialoguesManagerWindow && !dialoguesManagerWindow.isDestroyed()) {
          dialoguesManagerWindow.webContents.send('voice:progress', { persona, lang, ...state });
        }
      },
      onError: ({ item, error }) => {
        console.warn('[voice] batch item error:', item.sequence_id, item.line_idx, error?.message);
      },
    });

    // 不阻塞 IPC 回傳；後續進度透過 voice:progress 推送
    voiceBatchRunner.run(candidates).then((summary) => {
      invalidateVoiceManifestCache();
      if (dialoguesManagerWindow && !dialoguesManagerWindow.isDestroyed()) {
        dialoguesManagerWindow.webContents.send('voice:batch-done', { persona, lang, summary });
      }
    }).catch((err) => {
      console.warn('[voice] batch failed:', err.message);
      if (dialoguesManagerWindow && !dialoguesManagerWindow.isDestroyed()) {
        dialoguesManagerWindow.webContents.send('voice:batch-done', {
          persona, lang, error: err.message,
        });
      }
    });

    return { ok: true, total_candidates: candidates.length };
  });

  ipcMain.handle('voice:cancel', () => {
    if (voiceBatchRunner?.isRunning()) {
      voiceBatchRunner.cancel();
      return { ok: true, cancelled: true };
    }
    return { ok: true, cancelled: false };
  });

  // ── 視窗狀態（角色位置）─────────────────────────────
  ipcMain.handle('window-state:get', () => windowState.get());
  ipcMain.handle('window-state:set', (_e, partial) => {
    windowState.update(partial);
    if (saveStateDebounce) clearTimeout(saveStateDebounce);
    saveStateDebounce = setTimeout(() => {
      windowState.save().catch((err) => {
        console.warn('[main] window-state save failed:', err.message);
      });
    }, 500);
    return windowState.get();
  });

  // ── 滑鼠穿透切換 ───────────────────────────────────────
  ipcMain.on('mouse:enter-character', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setIgnoreMouseEvents(false);
  });
  ipcMain.on('mouse:leave-character', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
    }
  });

  // ── shell / env ────────────────────────────────────────
  ipcMain.handle('shell:open-config-dir', () => shell.openPath(path.join(PROJECT_ROOT, 'config')));
  ipcMain.handle('env:info', () => ({
    isDev: IS_DEV,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
  }));

  // ── 對話氣泡（M3 後由 TriggerEngine 接管，dev-box 仍可手動測 UI 變體）
  ipcMain.on('debug:test-bubble', (_e, opts = {}) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const sequence = opts.sequence || lookupDemoSequence(opts.variant);
    if (sequence) mainWindow.webContents.send('dialogue:show', sequence);
  });

  ipcMain.on('dialogue:advance', (_e, payload) => {
    if (IS_DEV) console.log('[main] dialogue:advance', payload);
  });
  ipcMain.on('dialogue:dismiss-ack', (_e, payload) => {
    if (IS_DEV) console.log('[main] dialogue:dismiss-ack', payload);
  });
  ipcMain.on('dialogue:choice-selected', (_e, payload) => {
    if (IS_DEV) console.log('[main] dialogue:choice-selected', payload);
    // M3 階段：dev demo 仍走 lookupDemoSequence。M4 之後 choice → 觸發其他 category。
    if (!payload || !payload.next) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const nextSeq = lookupDemoSequence(payload.next);
    if (nextSeq) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('dialogue:show', nextSeq);
        }
      }, 250);
    }
  });

  // ── M3：character drag ────────────────────────────────
  ipcMain.on('character:drag-start', () => {
    triggerEngine?.handleEvent('character:drag-start', { t: Date.now() });
  });

  // ── M3：debug 面板 ────────────────────────────────────
  ipcMain.handle('debug:counters:get', () => inputMonitor?.snapshot() || null);
  ipcMain.handle('debug:env:get', () => ({
    plugins: monitorRegistry?.snapshot() || {},
    capabilities: [...(monitorRegistry?.getActiveCapabilities() || [])],
  }));
  ipcMain.handle('debug:context-state:get', () => contextStateTracker?.getState() || {});
  ipcMain.handle('debug:plugins:status', () => monitorRegistry?.getStatus() || {});
  ipcMain.handle('debug:rules:status', () => triggerEngine?.getRuleStatus() || []);
  ipcMain.on('debug:fire', (_e, payload) => {
    if (payload?.rule_name) {
      const ok = triggerEngine?.forceFire(payload.rule_name);
      if (IS_DEV) console.log(`[debug:fire] ${payload.rule_name} → ${ok ? 'ok' : 'rule not found / disabled'}`);
    }
  });
  ipcMain.on('debug:reset-cooldowns', () => {
    triggerEngine?.resetCooldowns();
    if (IS_DEV) console.log('[debug] cooldowns reset');
  });
  // M5a-real：dev panel 隨機觸發按鈕（不走 trigger engine 規則限制，直接挑 category 餵 director）
  ipcMain.on('debug:random-fire', () => {
    const cats = ['click_too_much', 'long_idle', 'continuous_use', 'deep_night', 'drag'];
    const cat = cats[Math.floor(Math.random() * cats.length)];
    dialogueDirector?.handleFire({
      rule_name: cat,
      category: cat,
      context: { input: { session_sec: 0 }, contextState: {} },
    }).catch((err) => console.warn('[debug:random-fire]', err.message || err));
    if (IS_DEV) console.log(`[debug:random-fire] → ${cat}`);
  });
  ipcMain.handle('debug:flush-events', async () => {
    await eventLogger?.flushNow();
    return { ok: true };
  });
  ipcMain.handle('debug:purge-events', async () => {
    await eventLogger?.purgeAll();
    return { ok: true };
  });
  ipcMain.handle('debug:trigger-history', async (_e, opts = {}) => {
    if (!eventLogger) return [];
    const limit = Math.max(1, Math.min(opts.limit || 50, 500));
    const now = Date.now();
    const events = await eventLogger.readRange(now - 7 * 24 * 3600 * 1000, now);
    return events.filter((e) => e.type === 'trigger:fired').slice(-limit).reverse();
  });

  // ── M4 Phase 3：rollup 聚合（給 Debug 面板熱力 / 應用 Top-10） ─
  ipcMain.handle('debug:heatmap', async (_e, opts = {}) => {
    const days = Math.max(1, Math.min(opts.days || 7, 90));
    const rollups = await loadRollupsForRecentDays(days);
    // matrix[weekday 0=Sun..6=Sat][hour 0..23] = activity weight
    const matrix = Array.from({ length: 7 }, () => Array(24).fill(0));
    let maxValue = 0;
    for (const r of rollups) {
      const d = new Date(r.hour_start);
      const wd = d.getDay();
      const hr = d.getHours();
      const triggers = sumValues(r.trigger_count);
      const weight = (r.click_count || 0) + (r.key_count || 0) + 5 * triggers;
      matrix[wd][hr] += weight;
      if (matrix[wd][hr] > maxValue) maxValue = matrix[wd][hr];
    }
    return { matrix, max_value: maxValue, total_days: days, rollup_count: rollups.length };
  });

  ipcMain.handle('debug:app-usage', async (_e, opts = {}) => {
    const days = Math.max(1, Math.min(opts.days || 7, 90));
    const rollups = await loadRollupsForRecentDays(days);
    const totals = {};
    let totalMs = 0;
    for (const r of rollups) {
      const fg = r.fg_app_ms || {};
      for (const [exe, ms] of Object.entries(fg)) {
        if (!exe) continue;
        const v = Number(ms) || 0;
        totals[exe] = (totals[exe] || 0) + v;
        totalMs += v;
      }
    }
    const sorted = Object.entries(totals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([exe, total_ms]) => ({
        exe,
        total_ms,
        percent: totalMs > 0 ? Math.round((total_ms / totalMs) * 1000) / 10 : 0,
      }));
    return { apps: sorted, total_ms: totalMs, total_days: days, rollup_count: rollups.length };
  });
}

// ── rollup 讀取 helper ─────────────────────────────────────
// 讀過去 N 天的 rollup JSONL，回傳已 parse 的物件陣列。檔不存在或單行壞掉跳過。
async function loadRollupsForRecentDays(days) {
  const rollups = [];
  let entries;
  try {
    entries = await fs.readdir(ROLLUPS_DIR);
  } catch (_e) {
    return rollups;
  }
  // 計算允許的日期區間（以本地日期 YYYY-MM-DD 為界）
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  const cutoffStr = formatLocalDate(cutoff);
  const todayStr = formatLocalDate(now);

  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const dateStr = name.slice(0, -6); // strip .jsonl
    if (dateStr < cutoffStr || dateStr > todayStr) continue;
    try {
      const text = await fs.readFile(path.join(ROLLUPS_DIR, name), 'utf-8');
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const obj = JSON.parse(t);
          if (obj && obj.type === 'hourly-rollup') rollups.push(obj);
        } catch (_e) { /* skip bad line */ }
      }
    } catch (_e) { /* skip unreadable file */ }
  }
  return rollups;
}

function formatLocalDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function sumValues(obj) {
  if (!obj) return 0;
  let s = 0;
  for (const v of Object.values(obj)) s += Number(v) || 0;
  return s;
}

// ── DEV 模式測試用 demo 序列（保留 M2.5 全 11 種變體）─────
// M3 後真實對話走 TriggerEngine → DialogueDirector → dialogues.json，
// 此處僅供 dev-box 按鈕快速測 UI（thought / persistent / choice / binary 等變體）
const DEMO_SEQUENCES = {
  short: {
    sequenceId: 'demo_short',
    type: 'speech',
    lines: [{ text: '嗨！', expression: 'happy' }],
  },
  medium: {
    sequenceId: 'demo_med',
    type: 'speech',
    lines: [
      { text: '哈囉，我是 p5 的對話氣泡', expression: 'happy' },
      { text: '點氣泡可以推進到下一句', expression: 'idle' },
      { text: '最後一句結尾會有 ▶ 提示', expression: 'pout' },
    ],
  },
  long: {
    sequenceId: 'demo_long',
    type: 'speech',
    lines: [
      { text: '這是一個比較長的測試句子，看看打字機效果跑起來會不會卡。', expression: 'idle' },
      { text: '中間還有幾段話讓我確認序列推進正常運作。', expression: 'idle' },
      { text: '另外想看 12 秒自動關是否生效，要不點我。', expression: 'sleepy' },
      { text: '最後一句話了，點完應該會關閉。', expression: 'pout' },
    ],
  },
  interrupt: {
    sequenceId: 'demo_intr',
    type: 'speech',
    lines: [
      { text: '我是新來的對話，會打斷舊的那個。', expression: 'surprised' },
      { text: '舊的會直接消失。', expression: 'idle' },
    ],
  },
  thought: {
    sequenceId: 'demo_thought',
    type: 'thought',
    interaction: 'display',
    auto_close_ms: 6000,
    lines: [{ text: '（這人怎麼又熬夜⋯⋯）' }],
  },
  narration: {
    sequenceId: 'demo_narration',
    type: 'narration',
    interaction: 'display',
    auto_close_ms: 6000,
    lines: [{ text: '使用者已連續操作 4 小時 23 分。' }],
  },
  system: {
    sequenceId: 'demo_system',
    type: 'system',
    interaction: 'display',
    auto_close_ms: 5000,
    lines: [{ text: '正在生成新台詞庫… 67%' }],
  },
  whisper: {
    sequenceId: 'demo_whisper',
    type: 'whisper',
    interaction: 'display',
    auto_close_ms: 5000,
    lines: [{ text: '（小聲）你電量剩 18% 了喔' }],
  },
  persistent: {
    sequenceId: 'demo_persistent',
    type: 'speech',
    persistence: 'persistent',
    lines: [
      { text: '這是持續氣泡，會循環提醒', expression: 'idle' },
      { text: '別忘了喝口水', expression: 'idle' },
      { text: '起身伸個懶腰也好', expression: 'idle' },
      { text: '點 ✕ 才會關閉', expression: 'idle' },
    ],
  },
  pinned: {
    sequenceId: 'demo_pinned',
    type: 'speech',
    persistence: 'pinned',
    lines: [{ text: '我是釘選氣泡，左上有 📌', expression: 'idle' }],
  },
  choice: {
    sequenceId: 'demo_choice',
    type: 'speech',
    persistence: 'persistent',
    interaction: 'choice',
    lines: [{ text: '你連續工作 4 小時了，要不要：', expression: 'annoyed' }],
    choices: [
      { label: '休息 5 分鐘', next: 'rest_path' },
      { label: '關掉通知一下', next: 'silence_path' },
      { label: '不用管我', next: null },
    ],
  },
  rest_path: {
    sequenceId: 'rest_path',
    type: 'speech',
    lines: [{ text: '好，我 5 分鐘後叫你', expression: 'happy' }],
  },
  silence_path: {
    sequenceId: 'silence_path',
    type: 'system',
    interaction: 'display',
    auto_close_ms: 4000,
    lines: [{ text: '（已切換到請勿打擾）' }],
  },
  binary: {
    sequenceId: 'demo_binary',
    type: 'speech',
    persistence: 'persistent',
    interaction: 'binary_split',
    lines: [{ text: '你要休息一下嗎？', expression: 'idle' }],
    binary: {
      left: { label: '好啊', next: 'rest_path' },
      right: { label: '不要', next: 'binary_decline' },
    },
  },
  binary_decline: {
    sequenceId: 'binary_decline',
    type: 'thought',
    interaction: 'display',
    auto_close_ms: 4000,
    lines: [{ text: '（哼，那就隨便你⋯⋯）' }],
  },
};

function lookupDemoSequence(idOrVariant) {
  return DEMO_SEQUENCES[idOrVariant] || DEMO_SEQUENCES.medium;
}
