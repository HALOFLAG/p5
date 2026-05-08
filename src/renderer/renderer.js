// p5 renderer (M2)
//
// 職責：
//   - dev-box 拖曳、滑鼠穿透切換（M1 已有）
//   - SpeechBubble 整合與錨點維護（M2 新增）
//   - dev 按鈕觸發 dialogue:show round-trip 測試
//
// 滑鼠穿透架構：
//   整個視窗預設穿透。任何「互動元素」（dev-box、bubble）hover 時 → 取消穿透；
//   leave 時 debounce 後恢復。互動元素間切換不閃爍。

(function () {
  const devBox = document.getElementById('dev-box');
  const envMeta = document.getElementById('env-meta');
  const devInfo = document.getElementById('dev-info');
  const bubbleEl = document.getElementById('bubble');
  const devButtons = document.querySelectorAll('.dev-btn');

  let state = { character_x: 200, character_y: 200 };
  let initialized = false;

  function applyPosition() {
    devBox.style.left = `${state.character_x}px`;
    devBox.style.top = `${state.character_y}px`;
    updateBubbleAnchor();
  }

  function setInitial(s) {
    if (initialized) return;
    state = { ...state, ...s };
    applyPosition();
    initialized = true;
  }

  // ── 初始位置 ──────────────────────────────────────────
  window.api.windowState.onInitial(setInitial);
  window.api.windowState.get().then(setInitial).catch((err) => {
    console.warn('windowState.get failed:', err);
    applyPosition();
  });

  // ── 環境資訊 ──────────────────────────────────────────
  window.api.env
    .info()
    .then((info) => {
      envMeta.textContent = `Electron ${info.electronVersion} / Node ${info.nodeVersion}${
        info.isDev ? ' / DEV' : ''
      }`;
      if (info.isDev) {
        devInfo.textContent = 'M3 監聽 + 觸發（DEV）';
      } else {
        devInfo.textContent = 'M3 監聽 + 觸發';
      }
    })
    .catch(() => {
      envMeta.textContent = '(env info unavailable)';
    });

  // ── 滑鼠穿透切換（共用 helper）─────────────────────────
  // 互動元素：dev-box 與 bubble。任一在 hover 時即取消穿透。
  let leaveTimer = null;
  let hoverCount = 0;

  function activateMouse() {
    hoverCount++;
    if (leaveTimer) {
      clearTimeout(leaveTimer);
      leaveTimer = null;
    }
    if (hoverCount === 1) {
      window.api.mouse.enterCharacter();
    }
  }

  function deactivateMouse() {
    hoverCount = Math.max(0, hoverCount - 1);
    if (hoverCount === 0) {
      if (leaveTimer) clearTimeout(leaveTimer);
      leaveTimer = setTimeout(() => {
        if (!dragging && hoverCount === 0) window.api.mouse.leaveCharacter();
      }, 80);
    }
  }

  devBox.addEventListener('mouseenter', activateMouse);
  devBox.addEventListener('mouseleave', deactivateMouse);

  // ── 對話氣泡 ───────────────────────────────────────────
  const bubble = new window.p5.SpeechBubble(bubbleEl, {
    onAdvance: (payload) => {
      window.api.dialogue.advance(payload);
    },
    onDismiss: (payload) => {
      window.api.dialogue.dismissAck(payload);
    },
    onChoiceSelected: (payload) => {
      window.api.dialogue.choiceSelected(payload);
    },
    onMouseEnter: activateMouse,
    onMouseLeave: deactivateMouse,
  });

  // ── ESC 關閉 persistent / pinned ───────────────────────
  // 注意：ESC 只在視窗有焦點時生效；persistent 主要關閉路徑是右上 ✕ 鈕
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && bubble.isVisible()) {
      bubble.dismiss('escape');
    }
  });

  function updateBubbleAnchor() {
    // 角色錨點：dev-box 的「上邊中點」
    const anchorX = state.character_x + devBox.offsetWidth / 2;
    const anchorY = state.character_y; // dev-box 的 top
    bubble.setAnchor(anchorX, anchorY);
  }

  window.api.dialogue.onShow((sequence) => {
    updateBubbleAnchor();
    bubble.show(sequence);
  });

  // ── Debug 按鈕（M2.5 UI 變體 + M3 debug 面板）────────
  devButtons.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.dataset.variant) {
        window.api.debug.testBubble(btn.dataset.variant);
      } else if (btn.dataset.debug) {
        handleDebugAction(btn.dataset.debug).catch((err) =>
          console.warn('[M3 debug]', btn.dataset.debug, 'failed:', err)
        );
      }
    });
  });

  // 阻止按鈕區域觸發拖曳（涵蓋所有 .dev-buttons 區塊）
  document.querySelectorAll('.dev-buttons').forEach((row) => {
    row.addEventListener('mousedown', (e) => e.stopPropagation());
  });

  async function handleDebugAction(action) {
    switch (action) {
      case 'counters': {
        const data = await window.api.debug.countersGet();
        console.log('[M3 counters]', data);
        break;
      }
      case 'context-state': {
        const data = await window.api.debug.contextStateGet();
        console.log('[M3 context-state]', data);
        break;
      }
      case 'fire-click': {
        window.api.debug.fire('click_too_much');
        console.log('[M3] fire click_too_much');
        break;
      }
      case 'reset-cd': {
        window.api.debug.resetCooldowns();
        console.log('[M3] cooldowns reset');
        break;
      }
      case 'purge': {
        if (!confirm('確定要清空所有 events JSONL 與 stats 嗎？此操作不可復原。')) return;
        await window.api.debug.purgeEvents();
        console.log('[M3] events purged');
        break;
      }
      default:
        console.warn('[M3 debug] unknown action:', action);
    }
  }

  // ── 拖曳 ───────────────────────────────────────────────
  let dragging = false;
  let dragOrigin = { mouseX: 0, mouseY: 0, boxX: 0, boxY: 0 };

  devBox.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    // 點到按鈕不觸發拖曳（上面 stopPropagation 已處理，這裡再防一次）
    if (e.target.closest('.dev-btn')) return;
    dragging = true;
    devBox.classList.add('dragging');
    dragOrigin = {
      mouseX: e.screenX,
      mouseY: e.screenY,
      boxX: state.character_x,
      boxY: state.character_y,
    };
    // M3：通知 main 角色被拖曳，TriggerEngine 會 fire drag 規則
    try { window.api.character.dragStart(); } catch (_e) { /* M2 fallback */ }
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    state.character_x = clamp(
      dragOrigin.boxX + (e.screenX - dragOrigin.mouseX),
      0,
      window.innerWidth - devBox.offsetWidth
    );
    state.character_y = clamp(
      dragOrigin.boxY + (e.screenY - dragOrigin.mouseY),
      0,
      window.innerHeight - devBox.offsetHeight
    );
    applyPosition();
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    devBox.classList.remove('dragging');
    window.api.windowState
      .set({ character_x: state.character_x, character_y: state.character_y })
      .catch((err) => console.warn('windowState.set failed:', err));
  });

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }
})();
