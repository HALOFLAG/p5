// p5 對話庫管理視窗 preload（M4.5）
// 與主視窗 / settings / debug-panel 視窗 preload 分開，
// 只暴露 dialogues:* 與 personas:list 相關 IPC。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dialoguesApi', {
  // ── persona 列表（人格切換 dropdown 用）──
  personasList: () => ipcRenderer.invoke('personas:list'),

  // ── Tab 1：瀏覽 / 編輯 ──
  read: (persona) => ipcRenderer.invoke('dialogues:read', { persona }),
  readInitial: (persona) => ipcRenderer.invoke('dialogues:read-initial', { persona }),
  save: (persona, data) => ipcRenderer.invoke('dialogues:save', { persona, data }),

  // ── Tab 2：批次匯入 ──
  batchImport: (payload) => ipcRenderer.invoke('dialogues:batch-import', payload),

  // ── Tab 3：統計 ──
  fireStats: (persona, days) => ipcRenderer.invoke('dialogues:fire-stats', { persona, days }),

  // ── Tab 4：LLM Prompt ──
  genPrompt: (persona, category) => ipcRenderer.invoke('dialogues:gen-prompt', { persona, category }),

  // ── Tab 5：語音生成（M6）──
  voiceCheckEngine: () => ipcRenderer.invoke('voice:check-engine'),
  voiceGetConfig: () => ipcRenderer.invoke('voice:get-config'),
  voiceSetConfig: (cfg) => ipcRenderer.invoke('voice:set-config', cfg),
  voiceTestTTS: (persona, text, lang) => ipcRenderer.invoke('voice:test-tts', { persona, text, lang }),
  voiceListStats: (persona, lang) => ipcRenderer.invoke('voice:list-stats', { persona, lang }),
  voiceGenerateBatch: (persona, mode, lang) => ipcRenderer.invoke('voice:generate-batch', { persona, mode, lang }),
  voiceCancel: () => ipcRenderer.invoke('voice:cancel'),
  voiceOnProgress: (handler) => ipcRenderer.on('voice:progress', (_e, payload) => handler(payload)),
  voiceOnBatchDone: (handler) => ipcRenderer.on('voice:batch-done', (_e, payload) => handler(payload)),

  // ── 視窗控制 ──
  envInfo: () => ipcRenderer.invoke('env:info'),
  close: () => ipcRenderer.send('dialogues-manager-window:close'),
});
