// p5 Debug 面板 preload
// 與主視窗 / settings 視窗 preload 分開：只暴露 debug:* 相關 IPC，
// 避免 dialogue / character 等 API 流入 debug 視窗。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('debugApi', {
  // ── 即時狀態 ───────────────────────────────
  countersGet: () => ipcRenderer.invoke('debug:counters:get'),
  envGet: () => ipcRenderer.invoke('debug:env:get'),
  contextStateGet: () => ipcRenderer.invoke('debug:context-state:get'),
  pluginsStatus: () => ipcRenderer.invoke('debug:plugins:status'),
  rulesStatus: () => ipcRenderer.invoke('debug:rules:status'),

  // ── 歷史 / 聚合 ────────────────────────────
  triggerHistory: (limit) => ipcRenderer.invoke('debug:trigger-history', { limit: limit || 50 }),
  heatmap: (opts) => ipcRenderer.invoke('debug:heatmap', opts || {}),
  appUsage: (opts) => ipcRenderer.invoke('debug:app-usage', opts || {}),

  // ── 動作 ───────────────────────────────────
  fire: (rule) => ipcRenderer.send('debug:fire', { rule_name: rule }),
  resetCooldowns: () => ipcRenderer.send('debug:reset-cooldowns'),
  flushEvents: () => ipcRenderer.invoke('debug:flush-events'),
  purgeEvents: () => ipcRenderer.invoke('debug:purge-events'),

  // ── env / window ──────────────────────────
  envInfo: () => ipcRenderer.invoke('env:info'),
  close: () => ipcRenderer.send('debug-panel-window:close'),
});
