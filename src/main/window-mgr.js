const { BrowserWindow, screen } = require('electron');
const path = require('node:path');

function createMainWindow() {
  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.size;

  const win = new BrowserWindow({
    width,
    height,
    x: primary.bounds.x,
    y: primary.bounds.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 預設整個視窗滑鼠穿透；renderer 偵測到 hover 時透過 IPC 取消穿透。
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setAlwaysOnTop(true, 'screen-saver');

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  return win;
}

/**
 * Settings 視窗：M4 Phase 2 新增。
 *
 * 與主視窗刻意分開：有邊框、有標題列、可縮放、不穿透、不置頂、不全螢幕。
 * 使用獨立 preload (settings-preload.js)，只暴露 settings 相關 IPC，
 * 避免 dialogue / debug 等不必要 API 流入這個視窗。
 */
function createSettingsWindow() {
  const primary = screen.getPrimaryDisplay();
  const winWidth = 720;
  const winHeight = 620;
  const x = Math.round(primary.bounds.x + (primary.size.width - winWidth) / 2);
  const y = Math.round(primary.bounds.y + (primary.size.height - winHeight) / 2);

  const win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    minWidth: 520,
    minHeight: 480,
    x,
    y,
    title: 'p5 設定',
    show: false,
    frame: true,
    transparent: false,
    alwaysOnTop: false,
    resizable: true,
    movable: true,
    skipTaskbar: false,
    hasShadow: true,
    fullscreenable: false,
    minimizable: true,
    maximizable: true,
    focusable: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'settings-window.html'));
  win.once('ready-to-show', () => win.show());

  return win;
}

/**
 * Debug 面板視窗：M4 Phase 3 新增。
 *
 * 比 settings 視窗稍大（資訊量多）：1100×750。
 * 其餘屬性與 settings 一致：普通邊框、可縮放、不穿透、不置頂。
 * 獨立 preload (debug-panel-preload.js) 只暴露 debug:* 相關 IPC。
 */
function createDebugPanelWindow() {
  const primary = screen.getPrimaryDisplay();
  const winWidth = 1100;
  const winHeight = 750;
  const x = Math.round(primary.bounds.x + (primary.size.width - winWidth) / 2);
  const y = Math.round(primary.bounds.y + (primary.size.height - winHeight) / 2);

  const win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    minWidth: 720,
    minHeight: 540,
    x,
    y,
    title: 'p5 Debug 面板',
    show: false,
    frame: true,
    transparent: false,
    alwaysOnTop: false,
    resizable: true,
    movable: true,
    skipTaskbar: false,
    hasShadow: true,
    fullscreenable: false,
    minimizable: true,
    maximizable: true,
    focusable: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'debug-panel-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'debug-panel.html'));
  win.once('ready-to-show', () => win.show());

  return win;
}

/**
 * 對話庫管理視窗：M4.5 新增。
 *
 * 比 debug 面板更大（資料量多，要列 sequences 表格 + 編輯區）：1200×780。
 * 屬性與其他工具視窗一致：普通邊框、可縮放、不穿透、不置頂。
 * 獨立 preload (dialogues-manager-preload.js) 只暴露 dialogues:* 相關 IPC。
 */
function createDialoguesManagerWindow() {
  const primary = screen.getPrimaryDisplay();
  const winWidth = 1200;
  const winHeight = 780;
  const x = Math.round(primary.bounds.x + (primary.size.width - winWidth) / 2);
  const y = Math.round(primary.bounds.y + (primary.size.height - winHeight) / 2);

  const win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    minWidth: 880,
    minHeight: 600,
    x,
    y,
    title: 'p5 對話庫管理',
    show: false,
    frame: true,
    transparent: false,
    alwaysOnTop: false,
    resizable: true,
    movable: true,
    skipTaskbar: false,
    hasShadow: true,
    fullscreenable: false,
    minimizable: true,
    maximizable: true,
    focusable: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'dialogues-manager-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'dialogues-manager-window.html'));
  win.once('ready-to-show', () => win.show());

  return win;
}

module.exports = {
  createMainWindow,
  createSettingsWindow,
  createDebugPanelWindow,
  createDialoguesManagerWindow,
};
