const { Tray, Menu, app, shell, nativeImage } = require('electron');
const path = require('node:path');

function createTray({ getMainWindow, projectRoot }) {
  const iconPath = path.join(projectRoot, 'assets', 'tray-icon.png');
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    // Fallback：1x1 透明像素，避免崩潰
    image = nativeImage.createFromBuffer(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
        'base64'
      )
    );
  }
  const tray = new Tray(image);
  tray.setToolTip('p5 桌面寵物');

  const buildMenu = () => {
    const win = getMainWindow();
    const visible = win && win.isVisible();
    return Menu.buildFromTemplate([
      {
        label: visible ? '隱藏' : '顯示',
        click: () => {
          const w = getMainWindow();
          if (!w) return;
          if (w.isVisible()) w.hide();
          else w.show();
        },
      },
      { type: 'separator' },
      {
        label: '開啟設定資料夾',
        click: () => shell.openPath(path.join(projectRoot, 'config')),
      },
      {
        label: '開啟資料資料夾（敏感）',
        click: () => shell.openPath(path.join(projectRoot, 'data')),
      },
      { type: 'separator' },
      {
        label: '結束 p5',
        click: () => app.quit(),
      },
    ]);
  };

  tray.setContextMenu(buildMenu());
  tray.on('click', () => tray.popUpContextMenu(buildMenu()));
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));

  return tray;
}

module.exports = { createTray };
