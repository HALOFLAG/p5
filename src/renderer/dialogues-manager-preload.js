// p5 對話庫管理視窗 preload（M4.5）
// 與主視窗 / settings / debug-panel 視窗 preload 分開，
// 只暴露 dialogues:* 與 personas:list 相關 IPC。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dialoguesApi', {
  // ── persona 列表（人格切換 dropdown 用）──
  personasList: () => ipcRenderer.invoke('personas:list'),

  // ── persona pack 管理（R4）──
  personaPackReveal: (personaId) => ipcRenderer.invoke('persona-pack:reveal', { personaId }),
  personaPackImport: () => ipcRenderer.invoke('persona-pack:import'),
  personaPackList: () => ipcRenderer.invoke('persona-pack:list'),
  personaPackWipeContent: (personaId) => ipcRenderer.invoke('persona-pack:wipe-content', { personaId }),

  // ── Tab 1：瀏覽 / 編輯 ──
  read: (persona) => ipcRenderer.invoke('dialogues:read', { persona }),
  readInitial: (persona) => ipcRenderer.invoke('dialogues:read-initial', { persona }),
  save: (persona, data) => ipcRenderer.invoke('dialogues:save', { persona, data }),
  listCategories: (persona) => ipcRenderer.invoke('dialogues:list-categories', { persona }),

  // ── Tab 2：批次匯入 ──
  batchImport: (payload) => ipcRenderer.invoke('dialogues:batch-import', payload),

  // ── Tab 3：統計 ──
  fireStats: (persona, days) => ipcRenderer.invoke('dialogues:fire-stats', { persona, days }),

  // ── Tab 4：LLM Prompt ──
  genPrompt: (persona, category, options) => ipcRenderer.invoke('dialogues:gen-prompt', { persona, category, ...(options || {}) }),
  listCategoryInfo: () => ipcRenderer.invoke('dialogues:list-category-info'),
  getCategoryInfo: (category) => ipcRenderer.invoke('dialogues:get-category-info', { category }),

  // ── Trigger rules（給 Tab 1 顯示觸發條件用）──
  triggersListRules: () => ipcRenderer.invoke('triggers:list-rules'),

  // ── Tab 5：語音生成（M6）──
  voiceCheckEngine: () => ipcRenderer.invoke('voice:check-engine'),

  // 引擎子進程 lifecycle ──
  voiceEngineGetStatus: () => ipcRenderer.invoke('voice:engine-get-status'),
  voiceEngineConfigGet: () => ipcRenderer.invoke('voice:engine-config-get'),
  voiceEngineConfigSet: (cfg) => ipcRenderer.invoke('voice:engine-config-set', cfg),
  voiceEngineStart: () => ipcRenderer.invoke('voice:engine-start'),
  voiceEngineStop: () => ipcRenderer.invoke('voice:engine-stop'),
  voiceEngineOnLog: (handler) => ipcRenderer.on('voice:engine-log', (_e, line) => handler(line)),
  voiceEngineOnStatus: (handler) => ipcRenderer.on('voice:engine-status', (_e, payload) => handler(payload)),
  voiceGetConfig: () => ipcRenderer.invoke('voice:get-config'),
  voiceSetConfig: (cfg) => ipcRenderer.invoke('voice:set-config', cfg),
  voiceTestTTS: (persona, text, lang) => ipcRenderer.invoke('voice:test-tts', { persona, text, lang }),
  voiceListStats: (persona, lang) => ipcRenderer.invoke('voice:list-stats', { persona, lang }),
  voiceGetStatus: (persona, sequenceId, lineIdx, lang) =>
    ipcRenderer.invoke('voice:get-status', { persona, sequenceId, lineIdx, lang }),
  voiceGenerateBatch: (persona, mode, lang) => ipcRenderer.invoke('voice:generate-batch', { persona, mode, lang }),
  voiceCancel: () => ipcRenderer.invoke('voice:cancel'),
  voiceOnProgress: (handler) => ipcRenderer.on('voice:progress', (_e, payload) => handler(payload)),
  voiceOnBatchDone: (handler) => ipcRenderer.on('voice:batch-done', (_e, payload) => handler(payload)),

  // ── Tab 6：時間語音（P3 / Tab 6）──
  voiceListTimeStats: (persona, lang) => ipcRenderer.invoke('voice:list-time-stats', { persona, lang }),
  voiceSetTimeTextOverride: (persona, lang, key, text) =>
    ipcRenderer.invoke('voice:set-time-text-override', { persona, lang, key, text }),
  voiceResetTimeTextOverride: (persona, lang, key) =>
    ipcRenderer.invoke('voice:reset-time-text-override', { persona, lang, key }),
  voiceResetAllTimeOverrides: (persona, lang) =>
    ipcRenderer.invoke('voice:reset-all-time-overrides', { persona, lang }),
  voiceRegenerateTimeOne: (persona, lang, key) =>
    ipcRenderer.invoke('voice:regenerate-time-one', { persona, lang, key }),
  voiceDeleteTimeOne: (persona, lang, key) =>
    ipcRenderer.invoke('voice:delete-time-one', { persona, lang, key }),
  voiceGenerateTimeBatch: (persona, mode, lang) =>
    ipcRenderer.invoke('voice:generate-time-batch', { persona, mode, lang }),

  // ── 視窗控制 ──
  envInfo: () => ipcRenderer.invoke('env:info'),
  close: () => ipcRenderer.send('dialogues-manager-window:close'),
});
