// p5 renderer (M5a)
//
// 職責：
//   - CharacterStage：色塊 placeholder 渲染 + 拖曳 + 邊界保護
//   - dev-panel：右上摺疊 dev tools（取代既有 dev-box 中央位置）
//   - SpeechBubble：對話氣泡，anchor 跟隨 character-stage
//   - dialogue:show 接 expression → stage.setExpression
//   - persona:changed → 重新拉 persona 資料更新 stage
//
// 滑鼠穿透架構：
//   整個視窗預設穿透。互動元素（character-stage / dev-panel / bubble）任一 hover → 取消穿透。
//   leave debounce 80ms 後恢復。互動元素間切換不閃爍。

(function () {
  const stageEl = document.getElementById('character-stage');
  const devPanel = document.getElementById('dev-panel');
  const devToggle = document.getElementById('dev-panel-toggle');
  const envMeta = document.getElementById('env-meta');
  const devInfo = document.getElementById('dev-info');
  const bubbleEl = document.getElementById('bubble');
  const devButtons = document.querySelectorAll('.dev-btn');

  const stage = new window.p5.CharacterStage(stageEl, { fadeMs: 200 });

  // 色塊基準尺寸 + 邊界保護
  const BASE_STAGE_W = 200;
  const BASE_STAGE_H = 400;
  const EDGE_MARGIN = 50;
  // 動態計算實際尺寸（依 stageScale）
  let stageScale = 1.0;
  let STAGE_W = BASE_STAGE_W;
  let STAGE_H = BASE_STAGE_H;

  // M5a-real 操作狀態
  let stageHidden = false;
  let idleOpacity = 1.0;

  // ── 位置狀態（character-stage 取代 dev-box）─────────────
  let pos = { character_x: 200, character_y: 200 };
  let initialized = false;

  function applyPosition() {
    stageEl.style.left = `${pos.character_x}px`;
    stageEl.style.top = `${pos.character_y}px`;
    syncDevPanelPosition();
    updateBubbleAnchor();
  }

  function applyStageSize() {
    STAGE_W = Math.round(BASE_STAGE_W * stageScale);
    STAGE_H = Math.round(BASE_STAGE_H * stageScale);
    stageEl.style.width = `${STAGE_W}px`;
    stageEl.style.height = `${STAGE_H}px`;
    applyPosition();
  }

  function applyVisibility() {
    stageEl.style.display = stageHidden ? 'none' : '';
    const btn = document.getElementById('btn-toggle-hide');
    if (btn) btn.textContent = stageHidden ? '顯示' : '隱藏';
    // 隱藏時 dev-panel 仍應在原位置；不必動 dev-panel
  }

  function applyOpacity() {
    // 互動中（hover / drag / 氣泡顯示）→ 1.0；閒置 → idleOpacity
    const interacting = hoverCount > 0 || dragging || bubble.isVisible();
    stageEl.style.opacity = stageHidden ? '0' : String(interacting ? 1.0 : idleOpacity);
  }

  // dev-panel 跟著 character-stage 右下方：toggle 對齊色塊底部，內容往上展開
  // 但使用者「正在跟 dev-panel 內部互動（拉 slider / 點按鈕）」時不能跟著動，
  // 否則 stage 大小變化會把 dev-panel 推走、滑桿被拉走無法操作。
  let devPanelInteracting = false;
  function syncDevPanelPosition() {
    if (devPanelInteracting) return;   // 互動中凍結位置
    const stageRight = pos.character_x + STAGE_W;
    const stageBottom = pos.character_y + STAGE_H;
    devPanel.style.left = `${stageRight + 4}px`;
    // bottom 從 viewport 底算回去，使 toggle 鎖在 stage 底部高度，content 加進來時往上長
    devPanel.style.bottom = `${Math.max(0, window.innerHeight - stageBottom)}px`;
  }

  function setInitial(s) {
    if (initialized) return;
    pos = { ...pos, ...s };
    applyPosition();
    initialized = true;
  }

  window.api.windowState.onInitial(setInitial);
  window.api.windowState.get().then(setInitial).catch((err) => {
    console.warn('windowState.get failed:', err);
    applyPosition();
  });

  // ── 環境資訊 ──────────────────────────────────────────
  window.api.env.info()
    .then((info) => {
      envMeta.textContent = `Electron ${info.electronVersion} / Node ${info.nodeVersion}${info.isDev ? ' / DEV' : ''}`;
      devInfo.textContent = info.isDev ? 'M5a 色塊 placeholder（DEV）' : 'M5a 色塊 placeholder';
    })
    .catch(() => { envMeta.textContent = '(env info unavailable)'; });

  // ── 載入當前 persona 並套到 stage ───────────────────
  async function loadActivePersona() {
    try {
      const settings = await window.api.settings.get();
      const id = settings?.active_persona;
      if (!id) return;
      const persona = await window.api.personas.get(id);
      if (persona) stage.setPersona(persona);
    } catch (err) {
      console.warn('[stage] load persona failed:', err);
    }
  }
  loadActivePersona();

  // 設定切人格 → 重拉 persona 資料 + 重置表情為 idle
  window.api.personas.onChanged(async () => {
    await loadActivePersona();
    stage.setExpression('idle');
  });

  // ── 滑鼠穿透切換 ─────────────────────────────────────
  let leaveTimer = null;
  let hoverCount = 0;

  function activateMouse() {
    hoverCount++;
    if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
    if (hoverCount === 1) window.api.mouse.enterCharacter();
    applyOpacity();
  }
  function deactivateMouse() {
    hoverCount = Math.max(0, hoverCount - 1);
    if (hoverCount === 0) {
      if (leaveTimer) clearTimeout(leaveTimer);
      leaveTimer = setTimeout(() => {
        if (!dragging && hoverCount === 0) {
          window.api.mouse.leaveCharacter();
          applyOpacity();
        }
      }, 80);
    }
  }

  stageEl.addEventListener('mouseenter', activateMouse);
  stageEl.addEventListener('mouseleave', deactivateMouse);
  devPanel.addEventListener('mouseenter', activateMouse);
  devPanel.addEventListener('mouseleave', deactivateMouse);

  // ── 對話氣泡 ───────────────────────────────────────────
  const bubble = new window.p5.SpeechBubble(bubbleEl, {
    onAdvance: (payload) => window.api.dialogue.advance(payload),
    onDismiss: (payload) => window.api.dialogue.dismissAck(payload),
    onChoiceSelected: (payload) => window.api.dialogue.choiceSelected(payload),
    onMouseEnter: activateMouse,
    onMouseLeave: deactivateMouse,
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && bubble.isVisible()) bubble.dismiss('escape');
  });

  function updateBubbleAnchor() {
    const anchor = stage.getBubbleAnchor();
    bubble.setAnchor(anchor.x, anchor.y);
  }

  window.api.dialogue.onShow((sequence) => {
    // 抽 lines[0].expression → 切 stage 色塊
    const expr = sequence?.lines?.[0]?.expression;
    if (expr) stage.setExpression(expr);

    updateBubbleAnchor();
    bubble.show(sequence);
    applyOpacity();   // 氣泡顯示時保證 stage 不透明
  });

  // ── M6 voice 播放 ───────────────────────────────────
  let currentVoiceAudio = null;
  window.api.voice?.onPlay((payload) => {
    if (!payload?.file_path) return;
    // 打斷既有播放
    if (currentVoiceAudio) {
      try { currentVoiceAudio.pause(); } catch (_e) {}
      currentVoiceAudio = null;
    }
    // file:// path 在 Windows 要把 \\ 換 /
    const url = `file:///${payload.file_path.replace(/\\/g, '/')}`;
    const audio = new Audio(url);
    // 音量跟設定 volume 連動
    window.api.settings.get().then((s) => {
      audio.volume = Number.isFinite(s?.volume) ? s.volume : 0.6;
    }).catch(() => { audio.volume = 0.6; });
    audio.play().catch((err) => console.warn('[voice] play failed:', err));
    currentVoiceAudio = audio;
  });

  // 切人格 / dismiss 時也應該停止語音播放
  window.api.dialogue.onDismiss(() => {
    if (currentVoiceAudio) {
      try { currentVoiceAudio.pause(); } catch (_e) {}
      currentVoiceAudio = null;
    }
    applyOpacity();   // 氣泡關閉，恢復閒置透明度
  });

  // ── dev-panel 摺疊切換 ─────────────────────────────
  devToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    devPanel.classList.toggle('collapsed');
  });

  // dev 按鈕事件
  devButtons.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.dataset.variant) {
        window.api.debug.testBubble(btn.dataset.variant);
      } else if (btn.dataset.debug) {
        handleDebugAction(btn.dataset.debug).catch((err) =>
          console.warn('[M3 debug]', btn.dataset.debug, 'failed:', err)
        );
      } else if (btn.dataset.action === 'open-settings') {
        window.api.settings.open().catch((err) =>
          console.warn('[M4] open settings failed:', err)
        );
      } else if (btn.dataset.action === 'open-dialogues') {
        window.api.dialogues.openManager().catch((err) =>
          console.warn('[M4.5] open dialogues manager failed:', err)
        );
      } else if (btn.dataset.action === 'toggle-hide') {
        stageHidden = !stageHidden;
        applyVisibility();
        applyOpacity();
      } else if (btn.dataset.action === 'random-fire') {
        window.api.debug.randomFire();
      }
    });
  });

  // M5a-real：透明度 slider
  const opacitySlider = document.getElementById('idle-opacity');
  const opacityValue = document.getElementById('idle-opacity-value');
  if (opacitySlider && opacityValue) {
    opacitySlider.addEventListener('input', () => {
      idleOpacity = parseFloat(opacitySlider.value);
      opacityValue.textContent = `${Math.round(idleOpacity * 100)}%`;
      applyOpacity();
    });
    opacitySlider.addEventListener('change', () => {
      // 放開後存 settings
      window.api.settings.set({ idle_opacity: idleOpacity }).catch((err) =>
        console.warn('[settings] save idle_opacity failed:', err)
      );
    });
  }

  // M5a-real：人物大小 slider
  const scaleSlider = document.getElementById('character-scale');
  const scaleValue = document.getElementById('character-scale-value');
  if (scaleSlider && scaleValue) {
    scaleSlider.addEventListener('input', () => {
      stageScale = parseFloat(scaleSlider.value);
      scaleValue.textContent = `${Math.round(stageScale * 100)}%`;
      applyStageSize();
    });
    scaleSlider.addEventListener('change', () => {
      window.api.settings.set({ character_scale: stageScale }).catch((err) =>
        console.warn('[settings] save character_scale failed:', err)
      );
    });
  }

  // 從 settings 載入持久值（async，跑在 IIFE 結束之後）
  window.api.settings.get().then((s) => {
    if (Number.isFinite(s?.idle_opacity)) {
      idleOpacity = Math.max(0.1, Math.min(1.0, s.idle_opacity));
      if (opacitySlider) opacitySlider.value = String(idleOpacity);
      if (opacityValue) opacityValue.textContent = `${Math.round(idleOpacity * 100)}%`;
    }
    if (Number.isFinite(s?.character_scale)) {
      stageScale = Math.max(0.5, Math.min(2.0, s.character_scale));
      if (scaleSlider) scaleSlider.value = String(stageScale);
      if (scaleValue) scaleValue.textContent = `${Math.round(stageScale * 100)}%`;
      applyStageSize();
    }
    applyOpacity();
  }).catch((err) => console.warn('[settings] init load failed:', err));

  // 阻止 dev-panel 內部 mousedown 觸發拖曳 + 互動中凍結 dev-panel 位置
  devPanel.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    devPanelInteracting = true;
  });
  window.addEventListener('mouseup', () => {
    if (devPanelInteracting) {
      devPanelInteracting = false;
      // 互動結束 → 重新對齊到 stage 當前位置 + 大小（會用 CSS transition 滑過去）
      syncDevPanelPosition();
    }
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

  // ── 拖曳 character-stage ───────────────────────────────
  let dragging = false;
  let dragOrigin = { mouseX: 0, mouseY: 0, boxX: 0, boxY: 0 };

  stageEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    stageEl.classList.add('dragging');
    dragOrigin = {
      mouseX: e.screenX,
      mouseY: e.screenY,
      boxX: pos.character_x,
      boxY: pos.character_y,
    };
    try { window.api.character.dragStart(); } catch (_e) { /* M2 fallback */ }
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    pos.character_x = clamp(
      dragOrigin.boxX + (e.screenX - dragOrigin.mouseX),
      EDGE_MARGIN - STAGE_W,                     // 允許大半部分推到螢幕外，留 EDGE_MARGIN 在內
      window.innerWidth - EDGE_MARGIN
    );
    pos.character_y = clamp(
      dragOrigin.boxY + (e.screenY - dragOrigin.mouseY),
      0,                                          // y 上限：不能拖到螢幕上方外
      window.innerHeight - EDGE_MARGIN
    );
    applyPosition();
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    stageEl.classList.remove('dragging');
    applyOpacity();   // 拖曳結束 → 恢復閒置透明度
    window.api.windowState
      .set({ character_x: pos.character_x, character_y: pos.character_y })
      .catch((err) => console.warn('windowState.set failed:', err));
  });

  // 視窗縮放時 dev-panel + bubble anchor 都要重算
  window.addEventListener('resize', applyPosition);

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }
})();
