// p5 settings 視窗 preload
// 與主視窗 preload 分開：避免暴露不必要的 API（dialogue / debug 等）給設定視窗。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (partial) => ipcRenderer.invoke('settings:set', partial),
  personasList: () => ipcRenderer.invoke('personas:list'),
  debugPanelOpen: () => ipcRenderer.send('debug-panel:open'),
  openConfigDir: () => ipcRenderer.invoke('shell:open-config-dir'),
  envInfo: () => ipcRenderer.invoke('env:info'),
  close: () => ipcRenderer.send('settings-window:close'),
});
