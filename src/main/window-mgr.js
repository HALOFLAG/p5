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

module.exports = { createMainWindow };
