const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (partial) => ipcRenderer.invoke('settings:set', partial),
    open: () => ipcRenderer.invoke('settings:open'),
  },
  windowState: {
    get: () => ipcRenderer.invoke('window-state:get'),
    set: (partial) => ipcRenderer.invoke('window-state:set', partial),
    onInitial: (handler) => {
      ipcRenderer.on('window-state:initial', (_e, state) => handler(state));
    },
  },
  mouse: {
    enterCharacter: () => ipcRenderer.send('mouse:enter-character'),
    leaveCharacter: () => ipcRenderer.send('mouse:leave-character'),
  },
  shell: {
    openConfigDir: () => ipcRenderer.invoke('shell:open-config-dir'),
  },
  env: {
    info: () => ipcRenderer.invoke('env:info'),
  },
  dialogue: {
    onShow: (handler) => {
      ipcRenderer.on('dialogue:show', (_e, sequence) => handler(sequence));
    },
    onDismiss: (handler) => {
      ipcRenderer.on('dialogue:dismiss', (_e, payload) => handler(payload));
    },
    advance: (payload) => ipcRenderer.send('dialogue:advance', payload),
    dismissAck: (payload) => ipcRenderer.send('dialogue:dismiss-ack', payload),
    choiceSelected: (payload) => ipcRenderer.send('dialogue:choice-selected', payload),
  },
  character: {
    dragStart: () => ipcRenderer.send('character:drag-start'),
  },
  debug: {
    testBubble: (variant) => ipcRenderer.send('debug:test-bubble', { variant }),
    countersGet: () => ipcRenderer.invoke('debug:counters:get'),
    envGet: () => ipcRenderer.invoke('debug:env:get'),
    contextStateGet: () => ipcRenderer.invoke('debug:context-state:get'),
    pluginsStatus: () => ipcRenderer.invoke('debug:plugins:status'),
    rulesStatus: () => ipcRenderer.invoke('debug:rules:status'),
    fire: (ruleName) => ipcRenderer.send('debug:fire', { rule_name: ruleName }),
    resetCooldowns: () => ipcRenderer.send('debug:reset-cooldowns'),
    flushEvents: () => ipcRenderer.invoke('debug:flush-events'),
    purgeEvents: () => ipcRenderer.invoke('debug:purge-events'),
    triggerHistory: (limit) => ipcRenderer.invoke('debug:trigger-history', { limit: limit || 50 }),
  },
});
