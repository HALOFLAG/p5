const { app, ipcMain, shell } = require('electron');
const path = require('node:path');
const { createMainWindow } = require('./src/main/window-mgr');
const { createTray } = require('./src/main/tray');
const { ConfigStore } = require('./src/main/config-store');
const { WindowState } = require('./src/main/window-state');

const PROJECT_ROOT = __dirname;
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'settings.json');
const WINDOW_STATE_PATH = path.join(PROJECT_ROOT, 'data', 'window-state.json');

const argv = process.argv.slice(1);
const IS_DEV = argv.includes('--dev');

let mainWindow = null;
let tray = null;
let config = null;
let windowState = null;
let saveStateDebounce = null;

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
    // 由 tray 控制生命週期，視窗關閉不退出
  });

  app.on('before-quit', async () => {
    try {
      if (saveStateDebounce) clearTimeout(saveStateDebounce);
      if (windowState) await windowState.save();
      if (config) await config.save();
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

  mainWindow = createMainWindow();

  // Renderer 載入完成後送入初始 window-state
  mainWindow.webContents.once('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-state:initial', windowState.get());
    }
  });

  setupIpc();
  tray = createTray({ getMainWindow: () => mainWindow, projectRoot: PROJECT_ROOT });

  if (IS_DEV) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function setupIpc() {
  // ── 設定 ──────────────────────────────────────────────
  ipcMain.handle('settings:get', () => config.getAll());
  ipcMain.handle('settings:set', (_e, partial) => {
    config.update(partial);
    return config.getAll();
  });

  // ── 視窗狀態（角色位置）─────────────────────────────
  ipcMain.handle('window-state:get', () => windowState.get());
  ipcMain.handle('window-state:set', (_e, partial) => {
    windowState.update(partial);
    // debounce 寫檔
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
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setIgnoreMouseEvents(false);
    }
  });
  ipcMain.on('mouse:leave-character', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
    }
  });

  // ── shell ──────────────────────────────────────────────
  ipcMain.handle('shell:open-config-dir', () => {
    return shell.openPath(path.join(PROJECT_ROOT, 'config'));
  });

  // ── 環境查詢（renderer 顯示用） ───────────────────────
  ipcMain.handle('env:info', () => ({
    isDev: IS_DEV,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
  }));

  // ── 對話氣泡（M2 / M2.5）─────────────────────────────
  // M3 之後 TriggerEngine 會接管 dialogue:show 的觸發；M2 階段先讓 debug 按鈕
  // 透過 round-trip IPC 模擬「main → renderer」的推送方向，便於日後直接接管。
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

  // M2.5：選項分支
  ipcMain.on('dialogue:choice-selected', (_e, payload) => {
    if (IS_DEV) console.log('[main] dialogue:choice-selected', payload);
    if (!payload || !payload.next) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const nextSeq = lookupDemoSequence(payload.next);
    if (nextSeq) {
      // 短延遲，等舊氣泡淡出再顯示新的
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('dialogue:show', nextSeq);
        }
      }, 250);
    }
  });
}

// ── 範例對話序列（M2 + M2.5）──────────────────────────
// 走到 M4 後，這份會被 dialogues.json 取代；目前作為 dev 測試用。
const DEMO_SEQUENCES = {
  // ── M2 基本 ─────────────────────────────────────────
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

  // ── M2.5 type 變體 ──────────────────────────────────
  thought: {
    sequenceId: 'demo_thought',
    type: 'thought',
    interaction: 'display',
    auto_close_ms: 6000,
    lines: [
      { text: '（這人怎麼又熬夜⋯⋯）' },
    ],
  },
  narration: {
    sequenceId: 'demo_narration',
    type: 'narration',
    interaction: 'display',
    auto_close_ms: 6000,
    lines: [
      { text: '使用者已連續操作 4 小時 23 分。' },
    ],
  },
  system: {
    sequenceId: 'demo_system',
    type: 'system',
    interaction: 'display',
    auto_close_ms: 5000,
    lines: [
      { text: '正在生成新台詞庫… 67%' },
    ],
  },
  whisper: {
    sequenceId: 'demo_whisper',
    type: 'whisper',
    interaction: 'display',
    auto_close_ms: 5000,
    lines: [
      { text: '（小聲）你電量剩 18% 了喔' },
    ],
  },

  // ── M2.5 persistence 變體 ───────────────────────────
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
    lines: [
      { text: '我是釘選氣泡，左上有 📌', expression: 'idle' },
    ],
  },

  // ── M2.5 interaction=choice ─────────────────────────
  choice: {
    sequenceId: 'demo_choice',
    type: 'speech',
    persistence: 'persistent',
    interaction: 'choice',
    lines: [
      { text: '你連續工作 4 小時了，要不要：', expression: 'annoyed' },
    ],
    choices: [
      { label: '休息 5 分鐘',   next: 'rest_path' },
      { label: '關掉通知一下', next: 'silence_path' },
      { label: '不用管我',     next: null },
    ],
  },
  rest_path: {
    sequenceId: 'rest_path',
    type: 'speech',
    lines: [
      { text: '好，我 5 分鐘後叫你', expression: 'happy' },
    ],
  },
  silence_path: {
    sequenceId: 'silence_path',
    type: 'system',
    interaction: 'display',
    auto_close_ms: 4000,
    lines: [
      { text: '（已切換到請勿打擾）' },
    ],
  },

  // ── M2.5 interaction=binary_split（二元分區，左綠右紅）──
  binary: {
    sequenceId: 'demo_binary',
    type: 'speech',
    persistence: 'persistent',
    interaction: 'binary_split',
    lines: [
      { text: '你要休息一下嗎？', expression: 'idle' },
    ],
    binary: {
      left:  { label: '好啊',  next: 'rest_path' },
      right: { label: '不要',  next: 'binary_decline' },
    },
  },
  binary_decline: {
    sequenceId: 'binary_decline',
    type: 'thought',
    interaction: 'display',
    auto_close_ms: 4000,
    lines: [
      { text: '（哼，那就隨便你⋯⋯）' },
    ],
  },
};

function lookupDemoSequence(idOrVariant) {
  return DEMO_SEQUENCES[idOrVariant] || DEMO_SEQUENCES.medium;
}
