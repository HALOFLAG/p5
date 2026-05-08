const { app, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const { createMainWindow } = require('./src/main/window-mgr');
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

const PROJECT_ROOT = __dirname;
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'settings.json');
const TRIGGERS_PATH = path.join(PROJECT_ROOT, 'config', 'triggers.json');
const PLUGINS_PATH = path.join(PROJECT_ROOT, 'config', 'plugins.json');
const APP_CLASSIFICATION_PATH = path.join(PROJECT_ROOT, 'config', 'app-classification.json');
const WINDOW_STATE_PATH = path.join(PROJECT_ROOT, 'data', 'window-state.json');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const RECENT_DIALOGUES_PATH = path.join(DATA_DIR, 'recent-dialogues.json');
const PERSONAS_DIR = path.join(PROJECT_ROOT, 'personas');

const argv = process.argv.slice(1);
const IS_DEV = argv.includes('--dev');

let mainWindow = null;
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
    'click-burst': 'click-burst',
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
    logger: console,
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

function setupIpc() {
  // ── 設定 ──────────────────────────────────────────────
  ipcMain.handle('settings:get', () => config.getAll());
  ipcMain.handle('settings:set', (_e, partial) => {
    const before = config.getAll();
    config.update(partial);
    const after = config.getAll();
    // 切人格時清快取
    if (before.active_persona !== after.active_persona) {
      dialogueDirector?.invalidatePersonaCache();
    }
    return after;
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
