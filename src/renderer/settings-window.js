// p5 settings 視窗 renderer
//
// 設計原則：
//   - 任何 UI 變動 → 立刻 invoke settings:set 寫回（不需「儲存」按鈕）。
//   - DND 排程在本地 (state.do_not_disturb.schedule) 維護一個 array，動了再 set。
//   - 所有 set 都送整段 do_not_disturb 物件，由 ConfigStore.update 用 Object.assign 覆寫。

(function () {
  const $ = (id) => document.getElementById(id);

  const elPersona = $('active-persona');
  const elVolume = $('volume');
  const elVolumeValue = $('volume-value');
  const elVoiceEnabled = $('voice-enabled');
  const elVoiceLanguage = $('voice-language');
  const elDndManual = $('dnd-manual');
  const elDndScheduleEnabled = $('dnd-schedule-enabled');
  const elScheduleList = $('schedule-list');
  const elAddSchedule = $('add-schedule');
  const elOpenDebugPanel = $('open-debug-panel');
  const elOpenConfigDir = $('open-config-dir');
  const elEnvInfo = $('env-info');

  const DAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

  // local state（schedule 結構：{ from: 'HH:MM', to: 'HH:MM', days: [0..6] }）
  let state = {
    active_persona: '',
    volume: 0.6,
    voice: { enabled: false, language: 'zh' },
    do_not_disturb: { manual: false, schedule_enabled: false, schedule: [] },
  };

  // 抑制初次填表時觸發 change 事件
  let suppressEvents = false;

  // ── init ────────────────────────────────────────────────
  Promise.all([
    window.settingsApi.settingsGet(),
    window.settingsApi.personasList(),
    window.settingsApi.envInfo(),
  ])
    .then(([settings, personas, env]) => {
      hydrate(settings, personas);
      renderEnv(env);
    })
    .catch((err) => {
      console.error('[settings] init failed:', err);
      elEnvInfo.textContent = '初始化失敗：' + (err.message || err);
    });

  function hydrate(settings, personas) {
    suppressEvents = true;

    // 人格下拉
    elPersona.innerHTML = '';
    if (!personas || personas.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '（無可用人格）';
      elPersona.appendChild(opt);
    } else {
      for (const p of personas) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${p.display_name} (${p.id})`;
        elPersona.appendChild(opt);
      }
    }

    state.active_persona = settings.active_persona || '';
    elPersona.value = state.active_persona;

    state.volume = typeof settings.volume === 'number' ? settings.volume : 0.6;
    elVolume.value = String(state.volume);
    updateVolumeLabel(state.volume);

    state.voice = {
      enabled: !!settings.voice?.enabled,
      language: settings.voice?.language || 'zh',
    };
    elVoiceEnabled.checked = state.voice.enabled;
    elVoiceLanguage.value = state.voice.language;

    state.do_not_disturb = {
      manual: !!settings.do_not_disturb?.manual,
      schedule_enabled: !!settings.do_not_disturb?.schedule_enabled,
      schedule: Array.isArray(settings.do_not_disturb?.schedule)
        ? settings.do_not_disturb.schedule.map(normalizeScheduleEntry)
        : [],
    };
    elDndManual.checked = state.do_not_disturb.manual;
    elDndScheduleEnabled.checked = state.do_not_disturb.schedule_enabled;
    renderScheduleList();

    suppressEvents = false;
  }

  function renderEnv(env) {
    if (!env) {
      elEnvInfo.textContent = '(env unavailable)';
      return;
    }
    const parts = [
      `Electron ${env.electronVersion}`,
      `Node ${env.nodeVersion}`,
    ];
    if (env.appVersion) parts.push(`p5 ${env.appVersion}`);
    if (env.isDev) parts.push('DEV');
    elEnvInfo.textContent = parts.join(' / ');
  }

  function normalizeScheduleEntry(raw) {
    return {
      from: typeof raw?.from === 'string' ? raw.from : '22:00',
      to: typeof raw?.to === 'string' ? raw.to : '07:00',
      days: Array.isArray(raw?.days)
        ? raw.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
        : [0, 1, 2, 3, 4, 5, 6],
    };
  }

  // ── 寫回 ─────────────────────────────────────────────────
  function pushSettings(partial) {
    if (suppressEvents) return;
    window.settingsApi.settingsSet(partial).catch((err) => {
      console.warn('[settings] settingsSet failed:', err);
    });
  }

  function updateVolumeLabel(v) {
    elVolumeValue.textContent = `${Math.round(v * 100)}%`;
  }

  // ── event bindings ──────────────────────────────────────
  elPersona.addEventListener('change', () => {
    state.active_persona = elPersona.value;
    pushSettings({ active_persona: state.active_persona });
  });

  elVolume.addEventListener('input', () => {
    const v = Math.max(0, Math.min(1, parseFloat(elVolume.value)));
    state.volume = v;
    updateVolumeLabel(v);
    pushSettings({ volume: v });
  });

  elVoiceEnabled.addEventListener('change', () => {
    state.voice.enabled = elVoiceEnabled.checked;
    pushSettings({ voice: { ...state.voice } });
  });

  elVoiceLanguage.addEventListener('change', () => {
    state.voice.language = elVoiceLanguage.value;
    pushSettings({ voice: { ...state.voice } });
  });

  elDndManual.addEventListener('change', () => {
    state.do_not_disturb.manual = elDndManual.checked;
    pushSettings({ do_not_disturb: { ...state.do_not_disturb } });
  });

  elDndScheduleEnabled.addEventListener('change', () => {
    state.do_not_disturb.schedule_enabled = elDndScheduleEnabled.checked;
    pushSettings({ do_not_disturb: { ...state.do_not_disturb } });
  });

  elAddSchedule.addEventListener('click', () => {
    state.do_not_disturb.schedule.push({
      from: '22:00',
      to: '07:00',
      days: [0, 1, 2, 3, 4, 5, 6],
    });
    renderScheduleList();
    pushSchedule();
  });

  elOpenDebugPanel.addEventListener('click', () => {
    window.settingsApi.debugPanelOpen();
  });

  elOpenConfigDir.addEventListener('click', () => {
    window.settingsApi.openConfigDir().catch((err) => {
      console.warn('[settings] openConfigDir failed:', err);
    });
  });

  // ESC 關閉
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      window.settingsApi.close();
    }
  });

  // ── 排程列表渲染 ────────────────────────────────────────
  function renderScheduleList() {
    elScheduleList.innerHTML = '';
    state.do_not_disturb.schedule.forEach((entry, idx) => {
      elScheduleList.appendChild(buildScheduleRow(entry, idx));
    });
  }

  function buildScheduleRow(entry, idx) {
    const row = document.createElement('div');
    row.className = 'schedule-row';
    row.dataset.idx = String(idx);

    // 時間區段
    const timeWrap = document.createElement('div');
    timeWrap.className = 'schedule-time';

    const fromInput = document.createElement('input');
    fromInput.type = 'time';
    fromInput.value = entry.from;
    fromInput.addEventListener('change', () => {
      entry.from = fromInput.value || '00:00';
      pushSchedule();
    });

    const dash = document.createElement('span');
    dash.textContent = '→';

    const toInput = document.createElement('input');
    toInput.type = 'time';
    toInput.value = entry.to;
    toInput.addEventListener('change', () => {
      entry.to = toInput.value || '00:00';
      pushSchedule();
    });

    timeWrap.appendChild(fromInput);
    timeWrap.appendChild(dash);
    timeWrap.appendChild(toInput);

    // 週幾切換按鈕
    const daysWrap = document.createElement('div');
    daysWrap.className = 'schedule-days';

    for (let d = 0; d < 7; d++) {
      const label = document.createElement('label');
      label.className = 'day-toggle';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = entry.days.includes(d);
      if (cb.checked) label.classList.add('active');
      cb.addEventListener('change', () => {
        if (cb.checked) {
          if (!entry.days.includes(d)) entry.days.push(d);
          entry.days.sort((a, b) => a - b);
          label.classList.add('active');
        } else {
          entry.days = entry.days.filter((x) => x !== d);
          label.classList.remove('active');
        }
        pushSchedule();
      });
      const span = document.createElement('span');
      span.textContent = DAY_LABELS[d];
      label.appendChild(cb);
      label.appendChild(span);
      daysWrap.appendChild(label);
    }

    // 刪除
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-icon';
    delBtn.title = '刪除此排程';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', () => {
      state.do_not_disturb.schedule.splice(idx, 1);
      renderScheduleList();
      pushSchedule();
    });

    row.appendChild(timeWrap);
    row.appendChild(daysWrap);
    row.appendChild(delBtn);

    return row;
  }

  function pushSchedule() {
    pushSettings({ do_not_disturb: { ...state.do_not_disturb } });
  }
})();
