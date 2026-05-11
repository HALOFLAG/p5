// p5 對話庫管理視窗 renderer (M4.5)
//
// 三個 tab：browse / import / stats
// 透過 window.dialoguesApi（preload）跟主程序溝通。

'use strict';

const api = window.dialoguesApi;

// ── 狀態 ─────────────────────────────────────────
const state = {
  personas: [],            // [{id, display_name}]
  currentPersona: null,    // 目前選中的 persona id
  dialogues: null,         // 已載入的 dialogues.json 資料（mutable）
  fireCounts: {},          // sequence_id → count
  fireByTrigger: {},       // rule_name → count
  fireByCategory: {},      // category → count
  fireRangeDays: 7,        // 統計 tab 用
  selectedSequence: null,  // { category, sequenceId, ref(指向 dialogues 內的 obj) }
  unlocked: false,         // 是否已解鎖編輯 initial 句
  triggerRules: [],        // 從 triggers:list-rules 載入：[{name, category, condition, ...}]
  rulesByCategory: {},     // category → [rule, ...]
};

// Tab 6 時間語音狀態
const tvState = {
  persona: null,
  lang: null,           // 預設由 persona.voice.voice_lang 決定（init 時填）
  items: [],            // { key, category, default_text, text, is_override, status, file_url, ... }
  editingKey: null,     // 目前 inline 編輯的 key
  batchRunning: false,
  currentAudio: null,   // 試聽用 audio element
};

// Tab 3 LLM Prompt 用：category info cache（init 時載入）
let _categoryInfoCache = null;
async function loadCategoryInfoCache() {
  if (_categoryInfoCache) return _categoryInfoCache;
  try {
    _categoryInfoCache = await api.listCategoryInfo();
  } catch (err) {
    console.warn('[loadCategoryInfoCache] failed:', err);
    _categoryInfoCache = {};
  }
  return _categoryInfoCache;
}

function updateCategoryInfo(category) {
  const info = _categoryInfoCache?.[category];
  setText('cat-info-description', info?.description || '（未知 category）');
  setText('cat-info-triggered-by', info?.triggered_by || '—');
  setText('cat-info-bubble', info ? `${info.expected_count} 句 · ${info.bubble_recommended || '—'}` : '—');
  setText('cat-info-notes', info?.notes || '—');
}

function loadCategoryDefaultMix(category) {
  const info = _categoryInfoCache?.[category];
  const mix = info?.default_class_mix || {};
  applyMixPreset(mix);
  // 顯示「已套 category 預設」hint
  const sumEl = $('prompt-mix-sum');
  if (sumEl && Object.keys(mix).length > 0) {
    const total = Object.values(mix).reduce((a, b) => a + b, 0);
    sumEl.textContent = `總和 ${total}%（已套 ${category} 預設配比，可手動微調）`;
    sumEl.style.color = total === 100 ? 'var(--ok)' : 'var(--warn)';
  }
}

// 讀某 persona 的預設語音 lang（從 voice config 拿）
async function getPersonaVoiceLang(personaId) {
  if (!personaId) return 'ja';
  try {
    const cfg = await api.voiceGetConfig();
    const v = cfg.voices?.[personaId] || {};
    return v.voice_lang || v.ref_lang || v.lang || 'ja';
  } catch (_e) {
    return 'ja';
  }
}

// 內容類 9 類列表（同 spec §6.4，UI 顯示用）
const CONTENT_CLASSES = ['1', '2', '3', '4', 'A', 'B', 'C', 'D', 'E'];
const CONTENT_CLASS_NAMES = {
  '1': '思考', '2': '自言自語', '3': '主動互動', '4': '回應',
  'A': '指令提醒', 'B': '詢問', 'C': '撒嬌', 'D': '情緒反應', 'E': '情境旁白',
};

// ── DOM helpers ──────────────────────────────────
const $ = (id) => document.getElementById(id);
const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };

function setStatus(msg) {
  setText('footer-status', msg);
}

function showError(err) {
  console.error(err);
  setStatus(`錯誤：${err.message || err}`);
}

// ── init ─────────────────────────────────────────
async function init() {
  try {
    const env = await api.envInfo();
    setText('env-info', `electron ${env.electronVersion} · node ${env.nodeVersion}${env.isDev ? ' · DEV' : ''}`);
  } catch (_e) { /* ignore */ }

  // 載 persona 列表
  state.personas = await api.personasList();
  for (const sel of [$('browse-persona'), $('import-persona'), $('stats-persona'), $('prompt-persona'), $('tv-persona')]) {
    if (!sel) continue;
    sel.innerHTML = '';
    for (const p of state.personas) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.display_name} (${p.id})`;
      sel.appendChild(opt);
    }
  }

  if (state.personas.length === 0) {
    setStatus('沒有 persona — 請先建立 personas/<id>/dialogues.json');
    return;
  }
  state.currentPersona = state.personas[0].id;
  $('browse-persona').value = state.currentPersona;
  $('import-persona').value = state.currentPersona;
  $('stats-persona').value = state.currentPersona;
  $('prompt-persona').value = state.currentPersona;
  if ($('tv-persona')) $('tv-persona').value = state.currentPersona;
  tvState.persona = state.currentPersona;
  $('voice-batch-persona').innerHTML = '';
  for (const p of state.personas) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.display_name} (${p.id})`;
    $('voice-batch-persona').appendChild(opt);
  }
  $('voice-batch-persona').value = state.currentPersona;

  // 預設 batch tag
  updateImportBatchTagPlaceholder();

  // Tab 5 batch lang 預設跟著 persona.voice_lang
  try {
    const lang = await getPersonaVoiceLang(state.currentPersona);
    if ($('voice-batch-lang')) $('voice-batch-lang').value = lang;
  } catch (_e) {}

  bindEvents();

  // 載入 trigger rules（用於 Tab 1 顯示觸發條件）
  await loadTriggerRules();

  // 載入 category info cache（給 Tab 3 LLM Prompt 用）
  await loadCategoryInfoCache();

  await loadCurrent();
  await loadFireCounts();
  renderBrowse();
  updateMixSum();  // 初始化 prompt 配比 hint

  // Tab 3：初始 category 也帶說明 + 預設配比（refreshCategoryDropdowns 已選好預設 category）
  const initialCat = $('prompt-category')?.value;
  if (initialCat) {
    updateCategoryInfo(initialCat);
    loadCategoryDefaultMix(initialCat);
  }
}

async function loadTriggerRules() {
  try {
    const rules = await api.triggersListRules();
    state.triggerRules = Array.isArray(rules) ? rules : [];
    state.rulesByCategory = {};
    for (const r of state.triggerRules) {
      if (!r.category || r.category === '_suppress') continue;
      (state.rulesByCategory[r.category] ||= []).push(r);
    }
  } catch (err) {
    console.warn('[loadTriggerRules] failed:', err);
    state.triggerRules = [];
    state.rulesByCategory = {};
  }
}

// 把 triggers.json 的 condition 轉成中文摘要
function formatCondition(cond) {
  if (!cond || typeof cond !== 'object') return '—';
  switch (cond.type) {
    case 'event': return `事件：${cond.event}`;
    case 'time_window': return `時段：${cond.from}–${cond.to}`;
    case 'time_marker': {
      const hr = Array.isArray(cond.hour_range) ? `（${cond.hour_range[0]}–${cond.hour_range[1]} 點）` : '';
      const min = Number.isFinite(cond.minute) ? `${cond.minute} 分` : '整點';
      const active = Number.isFinite(cond.min_active_sec) ? ` + 活躍 ≥ ${cond.min_active_sec}s` : '';
      return `時刻：${min}${hr}${active}`;
    }
    case 'idle_duration': return `閒置 ${cond.operator || '>='} ${Math.round((cond.value_sec || 0) / 60)} 分`;
    case 'session_duration': return `Session ${cond.operator || '>='} ${(cond.value_sec / 3600).toFixed(1)} 小時`;
    case 'counter_threshold': return `計數 ${cond.counter} ${cond.operator || '>='} ${cond.value}`;
    case 'context_state': return `狀態：${cond.state} = ${cond.equals}`;
    case 'event_burst': return `${cond.window_sec}s 內 ${cond.event} ≥ ${cond.min_count}`;
    case 'state_edge': return `狀態邊緣：${cond.state} ${cond.from} → ${cond.to}`;
    case 'random_interval': return `隨機（每秒 ${(cond.probability_per_eval * 100).toFixed(2)}%${cond.hour_range ? `，${cond.hour_range[0]}-${cond.hour_range[1]} 點` : ''}）`;
    case 'app_focus': return `切到 app：${(cond.classifications || []).join(' / ')}${cond.probability ? ` (${cond.probability * 100}%)` : ''}`;
    case 'streak_threshold': return `連續：${cond.window_sec}s 內 ${cond.event} ≥ ${cond.min_count}`;
    default: return cond.type;
  }
}

function getRulesForCategory(category) {
  return state.rulesByCategory[category] || [];
}

function bindEvents() {
  // Tab 切換
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.toggle('active', c.dataset.tab === tab));
      if (tab === 'stats') refreshStats();
      if (tab === 'prompt' && !$('prompt-output').value) onGenPrompt();
      if (tab === 'voice') refreshVoiceTab();
      if (tab === 'time-voice') refreshTimeVoiceTab();
    });
  });

  // ── Tab 1 browse ──
  $('browse-persona').addEventListener('change', async (e) => {
    state.currentPersona = e.target.value;
    state.selectedSequence = null;
    state.unlocked = false;
    await loadCurrent();
    await loadFireCounts();
    renderBrowse();
    renderEditPanel();
  });
  $('browse-category').addEventListener('change', renderBrowse);
  $('browse-type').addEventListener('change', renderBrowse);
  $('browse-content-class').addEventListener('change', renderBrowse);
  $('browse-source').addEventListener('change', renderBrowse);
  $('browse-sort').addEventListener('change', renderBrowse);
  $('browse-search').addEventListener('input', debounce(renderBrowse, 200));
  $('browse-refresh').addEventListener('click', async () => {
    await loadCurrent();
    await loadFireCounts();
    renderBrowse();
    renderEditPanel();
  });

  // ── Edit panel actions ──
  $('btn-save').addEventListener('click', onSaveSequence);
  $('btn-duplicate').addEventListener('click', onDuplicateSequence);
  $('btn-delete').addEventListener('click', onDeleteSequence);
  $('btn-voice-preview').addEventListener('click', onPreviewVoice);
  // interaction 切換時即時切換互動編輯區
  $('edit-interaction').addEventListener('change', () => {
    if (state.selectedSequence?.ref) renderInteractiveEditor(state.selectedSequence.ref);
  });
  // 「+ 加選項」按鈕
  $('btn-add-choice').addEventListener('click', () => {
    const list = $('edit-choices-list');
    // 第一次按可能還是「尚無選項」hint，先清掉
    if (!list.querySelector('.edit-choice-row')) list.innerHTML = '';
    const idx = list.querySelectorAll('.edit-choice-row').length;
    list.appendChild(createChoiceRow({ label: '', response: { type: 'speech' } }, idx));
  });
  $('btn-unlock').addEventListener('click', () => {
    if (!confirm('解鎖後可編輯 initial 句。\n注意：dialogues-initial.json 不會被同步更新（種子檔不可變）。\n\n確定要解鎖嗎？')) return;
    state.unlocked = true;
    renderEditPanel();
  });

  // ── Tab 2 import ──
  $('import-persona').addEventListener('change', async () => {
    updateImportBatchTagPlaceholder();
    // 換 persona 時 datalist 也要重新填（不同 persona 可能有不同 category 集）
    if ($('import-persona').value !== state.currentPersona) {
      // 暫存使用者目前打字的 import-category（不要被覆蓋）
      const tmp = $('import-category').value;
      try {
        const cats = await api.listCategories($('import-persona').value);
        const datalist = $('import-category-list');
        if (datalist) {
          datalist.innerHTML = cats.map((c) => `<option value="${escapeHtml(c)}"></option>`).join('');
        }
      } catch (_e) {}
      $('import-category').value = tmp;
    }
  });
  $('import-category').addEventListener('change', updateImportBatchTagPlaceholder);
  $('import-category').addEventListener('input', updateImportBatchTagPlaceholder);
  $('btn-preview').addEventListener('click', () => onImport({ dryRun: true }));
  $('btn-apply').addEventListener('click', () => onImport({ dryRun: false }));
  $('btn-import-go-voice').addEventListener('click', onImportGoVoice);

  // ── Tab 3 stats ──
  document.querySelectorAll('input[name="stats-range"]').forEach((r) => {
    r.addEventListener('change', () => {
      state.fireRangeDays = parseInt(r.value, 10);
      refreshStats();
    });
  });
  $('stats-persona').addEventListener('change', refreshStats);
  $('stats-refresh').addEventListener('click', refreshStats);

  // ── Tab 4 LLM Prompt ──
  $('btn-gen-prompt').addEventListener('click', onGenPrompt);
  $('btn-copy-prompt').addEventListener('click', onCopyPrompt);
  // persona / category 變化時清空 prompt（避免讓使用者複製到舊的）
  $('prompt-persona').addEventListener('change', () => clearPromptOutput());
  $('prompt-category').addEventListener('change', (e) => {
    clearPromptOutput();
    updateCategoryInfo(e.target.value);
    loadCategoryDefaultMix(e.target.value);
  });
  // 配比 UI：每個 number input 變動時更新總和 hint
  document.querySelectorAll('#prompt-class-mix input[type="number"]').forEach((el) => {
    el.addEventListener('input', updateMixSum);
  });
  $('btn-mix-reload-default')?.addEventListener('click', () => loadCategoryDefaultMix($('prompt-category').value));
  $('btn-mix-clear').addEventListener('click', () => applyMixPreset({}));

  // ── Tab 5 Voice ──
  $('btn-voice-check').addEventListener('click', onVoiceCheck);
  $('btn-voice-start').addEventListener('click', onVoiceStart);
  $('btn-voice-cancel').addEventListener('click', onVoiceCancel);
  // 切 persona 自動同步 batch lang 到該 persona 的 voice_lang
  $('voice-batch-persona')?.addEventListener('change', async (e) => {
    const lang = await getPersonaVoiceLang(e.target.value);
    if ($('voice-batch-lang')) $('voice-batch-lang').value = lang;
  });

  // 引擎子進程控制
  $('btn-engine-start')?.addEventListener('click', onEngineStart);
  $('btn-engine-stop')?.addEventListener('click', onEngineStop);
  $('btn-engine-settings')?.addEventListener('click', onEngineSettingsOpen);
  $('btn-engine-settings-close')?.addEventListener('click', onEngineSettingsClose);
  $('btn-engine-settings-cancel')?.addEventListener('click', onEngineSettingsClose);
  $('btn-engine-settings-save')?.addEventListener('click', onEngineSettingsSave);
  // 一鍵清除當前 persona 對話 + 語音（測試方便）
  $('btn-wipe-content')?.addEventListener('click', onWipeCurrentPersona);

  // binary response 試聽按鈕（yes / no 各一）
  document.querySelectorAll('button[data-action="preview-binary"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const side = btn.dataset.side;  // 'yes' / 'no'
      const parentId = state.selectedSequence?.sequenceId;
      const root = btn.closest('.edit-binary-side');
      const voiceLang = root?.querySelector('[data-field="rvoice_lang"]')?.value || null;
      previewResponseVoice(parentId, `binary_${side}`, voiceLang);
    });
  });
  api.voiceEngineOnLog?.(appendEngineLog);
  api.voiceEngineOnStatus?.((payload) => applyEngineStatus(payload.status, payload.error));
  api.voiceOnProgress((payload) => {
    if (payload?.kind === 'time') onTimeVoiceProgress(payload);
    else onVoiceProgress(payload);
  });
  api.voiceOnBatchDone((payload) => {
    if (payload?.kind === 'time') onTimeVoiceBatchDone(payload);
    else onVoiceBatchDone(payload);
  });

  // ── Tab 6 Time Voice ──
  $('tv-persona')?.addEventListener('change', async (e) => {
    tvState.persona = e.target.value;
    // 換 persona 時自動同步 lang 到該 persona 的 voice_lang
    tvState.lang = await getPersonaVoiceLang(tvState.persona);
    if ($('tv-lang')) $('tv-lang').value = tvState.lang;
    refreshTimeVoiceTab();
  });
  $('tv-lang')?.addEventListener('change', (e) => {
    tvState.lang = e.target.value;
    refreshTimeVoiceTab();
  });
  $('tv-refresh')?.addEventListener('click', refreshTimeVoiceTab);
  $('tv-reset-all')?.addEventListener('click', onTimeVoiceResetAll);
  $('tv-batch-start')?.addEventListener('click', onTimeVoiceBatchStart);
  $('tv-batch-cancel')?.addEventListener('click', onTimeVoiceBatchCancel);

  // ── persona pack 管理（R4）──
  $('btn-persona-reveal')?.addEventListener('click', async () => {
    if (!state.currentPersona) { setStatus('沒有選中 persona'); return; }
    try {
      const result = await api.personaPackReveal(state.currentPersona);
      setStatus(`📂 已開啟 ${result.path}（要分享就壓縮整個資料夾）`);
    } catch (err) { showError(err); }
  });
  $('btn-persona-import')?.addEventListener('click', async () => {
    try {
      const result = await api.personaPackImport();
      if (result.cancelled) return;
      setStatus(`✅ 匯入成功：${result.persona_id}（${result.dest}）。重啟視窗看到新 persona`);
      alert(`匯入成功：${result.persona_id}\n位置：${result.dest}\n\n請重啟 app（或切人格）才會載入新 persona。`);
    } catch (err) {
      alert(`匯入失敗：${err.message}`);
      showError(err);
    }
  });

  // ── 關閉視窗 ──
  $('close-btn').addEventListener('click', () => api.close());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') api.close();
    if (e.ctrlKey && e.key === 's' && state.selectedSequence) {
      e.preventDefault();
      onSaveSequence();
    }
  });
}

// ── 載入資料 ──────────────────────────────────────
async function loadCurrent() {
  if (!state.currentPersona) return;
  setStatus(`載入 ${state.currentPersona}/dialogues.json...`);
  try {
    state.dialogues = await api.read(state.currentPersona);
    if (!state.dialogues) {
      setStatus(`${state.currentPersona}/dialogues.json 不存在`);
      return;
    }
    setStatus(`載入完成：${countSequences(state.dialogues)} 句`);
    // 動態 dropdown：每次重新載 dialogues 同步 category 列表
    await refreshCategoryDropdowns();
  } catch (err) {
    showError(err);
  }
}

// 動態填三個 category dropdown：Tab 1 browse filter、Tab 3 prompt、Tab 2 datalist
async function refreshCategoryDropdowns() {
  if (!state.currentPersona) return;
  let cats;
  try {
    cats = await api.listCategories(state.currentPersona);
  } catch (err) {
    console.warn('[refreshCategoryDropdowns] failed:', err);
    return;
  }

  // Tab 1：browse-category（保留「全部」+ 各 category）
  const browseSel = $('browse-category');
  if (browseSel) {
    const currentVal = browseSel.value;
    browseSel.innerHTML = '<option value="">全部</option>' +
      cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    if (cats.includes(currentVal)) browseSel.value = currentVal;
  }

  // Tab 4：prompt-category（不含「全部」，只列 category）
  const promptSel = $('prompt-category');
  if (promptSel) {
    const currentVal = promptSel.value;
    promptSel.innerHTML = cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    if (cats.includes(currentVal)) promptSel.value = currentVal;
    else if (cats.length > 0) promptSel.value = cats[0];
    // 切人格 / 重新整理時，類別說明 + 預設配比同步
    if (promptSel.value) {
      updateCategoryInfo(promptSel.value);
      loadCategoryDefaultMix(promptSel.value);
    }
  }

  // Tab 2：import-category-list（datalist；input 自身保持原 value）
  const datalist = $('import-category-list');
  if (datalist) {
    datalist.innerHTML = cats.map((c) => `<option value="${escapeHtml(c)}"></option>`).join('');
  }
}

async function loadFireCounts() {
  if (!state.currentPersona) return;
  try {
    const result = await api.fireStats(state.currentPersona, state.fireRangeDays);
    state.fireCounts = result.counts || {};
    state.fireByTrigger = result.byTrigger || {};
    state.fireByCategory = result.byCategory || {};
  } catch (err) {
    state.fireCounts = {};
    state.fireByTrigger = {};
    state.fireByCategory = {};
    console.warn('fireStats failed:', err);
  }
}

function countSequences(data) {
  let n = 0;
  for (const cat of Object.values(data?.categories || {})) {
    n += (cat.sequences || []).length;
  }
  return n;
}

// ── Tab 1: 瀏覽 / 編輯 ────────────────────────────
function renderBrowse() {
  const data = state.dialogues;
  const tbody = $('browse-tbody');
  if (!data || !data.categories) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">沒有資料</td></tr>';
    setText('browse-meta', '—');
    return;
  }

  const filterCat = $('browse-category').value;
  const filterType = $('browse-type').value;
  const filterClass = $('browse-content-class').value;
  const filterSource = $('browse-source').value;
  const sortBy = $('browse-sort').value;
  const search = $('browse-search').value.trim().toLowerCase();

  // flatten + filter
  const rows = [];
  for (const [catName, cat] of Object.entries(data.categories)) {
    if (filterCat && filterCat !== catName) continue;
    for (const seq of cat.sequences || []) {
      const isInitial = seq._meta?.source_batch === 'initial';
      if (filterSource === 'initial' && !isInitial) continue;
      if (filterSource === 'non-initial' && isInitial) continue;
      if (filterType && (seq.type || 'speech') !== filterType) continue;
      const cc = seq._meta?.content_class || '';
      if (filterClass && cc !== filterClass) continue;

      const firstLine = seq.lines?.[0];
      const text = firstLine?.text || '';
      const expression = firstLine?.expression || '';
      if (search) {
        const haystack = `${seq.sequenceId} ${text} ${expression}`.toLowerCase();
        if (!haystack.includes(search)) continue;
      }
      rows.push({
        category: catName,
        sequence: seq,
        text,
        expression,
        count: state.fireCounts[seq.sequenceId] || 0,
        contentClass: cc,
        isInitial,
      });
    }
  }

  // sort
  rows.sort((a, b) => {
    if (sortBy === 'count-desc') return b.count - a.count || a.sequence.sequenceId.localeCompare(b.sequence.sequenceId);
    if (sortBy === 'count-asc') return a.count - b.count || a.sequence.sequenceId.localeCompare(b.sequence.sequenceId);
    if (sortBy === 'created-desc') {
      const ta = a.sequence._meta?.created_at || '';
      const tb = b.sequence._meta?.created_at || '';
      return tb.localeCompare(ta);
    }
    return a.sequence.sequenceId.localeCompare(b.sequence.sequenceId);
  });

  // render
  tbody.innerHTML = '';
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">無符合條件的 sequences</td></tr>';
  } else {
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.dataset.category = r.category;
      tr.dataset.sequenceId = r.sequence.sequenceId;
      if (r.isInitial) tr.classList.add('row-locked');
      const t = r.sequence.type || 'speech';
      if (t === 'thought') tr.classList.add('row-thought');
      else if (t === 'whisper') tr.classList.add('row-whisper');
      else if (t === 'narration') tr.classList.add('row-narration');
      else if (t === 'system') tr.classList.add('row-system');
      if (state.selectedSequence?.sequenceId === r.sequence.sequenceId) tr.classList.add('selected');

      const ccBadge = r.contentClass
        ? `<span class="cc-badge cc-${escapeHtml(r.contentClass)}" title="${escapeHtml(CONTENT_CLASS_NAMES[r.contentClass] || '')}">${escapeHtml(r.contentClass)}</span>`
        : '<span class="cc-badge" title="未分類">—</span>';

      tr.innerHTML = `
        <td class="col-id">${escapeHtml(r.sequence.sequenceId)}</td>
        <td class="col-cat">${escapeHtml(r.category)}</td>
        <td class="col-type">${escapeHtml(t)}</td>
        <td class="col-class">${ccBadge}</td>
        <td class="col-expr">${escapeHtml(r.expression)}</td>
        <td>${escapeHtml(r.text.slice(0, 60))}${r.text.length > 60 ? '…' : ''}</td>
        <td class="col-count">${r.count}</td>
      `;
      tr.addEventListener('click', () => {
        state.selectedSequence = {
          category: r.category,
          sequenceId: r.sequence.sequenceId,
          ref: r.sequence,
        };
        state.unlocked = false;
        renderBrowse();
        renderEditPanel();
      });
      tbody.appendChild(tr);
    }
  }

  setText('browse-meta', `${rows.length} / ${countSequences(data)} 句`);
}

function renderEditPanel() {
  const sel = state.selectedSequence;
  const empty = $('edit-empty');
  const form = $('edit-form');

  if (!sel) {
    empty.hidden = false;
    form.hidden = true;
    return;
  }

  const seq = sel.ref;
  empty.hidden = true;
  form.hidden = false;

  const isInitial = seq._meta?.source_batch === 'initial';
  const locked = isInitial && !state.unlocked;
  form.dataset.locked = locked ? 'true' : 'false';

  setText('edit-id', seq.sequenceId);
  $('edit-lock-badge').hidden = !isInitial;
  $('btn-unlock').hidden = !isInitial || state.unlocked;

  // 觸發條件 banner（從 state.rulesByCategory 反查）
  const rules = getRulesForCategory(sel.category);
  const triggerEl = $('edit-trigger-text');
  if (rules.length === 0) {
    triggerEl.innerHTML = `<span class="hint">（category "${escapeHtml(sel.category)}" 目前沒有對應 trigger rule）</span>`;
  } else {
    triggerEl.innerHTML = rules.map((r) =>
      `<span class="trigger-rule-name">${escapeHtml(r.name)}</span>：${escapeHtml(formatCondition(r.condition))}（cd ${r.cooldown_sec}s, p${r.priority}）`
    ).join('<br>');
  }

  const firstLine = seq.lines?.[0] || { text: '', expression: '' };
  $('edit-type').value = seq.type || 'speech';
  $('edit-expression').value = firstLine.expression || '';
  $('edit-text').value = firstLine.text || '';
  $('edit-voice-text').value = firstLine.voice_text || '';
  $('edit-voice-lang').value = firstLine.voice_lang || '';
  $('edit-interaction').value = seq.interaction || '';
  $('edit-auto-close').value = seq.auto_close_ms || '';
  $('edit-content-class').value = seq._meta?.content_class || '';
  $('edit-weight').value = seq._meta?.weight ?? '';
  $('edit-streak-level').value = seq._meta?.streak_level || '';

  // 互動式編輯區（依 interaction 顯示 choice / binary）
  renderInteractiveEditor(seq);

  setText('meta-source', seq._meta?.source_batch || '—');
  setText('meta-created', formatTs(seq._meta?.created_at));
  setText('meta-edited', formatTs(seq._meta?.edited_at) || '從未');
  setText('meta-fire-count', String(seq._meta?.fire_count_lifetime || 0));

  $('btn-save').disabled = locked;
  $('btn-delete').disabled = locked;

  // Voice 狀態：async query manifest（不 block UI render）
  refreshVoiceStatusFor(state.currentPersona, seq.sequenceId, firstLine.voice_lang || null).catch(() => {});
}

// ── 互動式編輯區（P1.3）：依 interaction 顯示 choice / binary 編輯 ─────
function renderInteractiveEditor(seq) {
  const wrap = $('edit-interactive');
  const choiceSec = $('edit-choice-section');
  const binarySec = $('edit-binary-section');
  const interaction = $('edit-interaction').value;

  if (interaction === 'choice') {
    wrap.hidden = false;
    choiceSec.hidden = false;
    binarySec.hidden = true;
    renderChoicesList(seq.choices || []);
  } else if (interaction === 'binary') {
    wrap.hidden = false;
    choiceSec.hidden = true;
    binarySec.hidden = false;
    populateBinaryFields(seq.binary || {});
  } else {
    wrap.hidden = true;
    choiceSec.hidden = true;
    binarySec.hidden = true;
  }
}

function renderChoicesList(choices) {
  const list = $('edit-choices-list');
  list.innerHTML = '';
  if (choices.length === 0) {
    list.innerHTML = '<div class="hint" style="margin-left:0">尚無選項，按「+ 加選項」新增。</div>';
    return;
  }
  choices.forEach((c, i) => list.appendChild(createChoiceRow(c, i)));
}

function createChoiceRow(choice, idx) {
  const r = choice.response || {};
  const div = document.createElement('div');
  div.className = 'edit-choice-row';
  div.dataset.index = String(idx);
  div.innerHTML = `
    <div class="choice-row-head">
      <span>選項 ${idx + 1}</span>
      <div style="display:flex;gap:4px">
        <button type="button" class="btn-mini" data-action="preview" title="試聽 response 語音（須先批次生成）">🔊 試聽</button>
        <button type="button" class="btn-mini" data-action="delete">刪除</button>
      </div>
    </div>
    <div class="row-grid">
      <label>Label（字幕）
        <input type="text" data-field="label" value="${escapeHtml(choice.label || '')}" placeholder="想抱抱" />
      </label>
      <label>Label JA（顯示用，不發聲）
        <input type="text" data-field="label_ja" value="${escapeHtml(choice.label_ja || '')}" placeholder="抱きしめて" />
      </label>
    </div>
    <div class="row-grid">
      <label>Response type
        <select data-field="rtype">
          <option value="speech"${r.type === 'speech' || !r.type ? ' selected' : ''}>speech</option>
          <option value="thought"${r.type === 'thought' ? ' selected' : ''}>thought</option>
          <option value="whisper"${r.type === 'whisper' ? ' selected' : ''}>whisper</option>
        </select>
      </label>
      <label>Expression
        <input type="text" data-field="rexpr" value="${escapeHtml(r.expression || '')}" placeholder="happy" />
      </label>
    </div>
    <label>Response text（字幕）
      <textarea rows="2" data-field="rtext" placeholder="嗯⋯⋯不要在這裡⋯⋯♡">${escapeHtml(r.text || '')}</textarea>
    </label>
    <div class="row-grid">
      <label>Response voice_text（語音）
        <textarea rows="2" data-field="rvoice_text" placeholder="んん⋯⋯ここではダメ⋯⋯">${escapeHtml(r.voice_text || '')}</textarea>
      </label>
      <label>voice_lang
        <select data-field="rvoice_lang">
          <option value=""${!r.voice_lang ? ' selected' : ''}>（預設）</option>
          <option value="zh"${r.voice_lang === 'zh' ? ' selected' : ''}>zh</option>
          <option value="ja"${r.voice_lang === 'ja' ? ' selected' : ''}>ja</option>
          <option value="en"${r.voice_lang === 'en' ? ' selected' : ''}>en</option>
        </select>
      </label>
    </div>
  `;
  div.querySelector('[data-action="delete"]').addEventListener('click', () => {
    if (!confirm(`刪除選項 ${idx + 1}？（儲存後生效）`)) return;
    div.remove();
    // 重新編號顯示
    const rows = $('edit-choices-list').querySelectorAll('.edit-choice-row');
    rows.forEach((row, newIdx) => {
      row.dataset.index = String(newIdx);
      const head = row.querySelector('.choice-row-head span');
      if (head) head.textContent = `選項 ${newIdx + 1}`;
    });
  });
  // 試聽 response 語音（synthetic id: <parent>__choice_<idx>）
  div.querySelector('[data-action="preview"]').addEventListener('click', () => {
    const parentId = state.selectedSequence?.sequenceId;
    const rowIdx = parseInt(div.dataset.index, 10);
    const voiceLang = div.querySelector('[data-field="rvoice_lang"]')?.value || null;
    previewResponseVoice(parentId, `choice_${rowIdx}`, voiceLang);
  });
  return div;
}

function populateBinaryFields(binary) {
  // 接受 spec yes/no 跟 legacy left/right
  const yes = binary.yes ?? binary.left ?? {};
  const no = binary.no ?? binary.right ?? {};
  fillBinarySide('yes', yes);
  fillBinarySide('no', no);
}

function fillBinarySide(side, b) {
  const root = document.querySelector(`.edit-binary-side[data-side="${side}"]`);
  if (!root) return;
  const r = b.response || {};
  root.querySelector('[data-field="label"]').value = b.label || '';
  if (root.querySelector('[data-field="label_ja"]')) {
    root.querySelector('[data-field="label_ja"]').value = b.label_ja || '';
  }
  root.querySelector('[data-field="rtype"]').value = r.type || 'speech';
  root.querySelector('[data-field="rexpr"]').value = r.expression || '';
  root.querySelector('[data-field="rtext"]').value = r.text || '';
  if (root.querySelector('[data-field="rvoice_text"]')) {
    root.querySelector('[data-field="rvoice_text"]').value = r.voice_text || '';
  }
  if (root.querySelector('[data-field="rvoice_lang"]')) {
    root.querySelector('[data-field="rvoice_lang"]').value = r.voice_lang || '';
  }
}

function collectChoicesFromUI() {
  const rows = $('edit-choices-list').querySelectorAll('.edit-choice-row');
  const out = [];
  rows.forEach((row) => {
    const label = row.querySelector('[data-field="label"]').value.trim();
    const labelJa = row.querySelector('[data-field="label_ja"]')?.value.trim() || '';
    const rtype = row.querySelector('[data-field="rtype"]').value;
    const rexpr = row.querySelector('[data-field="rexpr"]').value.trim();
    const rtext = row.querySelector('[data-field="rtext"]').value.trim();
    const rvoiceText = row.querySelector('[data-field="rvoice_text"]')?.value.trim() || '';
    const rvoiceLang = row.querySelector('[data-field="rvoice_lang"]')?.value || '';
    if (!label && !rtext) return;
    const response = { type: rtype || 'speech' };
    if (rexpr) response.expression = rexpr;
    if (rtext) response.text = rtext;
    if (rvoiceText) response.voice_text = rvoiceText;
    if (rvoiceLang) response.voice_lang = rvoiceLang;
    const choice = { label: label || '（未命名）', response };
    if (labelJa) choice.label_ja = labelJa;
    out.push(choice);
  });
  return out;
}

function collectBinaryFromUI() {
  const out = {};
  for (const side of ['yes', 'no']) {
    const root = document.querySelector(`.edit-binary-side[data-side="${side}"]`);
    if (!root) continue;
    const label = root.querySelector('[data-field="label"]').value.trim();
    const labelJa = root.querySelector('[data-field="label_ja"]')?.value.trim() || '';
    const rtype = root.querySelector('[data-field="rtype"]').value;
    const rexpr = root.querySelector('[data-field="rexpr"]').value.trim();
    const rtext = root.querySelector('[data-field="rtext"]').value.trim();
    const rvoiceText = root.querySelector('[data-field="rvoice_text"]')?.value.trim() || '';
    const rvoiceLang = root.querySelector('[data-field="rvoice_lang"]')?.value || '';
    if (!label && !rtext) continue;
    const response = { type: rtype || 'speech' };
    if (rexpr) response.expression = rexpr;
    if (rtext) response.text = rtext;
    if (rvoiceText) response.voice_text = rvoiceText;
    if (rvoiceLang) response.voice_lang = rvoiceLang;
    const branch = { label: label || (side === 'yes' ? '是' : '否'), response };
    if (labelJa) branch.label_ja = labelJa;
    out[side] = branch;
  }
  return out;
}

// 查指定 sequence 的 voice 狀態並更新編輯面板的 voice 行
async function refreshVoiceStatusFor(personaId, sequenceId, lineVoiceLang = null) {
  const statusEl = $('meta-voice-status');
  const btn = $('btn-voice-preview');
  if (!statusEl || !btn) return;

  // 先重置狀態（避免使用者快速切換 sequence 時看到上一條的資訊）
  statusEl.textContent = '查詢中…';
  btn.hidden = true;
  btn.dataset.fileUrl = '';

  if (!personaId || !sequenceId) {
    statusEl.textContent = '—';
    return;
  }

  // v3: 優先 line.voice_lang，其次 persona default
  const lang = lineVoiceLang || await getPersonaVoiceLang(personaId);

  try {
    const result = await api.voiceGetStatus(personaId, sequenceId, 0, lang);
    // 競態保護：使用者切到別句後 result 才回 → 跳過更新
    if (state.selectedSequence?.sequenceId !== sequenceId) return;

    if (result?.has_voice) {
      const kb = (result.bytes / 1024).toFixed(1);
      const when = formatTs(result.generated_at) || '?';
      statusEl.textContent = `✅ 已生成（${kb} KB · ${when}）`;
      btn.hidden = false;
      btn.dataset.fileUrl = result.file_url || '';
    } else {
      statusEl.textContent = '❌ 未生成（去 Tab「🔊 語音生成」批次跑）';
      btn.hidden = true;
    }
  } catch (err) {
    statusEl.textContent = `查詢失敗：${err.message || err}`;
    btn.hidden = true;
  }
}

function onPreviewVoice() {
  const btn = $('btn-voice-preview');
  const url = btn?.dataset?.fileUrl;
  if (!url) return;
  try {
    const audio = new Audio(url);
    audio.volume = 0.7;
    audio.play().catch((err) => {
      console.warn('[preview] play failed:', err);
      setStatus(`❌ 試聽失敗：${err.message || err}`);
    });
    setStatus('🔊 試聽中…');
  } catch (err) {
    showError(err);
  }
}

// 試聽 choice / binary response 的合成 wav（synthetic sequenceId）
async function previewResponseVoice(parentSeqId, subKey, voiceLang) {
  if (!state.currentPersona || !parentSeqId || !subKey) return;
  const synthId = `${parentSeqId}__${subKey}`;
  const lang = voiceLang || await getPersonaVoiceLang(state.currentPersona);
  try {
    const result = await api.voiceGetStatus(state.currentPersona, synthId, 0, lang);
    if (!result?.has_voice || !result.file_url) {
      setStatus(`❌ ${synthId} 還沒有 wav（去 Tab 🔊 批次跑）`);
      return;
    }
    const audio = new Audio(result.file_url);
    audio.volume = 0.8;
    audio.play().catch((err) => setStatus(`❌ 播放失敗：${err.message}`));
    setStatus(`🔊 試聽 ${synthId}`);
  } catch (err) {
    setStatus(`❌ ${err.message || err}`);
  }
}

async function onSaveSequence() {
  const sel = state.selectedSequence;
  if (!sel) return;
  const seq = sel.ref;

  seq.type = $('edit-type').value || 'speech';
  if (!seq.lines?.[0]) seq.lines = [{ text: '' }];
  seq.lines[0].text = $('edit-text').value;
  const expr = $('edit-expression').value.trim();
  if (expr) seq.lines[0].expression = expr;
  else delete seq.lines[0].expression;

  // 雙語：voice_text / voice_lang per-line
  const vt = $('edit-voice-text').value.trim();
  if (vt) seq.lines[0].voice_text = vt;
  else delete seq.lines[0].voice_text;
  const vl = $('edit-voice-lang').value;
  if (vl) seq.lines[0].voice_lang = vl;
  else delete seq.lines[0].voice_lang;

  const interaction = $('edit-interaction').value;
  if (interaction) seq.interaction = interaction;
  else delete seq.interaction;

  // 互動式內容：依 interaction 寫入 choices / binary，自動清掉不相干欄位
  if (interaction === 'choice') {
    const choices = collectChoicesFromUI();
    if (choices.length > 0) seq.choices = choices;
    else delete seq.choices;
    delete seq.binary;
  } else if (interaction === 'binary') {
    const binary = collectBinaryFromUI();
    if (binary.yes || binary.no) seq.binary = binary;
    else delete seq.binary;
    delete seq.choices;
  } else {
    delete seq.choices;
    delete seq.binary;
  }

  const ms = parseInt($('edit-auto-close').value, 10);
  if (Number.isFinite(ms) && ms > 0) seq.auto_close_ms = ms;
  else delete seq.auto_close_ms;

  seq._meta = seq._meta || {};
  seq._meta.edited_at = new Date().toISOString();

  // §6.4 9 類內容分類（純 metadata）
  const cc = $('edit-content-class').value;
  if (cc) seq._meta.content_class = cc;
  else delete seq._meta.content_class;

  // 抽選權重（M5+ 用）
  const w = parseFloat($('edit-weight').value);
  if (Number.isFinite(w) && w > 0) seq._meta.weight = w;
  else delete seq._meta.weight;

  // streak_level（click_character 用，schema 預留）
  const sl = $('edit-streak-level').value;
  if (sl) seq._meta.streak_level = sl;
  else delete seq._meta.streak_level;

  setStatus('儲存中...');
  try {
    await api.save(state.currentPersona, state.dialogues);
    setStatus(`✅ 已儲存 ${seq.sequenceId}（重啟 / 切人格才生效）`);
    renderBrowse();
    renderEditPanel();
  } catch (err) {
    showError(err);
  }
}

async function onDuplicateSequence() {
  const sel = state.selectedSequence;
  if (!sel) return;
  const seq = sel.ref;
  const cat = state.dialogues.categories[sel.category];
  if (!cat) return;

  // 生新 sequenceId
  const m = seq.sequenceId.match(/^(.+_)(\d+)$/);
  const prefix = m ? m[1] : `${state.currentPersona}_${sel.category}_`;
  let maxNum = 0;
  for (const s of cat.sequences) {
    const mm = s.sequenceId.match(new RegExp(`^${escapeRe(prefix)}(\\d+)$`));
    if (mm) maxNum = Math.max(maxNum, parseInt(mm[1], 10));
  }
  const newId = `${prefix}${String(maxNum + 1).padStart(3, '0')}`;

  const cloned = JSON.parse(JSON.stringify(seq));
  cloned.sequenceId = newId;
  cloned._meta = {
    created_at: new Date().toISOString(),
    source_batch: 'manual-edit',
    weight: 1,
    edited_at: null,
    fire_count_lifetime: 0,
  };
  cat.sequences.push(cloned);

  setStatus('儲存中...');
  try {
    await api.save(state.currentPersona, state.dialogues);
    state.selectedSequence = { category: sel.category, sequenceId: newId, ref: cloned };
    setStatus(`✅ 已複製 → ${newId}`);
    renderBrowse();
    renderEditPanel();
  } catch (err) {
    showError(err);
  }
}

async function onDeleteSequence() {
  const sel = state.selectedSequence;
  if (!sel) return;
  const seq = sel.ref;
  if (seq._meta?.source_batch === 'initial' && !state.unlocked) {
    setStatus('initial 鎖定句不可刪除（先解鎖）');
    return;
  }
  if (!confirm(`刪除 ${seq.sequenceId}？\n（會自動 backup .bak.<時間> 可還原）`)) return;

  const cat = state.dialogues.categories[sel.category];
  if (!cat) return;
  cat.sequences = cat.sequences.filter((s) => s.sequenceId !== seq.sequenceId);

  setStatus('儲存中...');
  try {
    await api.save(state.currentPersona, state.dialogues);
    state.selectedSequence = null;
    setStatus(`🗑 已刪除 ${seq.sequenceId}`);
    renderBrowse();
    renderEditPanel();
  } catch (err) {
    showError(err);
  }
}

// ── Tab 2: 批次匯入 ─────────────────────────────
function updateImportBatchTagPlaceholder() {
  const persona = $('import-persona').value;
  const category = $('import-category').value;
  const today = new Date().toISOString().slice(0, 10);
  $('import-batch-tag').placeholder = `${persona}-${category}-${today}`;
}

async function onImport({ dryRun }) {
  const persona = $('import-persona').value;
  const category = $('import-category').value.trim();
  const batch_tag = $('import-batch-tag').value.trim() || $('import-batch-tag').placeholder;
  const raw_text = $('import-text').value;
  const format = $('import-format').value;
  const mode = document.querySelector('input[name="import-mode"]:checked').value;

  if (!raw_text.trim()) {
    setImportPreview('（先貼草稿再按）', 'error');
    return;
  }
  if (!category) {
    setImportPreview('（要指定 category，可選現有或直接打字新建）', 'error');
    return;
  }

  // 隱藏可能殘留的「點去生語音」快捷鈕
  $('import-voice-shortcut').hidden = true;

  setStatus(dryRun ? '預覽中...' : '匯入中...');
  $('btn-apply').disabled = true;
  try {
    const result = await api.batchImport({
      persona, category, batch_tag, raw_text, mode, format, dryRun,
    });
    const lines = [];
    lines.push(`✅ 解析：valid=${result.parsed.valid}, skipped=${result.parsed.skipped}`);
    if (result.warnings?.length) {
      lines.push('');
      lines.push('⚠ 警告：');
      for (const w of result.warnings) lines.push(`  ${w}`);
    }
    if (result.summary?.byCategory) {
      lines.push('');
      lines.push('📦 變動：');
      for (const [cat, info] of Object.entries(result.summary.byCategory)) {
        lines.push(`  ${cat}: 新增 ${info.added}${info.replaced ? `（清掉非 initial ${info.replaced} 句）` : ''}`);
        if (info.first) lines.push(`     ${info.first} → ${info.last}（合計 ${info.total}）`);
      }
    }
    if (dryRun) {
      lines.push('');
      lines.push('📝 (預覽，未寫檔。確認沒問題按「套用」)');
      $('btn-apply').disabled = false;
    } else {
      lines.push('');
      lines.push(`💾 已寫入 dialogues.json（batch_tag="${batch_tag}"）`);
      // reload + 同步 dropdown（新 category 立刻出現在其他 tab）
      await loadCurrent();
      await loadFireCounts();
      renderBrowse();

      // 露出「點去生語音」快捷鈕
      const totalAdded = Object.values(result.summary?.byCategory || {})
        .reduce((sum, info) => sum + (info.added || 0), 0);
      if (totalAdded > 0) {
        const shortcut = $('import-voice-shortcut');
        shortcut.dataset.persona = persona;
        shortcut.querySelector('.hint').textContent = `📦 剛匯入 ${totalAdded} 條句子，缺對應語音檔。`;
        shortcut.hidden = false;
      }
    }
    setImportPreview(lines.join('\n'), dryRun ? 'ok' : 'ok');
    setStatus(dryRun ? '預覽完成' : '匯入完成');
  } catch (err) {
    setImportPreview(`錯誤：${err.message || err}`, 'error');
    setStatus('匯入失敗');
  }
}

// 「點去 Tab 5 生語音」快捷鈕：切到 voice tab + 自動把 persona 設好 + 觸發生成
async function onImportGoVoice() {
  const shortcut = $('import-voice-shortcut');
  const persona = shortcut?.dataset?.persona;
  if (!persona) return;
  // 切 Tab 5
  document.querySelector('.tab-btn[data-tab="voice"]')?.click();
  // 等 tab 切完跑 refreshVoiceTab（init / refresh），再設 persona + 啟動 batch
  setTimeout(() => {
    if ($('voice-batch-persona')) $('voice-batch-persona').value = persona;
    setStatus('已切到語音 Tab，按下「生成」開始批次');
    // 自動點「生成」？太自動可能讓使用者沒準備。讓使用者手動按比較保險
  }, 100);
  // 收掉快捷鈕（避免使用者點兩次）
  shortcut.hidden = true;
}

function setImportPreview(text, kind) {
  const el = $('import-preview');
  el.textContent = text;
  el.classList.remove('error', 'ok');
  if (kind) el.classList.add(kind);
}

// ── Tab 3: 統計 ─────────────────────────────────
async function refreshStats() {
  const persona = $('stats-persona').value;
  const days = state.fireRangeDays;

  setStatus('讀取統計...');
  try {
    const [data, statsRes] = await Promise.all([
      api.read(persona),
      api.fireStats(persona, days),
    ]);
    if (!data) {
      setText('stats-overview', '');
      $('stats-overview').innerHTML = '<div class="kv-empty">該 persona 沒有 dialogues.json</div>';
      return;
    }
    const counts = statsRes.counts || {};
    const byTrigger = statsRes.byTrigger || {};
    const byCategoryFire = statsRes.byCategory || {};

    // 總覽
    let initialCount = 0;
    let otherCount = 0;
    const allSeqs = [];
    const classDistTotal = {};   // content_class → 句數
    const classDistFire = {};    // content_class → 範圍內 fire 次數
    for (const [catName, cat] of Object.entries(data.categories || {})) {
      for (const seq of cat.sequences || []) {
        if (seq._meta?.source_batch === 'initial') initialCount++;
        else otherCount++;
        allSeqs.push({ category: catName, seq });
        const cc = seq._meta?.content_class || '—';
        classDistTotal[cc] = (classDistTotal[cc] || 0) + 1;
        classDistFire[cc] = (classDistFire[cc] || 0) + (counts[seq.sequenceId] || 0);
      }
    }
    const ov = $('stats-overview');
    ov.innerHTML = '';
    const total = initialCount + otherCount;
    const totalFire = Object.values(counts).reduce((a, b) => a + b, 0);
    const triggerKinds = Object.keys(byTrigger).length;
    ov.innerHTML = `
      <div>總句數：<strong>${total}</strong>（initial ${initialCount} / 其他 ${otherCount}）</div>
      <div>fire 總次數（範圍內）：<strong>${totalFire}</strong></div>
      <div>有 fire 的 sequence：<strong>${Object.keys(counts).length}</strong></div>
      <div>觸發類型數：<strong>${triggerKinds}</strong></div>
    `;

    // 熱門排行（fire >= 1，由多到少）
    const hot = allSeqs
      .map(({ category, seq }) => ({ category, seq, count: counts[seq.sequenceId] || 0 }))
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const hotEl = $('stats-hot');
    hotEl.innerHTML = '';
    if (hot.length === 0) {
      hotEl.innerHTML = '<li class="empty">範圍內沒人 fire 過</li>';
    } else {
      for (const r of hot) {
        const li = document.createElement('li');
        li.innerHTML = `
          <span class="rank-id">${escapeHtml(r.seq.sequenceId)}</span>
          <span class="rank-text">${escapeHtml(r.seq.lines?.[0]?.text?.slice(0, 40) || '')}</span>
          <span class="rank-count">${r.count}</span>
        `;
        hotEl.appendChild(li);
      }
    }

    // 冷門（fire = 0）
    const cold = allSeqs
      .map(({ category, seq }) => ({ category, seq, count: counts[seq.sequenceId] || 0 }))
      .filter((r) => r.count === 0)
      .slice(0, 15);

    const coldEl = $('stats-cold');
    coldEl.innerHTML = '';
    if (cold.length === 0) {
      coldEl.innerHTML = '<li class="empty">每句都有被 fire 到 ✨</li>';
    } else {
      for (const r of cold) {
        const li = document.createElement('li');
        li.innerHTML = `
          <span class="rank-id">${escapeHtml(r.seq.sequenceId)}</span>
          <span class="rank-text">${escapeHtml(r.seq.lines?.[0]?.text?.slice(0, 40) || '')}</span>
          <span class="rank-count">0</span>
        `;
        coldEl.appendChild(li);
      }
    }

    // 觸發類別分佈（rule_name）
    renderBarList('stats-by-trigger', byTrigger, { sortDesc: true });

    // 對話類別分佈（dialogues category vs fire 次數）
    renderBarList('stats-by-category', byCategoryFire, { sortDesc: true });

    // 內容類分佈（每類句數 + 範圍內 fire 次數）
    const classRows = {};
    for (const cc of [...CONTENT_CLASSES, '—']) {
      const t = classDistTotal[cc] || 0;
      const f = classDistFire[cc] || 0;
      if (t === 0 && f === 0) continue;
      const name = cc === '—' ? '未分類' : `${cc} ${CONTENT_CLASS_NAMES[cc] || ''}`;
      classRows[name] = { count: f, total: t };
    }
    renderBarList('stats-by-class', classRows, { sortDesc: true, secondary: 'total' });

    const rangeLabel = days === 0 ? '全部' : `過去 ${days} 天`;
    setText('stats-meta', `${rangeLabel}（${new Date(statsRes.since || 0).toLocaleString()} ~ now）`);
    setStatus('統計就緒');
  } catch (err) {
    showError(err);
  }
}

// 通用 bar list 渲染：data 可以是 {key: count} 或 {key: {count, total}}
function renderBarList(elId, data, opts = {}) {
  const el = $(elId);
  if (!el) return;
  el.innerHTML = '';

  const entries = Object.entries(data || {})
    .map(([k, v]) => {
      if (typeof v === 'object' && v !== null) return { key: k, count: v.count || 0, total: v.total };
      return { key: k, count: v || 0 };
    })
    .filter((e) => e.count > 0 || (opts.secondary && e.total > 0));

  if (entries.length === 0) {
    el.innerHTML = '<li class="empty">範圍內沒有資料</li>';
    return;
  }

  if (opts.sortDesc) entries.sort((a, b) => b.count - a.count);

  const max = Math.max(1, ...entries.map((e) => e.count));
  for (const e of entries) {
    const pct = Math.round((e.count / max) * 100);
    const li = document.createElement('li');
    const tail = opts.secondary === 'total' && Number.isFinite(e.total)
      ? ` / ${e.total} 句`
      : '';
    li.innerHTML = `
      <span class="bar-label" title="${escapeHtml(e.key)}">${escapeHtml(e.key)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
      <span class="bar-count">${e.count}${tail}</span>
    `;
    el.appendChild(li);
  }
}

// ── Tab 4: LLM Prompt ───────────────────────────
async function onGenPrompt() {
  const persona = $('prompt-persona').value;
  const category = $('prompt-category').value;
  if (!persona || !category) return;
  const count = parseInt($('prompt-count').value, 10) || 30;
  const classMix = collectClassMix();
  setStatus('產生 prompt...');
  $('btn-gen-prompt').disabled = true;
  try {
    const result = await api.genPrompt(persona, category, { count, classMix });
    $('prompt-output').value = result.prompt;
    $('btn-copy-prompt').disabled = false;
    const lines = result.prompt.split('\n').length;
    const chars = result.prompt.length;
    const mixHint = classMix && Object.keys(classMix).length > 0 ? '（含內容類配比）' : '';
    setText('prompt-meta', `${persona} / ${category} × ${count}${mixHint}　${lines} 行 / ${chars} 字`);
    setStatus('Prompt 已產生');
  } catch (err) {
    showError(err);
    $('prompt-output').value = `錯誤：${err.message || err}`;
  } finally {
    $('btn-gen-prompt').disabled = false;
  }
}

function collectClassMix() {
  const out = {};
  document.querySelectorAll('#prompt-class-mix input[type="number"]').forEach((el) => {
    const k = el.dataset.class;
    const v = parseFloat(el.value);
    if (k && Number.isFinite(v) && v > 0) out[k] = v;
  });
  return out;
}

function updateMixSum() {
  const mix = collectClassMix();
  const sum = Object.values(mix).reduce((a, b) => a + b, 0);
  const el = $('prompt-mix-sum');
  if (!el) return;
  if (sum === 0) {
    el.textContent = '總和 0%（全 0 = 不指定，由 LLM 依 category 自由發揮）';
    el.style.color = '';
  } else if (Math.abs(sum - 100) < 0.5) {
    el.textContent = `總和 100% ✅`;
    el.style.color = 'var(--ok)';
  } else {
    el.textContent = `總和 ${sum}%（不必嚴格 100%，視為相對權重）`;
    el.style.color = 'var(--warn)';
  }
}

function applyMixPreset(preset) {
  document.querySelectorAll('#prompt-class-mix input[type="number"]').forEach((el) => {
    const k = el.dataset.class;
    el.value = preset[k] != null ? preset[k] : 0;
  });
  updateMixSum();
}

async function onCopyPrompt() {
  const text = $('prompt-output').value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const btn = $('btn-copy-prompt');
    const orig = btn.textContent;
    btn.textContent = '✅ 已複製！';
    setStatus('已複製到剪貼簿，貼到 LLM 即可');
    setTimeout(() => { btn.textContent = orig; }, 2000);
  } catch (err) {
    // 退路：select + execCommand（極舊環境）
    const ta = $('prompt-output');
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
      setStatus('已複製（fallback 模式）');
    } catch (_e) {
      showError(err);
    }
  }
}

function clearPromptOutput() {
  $('prompt-output').value = '';
  $('btn-copy-prompt').disabled = true;
  setText('prompt-meta', '—');
}

// ── Tab 5: Voice ─────────────────────────────────
async function refreshVoiceTab() {
  await refreshEngineStatus();
  await onVoiceCheck();
  await renderVoicePersonasList();
  // 「清除對話 + 語音」目標 persona 顯示
  const wipeTargetEl = $('wipe-target-name');
  if (wipeTargetEl) wipeTargetEl.textContent = state.currentPersona || '—';
}

async function onWipeCurrentPersona() {
  const personaId = state.currentPersona;
  if (!personaId) { setStatus('沒有選中 persona'); return; }
  const confirmed = confirm(
    `確定清除 "${personaId}" 的所有對話 + 語音？\n\n` +
    `• dialogues.json / dialogues-initial.json sequences 全清（保 category 結構）\n` +
    `• voices/ + voices-time/ 整個移到 backup 資料夾\n` +
    `• persona.json / voice-refs / appearance 不動\n\n` +
    `會自動備份到 personas/${personaId}/_wipe-<時間戳>/，可手動還原`
  );
  if (!confirmed) return;
  $('btn-wipe-content').disabled = true;
  setStatus(`清除 ${personaId} 中⋯⋯`);
  try {
    const result = await api.personaPackWipeContent(personaId);
    const w = result.wiped;
    const msg = `✅ 已清除 ${personaId}：對話 ${w.dialogues} 句、voices ${w.voices} 個 wav、voices-time ${w.time_voices} 個 wav\n備份：${result.backup_dir}`;
    setStatus(msg);
    const box = $('wipe-result');
    if (box) { box.hidden = false; box.textContent = msg; }
    // 重整 UI（dialogues 跟 voice stats 都受影響）
    await loadCurrent();
    await loadFireCounts();
    renderBrowse();
    await renderVoicePersonasList();
  } catch (err) {
    showError(err);
  } finally {
    $('btn-wipe-content').disabled = false;
  }
}

// 引擎子進程狀態 + log
async function refreshEngineStatus() {
  try {
    const result = await api.voiceEngineGetStatus();
    applyEngineStatus(result.status, result.last_error);
    // 把已有的 log 倒進 box
    const box = $('engine-log-box');
    if (box && Array.isArray(result.logs) && result.logs.length > 0) {
      box.hidden = false;
      box.textContent = result.logs.join('\n');
      box.scrollTop = box.scrollHeight;
    }
  } catch (err) {
    console.warn('[engine] status load failed:', err);
  }
}

function applyEngineStatus(status, lastError) {
  const el = $('engine-proc-status');
  const hint = $('engine-proc-hint');
  const btnStart = $('btn-engine-start');
  const btnStop = $('btn-engine-stop');
  if (!el) return;
  el.className = `engine-proc-status engine-proc-status--${status}`;
  const label = {
    stopped: '⏹ 已停止',
    starting: '🔄 啟動中⋯⋯',
    running: '✅ 運行中',
    error: '❌ 錯誤',
  }[status] || status;
  el.textContent = label;

  if (btnStart) btnStart.disabled = (status === 'starting' || status === 'running');
  if (btnStop) btnStop.disabled = (status === 'stopped' || status === 'error');

  if (hint) {
    if (status === 'stopped') hint.textContent = '未啟動。點「啟動引擎」自動跑 GPT-SoVITS api.py';
    else if (status === 'starting') hint.textContent = '啟動中⋯⋯通常 30-90 秒（loading SoVITS / GPT 權重）';
    else if (status === 'running') hint.textContent = '✅ 運行中（檢查連線確認 HTTP API 也通）';
    else if (status === 'error') hint.textContent = `❌ ${lastError || '啟動失敗，看 log'}`;
  }
}

function appendEngineLog(line) {
  const box = $('engine-log-box');
  if (!box) return;
  box.hidden = false;
  box.textContent += (box.textContent ? '\n' : '') + line;
  // 保留最近 ~500 行（避免長 log 卡 UI）
  const lines = box.textContent.split('\n');
  if (lines.length > 500) {
    box.textContent = lines.slice(-500).join('\n');
  }
  box.scrollTop = box.scrollHeight;
}

async function onEngineStart() {
  $('btn-engine-start').disabled = true;
  applyEngineStatus('starting');
  setStatus('啟動 GPT-SoVITS 引擎中⋯⋯');
  try {
    await api.voiceEngineStart();
    setStatus('✅ 引擎啟動完成');
    // 順便重檢 HTTP 連線
    setTimeout(onVoiceCheck, 500);
  } catch (err) {
    setStatus(`❌ ${err.message}`);
    applyEngineStatus('error', err.message);
  }
}

async function onEngineStop() {
  if (!confirm('停止 GPT-SoVITS 引擎？停止後 ~6GB VRAM 會釋放。')) return;
  $('btn-engine-stop').disabled = true;
  setStatus('停止引擎中⋯⋯');
  try {
    await api.voiceEngineStop();
    setStatus('🛑 引擎已停止');
  } catch (err) {
    setStatus(`❌ ${err.message}`);
  }
}

async function onEngineSettingsOpen() {
  try {
    const cfg = await api.voiceEngineConfigGet();
    $('engine-cfg-cwd').value = cfg.cwd || '';
    $('engine-cfg-python').value = cfg.python || '';
    $('engine-cfg-script').value = cfg.script || '';
    $('engine-cfg-timeout').value = cfg.startup_timeout_sec || 180;
    $('engine-cfg-wait').value = cfg.wait_for_text || 'Uvicorn running on';
    $('engine-settings-modal').hidden = false;
  } catch (err) {
    showError(err);
  }
}

function onEngineSettingsClose() {
  $('engine-settings-modal').hidden = true;
}

async function onEngineSettingsSave() {
  const cfg = {
    cwd: $('engine-cfg-cwd').value.trim(),
    python: $('engine-cfg-python').value.trim() || '.venv/Scripts/python.exe',
    script: $('engine-cfg-script').value.trim() || 'api.py',
    args: [],
    wait_for_text: $('engine-cfg-wait').value.trim() || 'Uvicorn running on',
    startup_timeout_sec: parseInt($('engine-cfg-timeout').value, 10) || 180,
  };
  if (!cfg.cwd) {
    alert('cwd（安裝目錄）不可空');
    return;
  }
  try {
    await api.voiceEngineConfigSet(cfg);
    setStatus('✅ 引擎設定已儲存');
    onEngineSettingsClose();
  } catch (err) {
    showError(err);
  }
}

async function onVoiceCheck() {
  setText('voice-engine-status', '● 檢查中...');
  $('voice-engine-status').className = 'voice-status voice-status--unknown';
  try {
    const result = await api.voiceCheckEngine();
    if (result.online) {
      setText('voice-engine-status', '● Online');
      $('voice-engine-status').className = 'voice-status voice-status--online';
      setText('voice-engine-hint', `已連線到 ${result.base_url}`);
    } else {
      setText('voice-engine-status', '● Offline');
      $('voice-engine-status').className = 'voice-status voice-status--offline';
      setText('voice-engine-hint', `${result.base_url} 連不到 — 確認 GPT-SoVITS api.py 已啟動`);
    }
  } catch (err) {
    setText('voice-engine-status', '● Error');
    $('voice-engine-status').className = 'voice-status voice-status--offline';
    setText('voice-engine-hint', err.message || String(err));
  }
}

async function renderVoicePersonasList() {
  const cfg = await api.voiceGetConfig();
  const container = $('voice-personas-list');
  container.innerHTML = '';

  for (const p of state.personas) {
    const v = cfg.voices?.[p.id] || { ref_audio: '', ref_text: '', ref_lang: 'ja', voice_lang: 'ja', additional_refs: [] };
    // v3 schema 兼容：優先 ref_lang，fallback 舊 lang
    const refLang = v.ref_lang || v.lang || 'ja';
    const voiceLang = v.voice_lang || v.lang || 'ja';
    const stats = await api.voiceListStats(p.id, voiceLang).catch(() => ({ total_lines: 0, generated: 0, missing: 0 }));
    const additionalRefs = Array.isArray(v.additional_refs) ? v.additional_refs : [];
    const additionalRefsText = additionalRefs.join('\n');

    const row = document.createElement('div');
    row.className = 'voice-persona-row';
    row.innerHTML = `
      <div class="row-label">${escapeHtml(p.display_name)}<br><span style="font-size:10px;font-family:Consolas;color:var(--fg-muted);">${escapeHtml(p.id)}</span></div>
      <div class="row-fields">
        <label>主 Ref audio 路徑（相對 persona dir，例 voice-refs/xxx.wav）
          <input type="text" data-persona="${escapeHtml(p.id)}" data-field="ref_audio" value="${escapeHtml(v.ref_audio || '')}" placeholder="voice-refs/${escapeHtml(p.id)}-ref-ja.wav" />
        </label>
        <label>Ref text（主 ref 的逐字稿）
          <input type="text" data-persona="${escapeHtml(p.id)}" data-field="ref_text" value="${escapeHtml(v.ref_text || '')}" placeholder="この私から逃げるつもり？面白い。" />
        </label>
        <div class="row-grid">
          <label>Ref 語言（ref_audio 的語言）
            <select data-persona="${escapeHtml(p.id)}" data-field="ref_lang">
              <option value="zh"${refLang === 'zh' ? ' selected' : ''}>中文 zh</option>
              <option value="ja"${refLang === 'ja' ? ' selected' : ''}>日文 ja</option>
              <option value="en"${refLang === 'en' ? ' selected' : ''}>英文 en</option>
            </select>
          </label>
          <label>Voice 語言（TTS 輸出語言，雙語字幕用 ja）
            <select data-persona="${escapeHtml(p.id)}" data-field="voice_lang">
              <option value="zh"${voiceLang === 'zh' ? ' selected' : ''}>中文 zh</option>
              <option value="ja"${voiceLang === 'ja' ? ' selected' : ''}>日文 ja</option>
              <option value="en"${voiceLang === 'en' ? ' selected' : ''}>英文 en</option>
            </select>
          </label>
        </div>
        <label>額外 ref（每行一個路徑，建議同性別，平均融合音色更穩）
          <textarea rows="3" data-persona="${escapeHtml(p.id)}" data-field="additional_refs" placeholder="voice-refs/${escapeHtml(p.id)}-ref-2.wav&#10;voice-refs/${escapeHtml(p.id)}-ref-3.wav">${escapeHtml(additionalRefsText)}</textarea>
        </label>
        <label>試聽測試文字（不會存進 config，每次自訂）
          <input type="text" data-persona="${escapeHtml(p.id)}" data-test="1" placeholder="${escapeHtml(p.id === 'haiyin' ? '誒誒～要帶我去哪？' : '主人您回來了～')}" />
        </label>
        <div class="voice-stats">已生成 <strong>${stats.generated}</strong> / 共 <strong>${stats.total_lines}</strong> 行（缺 ${stats.missing}）${additionalRefs.length ? ` · 多 ref ${additionalRefs.length} 個` : ''}</div>
        <div class="row-actions">
          <button type="button" class="btn btn-secondary" data-action="save" data-persona="${escapeHtml(p.id)}">儲存</button>
          <button type="button" class="btn btn-secondary" data-action="test" data-persona="${escapeHtml(p.id)}">試聽</button>
        </div>
      </div>
    `;
    container.appendChild(row);
  }

  container.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const persona = btn.dataset.persona;
      if (action === 'save') saveVoiceForPersona(persona);
      else if (action === 'test') testVoiceForPersona(persona);
    });
  });
}

async function saveVoiceForPersona(personaId) {
  const cfg = await api.voiceGetConfig();
  cfg.voices = cfg.voices || {};
  const inputs = $('voice-personas-list').querySelectorAll(`[data-persona="${personaId}"]`);
  const updated = { ...(cfg.voices[personaId] || {}) };
  for (const el of inputs) {
    const field = el.dataset.field;
    if (!field) continue;
    if (field === 'additional_refs') {
      // textarea：每行一個路徑，過濾空白行
      updated[field] = el.value
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else {
      updated[field] = el.value;
    }
  }
  cfg.voices[personaId] = updated;
  try {
    await api.voiceSetConfig(cfg);
    setStatus(`✅ 已儲存 ${personaId} voice 設定（${(updated.additional_refs || []).length} 個額外 ref）`);
    await renderVoicePersonasList();
  } catch (err) {
    showError(err);
  }
}

// 各 persona × 各語言的試聽預設文字（依 voice_lang 切，避免送中文給 ja TTS）
const TEST_VOICE_DEFAULTS = {
  haiyin: {
    zh: '誒誒～要帶我去哪？',
    ja: 'ねえねえ、どこ連れていくの？',
    en: 'Hey, where are you taking me?',
  },
  liss: {
    zh: '主人您回來了～最愛的主人♡',
    ja: 'おかえりなさい、だいすきなごしゅじんさま♡',
    en: 'Welcome back, master.',
  },
};

async function testVoiceForPersona(personaId) {
  // ⚠ saveVoiceForPersona 會 re-render 整個 list，把 [data-test] input 清空。
  //   所以「先讀使用者輸入」→ 再儲存 → 還原 input 值，否則 customText 會吃到空字串。
  const customInputBefore = document.querySelector(`[data-persona="${personaId}"][data-test="1"]`);
  const customText = customInputBefore?.value?.trim() || '';

  await saveVoiceForPersona(personaId);

  // 重 render 後 input 變空，把使用者剛才輸入的值還原回去
  const customInputAfter = document.querySelector(`[data-persona="${personaId}"][data-test="1"]`);
  if (customInputAfter && customText) customInputAfter.value = customText;

  // 取該 persona 的 voice_lang，挑對應預設文字（沒填 customText 時用）
  const voiceLang = await getPersonaVoiceLang(personaId);
  const lang = voiceLang || 'zh';
  const defaultBank = TEST_VOICE_DEFAULTS[personaId] || TEST_VOICE_DEFAULTS.liss;
  const defaultText = defaultBank[lang] || defaultBank.zh || '主人您回來了～';
  const sampleText = customText || defaultText;

  setStatus(`🔊 試聽生成中（${personaId} / ${lang}）...`);
  try {
    // 把 lang 也傳過去（TTS target_lang），不然會用 persona default 但可能跟 customText 語言不符
    const result = await api.voiceTestTTS(personaId, sampleText, lang);
    setStatus(`✅ 試聽完成「${sampleText.slice(0, 20)}${sampleText.length > 20 ? '…' : ''}」（${result.ms}ms / ${result.bytes} bytes）`);
    // Windows 絕對路徑需要三斜線 file:///
    const audio = new Audio(`file:///${result.file_path.replace(/\\/g, '/')}`);
    audio.play().catch((err) => {
      console.warn('audio play failed:', err);
      setStatus(`❌ 試聽播放失敗：${err.message || err}`);
    });
  } catch (err) {
    showError(err);
  }
}

let _voiceProgressBatchPersona = null;

async function onVoiceStart() {
  const persona = $('voice-batch-persona').value;
  const lang = $('voice-batch-lang').value;
  const mode = document.querySelector('input[name="voice-batch-mode"]:checked').value;

  if (!persona) { setStatus('請先選 persona'); return; }

  $('btn-voice-start').disabled = true;
  $('btn-voice-cancel').disabled = false;
  $('voice-progress').hidden = false;
  $('voice-batch-result').textContent = '啟動中...';
  _voiceProgressBatchPersona = persona;

  try {
    const result = await api.voiceGenerateBatch(persona, mode, lang);
    setStatus(`批次啟動：${result.total_candidates} 句候選`);
  } catch (err) {
    $('btn-voice-start').disabled = false;
    $('btn-voice-cancel').disabled = true;
    $('voice-batch-result').textContent = `錯誤：${err.message || err}`;
    showError(err);
  }
}

async function onVoiceCancel() {
  try {
    await api.voiceCancel();
    setStatus('已送出取消請求（in-flight 句仍會跑完）');
  } catch (err) {
    showError(err);
  }
}

function onVoiceProgress(payload) {
  if (!payload) return;
  const { done = 0, total = 0, succeeded = 0, failed = 0, skipped = 0, current, phase } = payload;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  $('voice-progress-fill').style.width = `${pct}%`;
  setText('voice-progress-text', `${done} / ${total} (${pct}%)　成功 ${succeeded} / 失敗 ${failed}${skipped ? `　已存在略過 ${skipped}` : ''}`);
  setText('voice-progress-current', current ? `當前：${current.sequence_id}_${current.line_idx}` : (phase || ''));
}

function onVoiceBatchDone(payload) {
  $('btn-voice-start').disabled = false;
  $('btn-voice-cancel').disabled = true;
  if (payload?.error) {
    $('voice-batch-result').textContent = `❌ 失敗：${payload.error}`;
    setStatus(`批次失敗：${payload.error}`);
  } else {
    const s = payload?.summary || {};
    $('voice-batch-result').textContent =
      `✅ 完成\n  總計 ${s.total} 句　成功 ${s.succeeded} / 失敗 ${s.failed}\n` +
      `  跳過已存在 ${s.skipped || 0}\n` +
      (s.errors?.length ? `\n錯誤摘要（前 5 筆）：\n${s.errors.slice(0, 5).map((e) => `  ${e.sequence_id}_${e.line_idx}: ${e.message}`).join('\n')}` : '');
    setStatus('批次完成');
  }
  // 重新整理 stats
  renderVoicePersonasList().catch(() => {});
}

// ── Tab 6: 時間語音 ─────────────────────────────────
const TV_CATEGORY_LABELS = {
  hour: '小時',
  period: '時段詞',
};

async function refreshTimeVoiceTab() {
  if (!tvState.persona) tvState.persona = state.currentPersona;
  if (!tvState.persona) return;
  // 第一次進 Tab 6 / persona 切換時，lang 還沒設 → 從 persona.voice_lang 補
  if (!tvState.lang) {
    tvState.lang = await getPersonaVoiceLang(tvState.persona);
    if ($('tv-lang')) $('tv-lang').value = tvState.lang;
  }
  setStatus(`載入時間音清單 ${tvState.persona}/${tvState.lang}...`);
  try {
    const result = await api.voiceListTimeStats(tvState.persona, tvState.lang);
    tvState.items = result.items || [];
    setText('tv-stats-summary',
      `● 已生 ${result.generated} / ${result.total}　⚠ stale ${result.stale}　❌ 缺 ${result.missing}`
    );
    renderTimeVoiceTable();
    setStatus('時間音就緒');
  } catch (err) {
    showError(err);
  }
}

function renderTimeVoiceTable() {
  const tbody = $('tv-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (tvState.items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">沒有候選（lang 不支援？）</td></tr>';
    return;
  }
  for (const item of tvState.items) {
    tbody.appendChild(createTimeVoiceRow(item));
  }
}

function createTimeVoiceRow(item) {
  const tr = document.createElement('tr');
  tr.dataset.key = item.key;

  // 文字 cell：editing mode 變 input；否則純顯示
  const textCellHtml = (tvState.editingKey === item.key)
    ? `<input type="text" class="tv-edit-input" data-edit-input value="${escapeHtml(item.text)}" />`
    : `<span class="tv-text-cell ${item.is_override ? 'is-override' : ''}" title="${item.is_override ? `已客製（預設：${escapeHtml(item.default_text)}）` : '使用預設'}">${escapeHtml(item.text)}</span>`;

  // 狀態 badge
  const statusLabel = { fresh: '✅ 已生', stale: '⚠ stale', missing: '❌ 未生' }[item.status];
  const statusBadge = `<span class="tv-status ${item.status}">${statusLabel}</span>`;

  // 操作
  const isEditing = tvState.editingKey === item.key;
  const canPreview = item.status !== 'missing' && !!item.file_url;
  const actionsHtml = isEditing
    ? `<button type="button" class="btn-mini" data-act="save">💾 儲存</button>
       <button type="button" class="btn-mini" data-act="cancel">✗ 取消</button>`
    : `<button type="button" class="btn-mini" data-act="preview" ${canPreview ? '' : 'disabled'}>🔊 ▶</button>
       <button type="button" class="btn-mini" data-act="edit">✏</button>
       <button type="button" class="btn-mini tv-act-delete ${item.status === 'stale' ? 'is-needed' : ''}" data-act="delete" ${item.status === 'missing' ? 'disabled' : ''} title="刪除此語音檔（要重生請按上方批次按鈕）">🗑</button>${
         item.is_override ? `<button type="button" class="btn-mini" data-act="reset" title="清除客製文字回預設">⟲</button>` : ''
       }`;

  tr.innerHTML = `
    <td class="tv-col-key">${escapeHtml(item.key)}</td>
    <td class="tv-col-cat">${TV_CATEGORY_LABELS[item.category] || item.category}</td>
    <td>${textCellHtml}</td>
    <td class="tv-col-status">${statusBadge}</td>
    <td class="tv-col-actions"><div class="tv-actions">${actionsHtml}</div></td>
  `;

  tr.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'edit') onTimeVoiceEditStart(item.key);
      else if (act === 'cancel') onTimeVoiceEditCancel();
      else if (act === 'save') onTimeVoiceEditSave(item.key, tr);
      else if (act === 'preview') onTimeVoicePreview(item);
      else if (act === 'delete') onTimeVoiceDeleteOne(item.key);
      else if (act === 'reset') onTimeVoiceResetOne(item.key);
    });
  });

  // editing mode 進來時 focus + Enter 儲存 / Esc 取消
  if (isEditing) {
    setTimeout(() => {
      const input = tr.querySelector('[data-edit-input]');
      if (input) {
        input.focus();
        input.select();
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); onTimeVoiceEditSave(item.key, tr); }
          if (e.key === 'Escape') { e.preventDefault(); onTimeVoiceEditCancel(); }
        });
      }
    }, 0);
  }
  return tr;
}

function onTimeVoiceEditStart(key) {
  tvState.editingKey = key;
  renderTimeVoiceTable();
}

function onTimeVoiceEditCancel() {
  tvState.editingKey = null;
  renderTimeVoiceTable();
}

async function onTimeVoiceEditSave(key, row) {
  const input = row.querySelector('[data-edit-input]');
  const newText = (input?.value || '').trim();
  const item = tvState.items.find((it) => it.key === key);
  if (!item) return;

  // 跟預設一樣 → 等於清除 override
  const isClearing = !newText || newText === item.default_text;

  setStatus(`儲存 ${key}...`);
  try {
    if (isClearing) {
      await api.voiceResetTimeTextOverride(tvState.persona, tvState.lang, key);
    } else {
      await api.voiceSetTimeTextOverride(tvState.persona, tvState.lang, key, newText);
    }
    tvState.editingKey = null;
    await refreshTimeVoiceTab();
    setStatus(`✅ ${key} 文字已更新（建議按 ↻ 重生語音）`);
  } catch (err) {
    showError(err);
  }
}

function onTimeVoicePreview(item) {
  if (!item.file_url) return;
  if (tvState.currentAudio) {
    try { tvState.currentAudio.pause(); } catch (_e) {}
    tvState.currentAudio = null;
  }
  const audio = new Audio(item.file_url);
  audio.volume = 0.8;
  audio.play().catch((err) => {
    setStatus(`❌ 試聽失敗：${err.message}`);
  });
  tvState.currentAudio = audio;
  setStatus(`🔊 試聽 ${item.key}`);
}

async function onTimeVoiceDeleteOne(key) {
  if (tvState.batchRunning) {
    setStatus('批次跑中，請等完成');
    return;
  }
  if (!confirm(`刪除 ${key} 的語音檔？\n（要重新生成，請按上方「▶ 批次生成」）`)) return;
  try {
    await api.voiceDeleteTimeOne(tvState.persona, tvState.lang, key);
    await refreshTimeVoiceTab();
    setStatus(`🗑 ${key} 語音已刪除（status → missing）`);
  } catch (err) {
    showError(err);
  }
}

async function onTimeVoiceResetOne(key) {
  if (!confirm(`重置 ${key} 文字回預設？\n（語音檔不會刪，但 status 可能變 stale）`)) return;
  try {
    await api.voiceResetTimeTextOverride(tvState.persona, tvState.lang, key);
    await refreshTimeVoiceTab();
    setStatus(`⟲ ${key} 已回預設文字`);
  } catch (err) {
    showError(err);
  }
}

async function onTimeVoiceResetAll() {
  if (!confirm(`清除 ${tvState.persona}/${tvState.lang} 所有時間音的客製文字？\n（語音檔不會刪）`)) return;
  try {
    await api.voiceResetAllTimeOverrides(tvState.persona, tvState.lang);
    await refreshTimeVoiceTab();
    setStatus('⟲ 全部 override 已清除');
  } catch (err) {
    showError(err);
  }
}

async function onTimeVoiceBatchStart() {
  const mode = document.querySelector('input[name="tv-batch-mode"]:checked')?.value || 'missing';
  $('tv-batch-start').disabled = true;
  $('tv-batch-cancel').disabled = false;
  $('tv-progress').hidden = false;
  $('tv-progress-fill').style.width = '0%';
  setText('tv-progress-text', '0 / 0');
  setText('tv-progress-current', '啟動中…');
  $('tv-batch-result').hidden = true;
  tvState.batchRunning = true;
  try {
    const result = await api.voiceGenerateTimeBatch(tvState.persona, mode, tvState.lang);
    setStatus(`時間音批次啟動：${result.total_candidates} 條候選`);
  } catch (err) {
    tvState.batchRunning = false;
    $('tv-batch-start').disabled = false;
    $('tv-batch-cancel').disabled = true;
    $('tv-progress').hidden = true;
    showError(err);
  }
}

async function onTimeVoiceBatchCancel() {
  try {
    await api.voiceCancel();
    setStatus('已送出取消請求（in-flight 仍會跑完）');
  } catch (err) {
    showError(err);
  }
}

// 批次 progress / done 走的是共用 voice:progress / voice:batch-done
// 透過 payload.kind === 'time' 分流
function onTimeVoiceProgress(payload) {
  if (!payload || payload.kind !== 'time') return;
  const { done = 0, total = 0, succeeded = 0, failed = 0, skipped = 0, current, phase } = payload;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  $('tv-progress-fill').style.width = `${pct}%`;
  setText('tv-progress-text', `${done} / ${total} (${pct}%)　成功 ${succeeded} / 失敗 ${failed}${skipped ? `　略過 ${skipped}` : ''}`);
  setText('tv-progress-current', current ? `當前：${current.sequence_id}` : (phase || ''));
}

function onTimeVoiceBatchDone(payload) {
  if (!payload || payload.kind !== 'time') return;
  tvState.batchRunning = false;
  $('tv-batch-start').disabled = false;
  $('tv-batch-cancel').disabled = true;
  if (payload.error) {
    $('tv-batch-result').hidden = false;
    $('tv-batch-result').textContent = `❌ 批次失敗：${payload.error}`;
    setStatus('時間音批次失敗');
  } else {
    const s = payload.summary || {};
    $('tv-batch-result').hidden = false;
    $('tv-batch-result').textContent =
      `✅ 完成 ${s.total} 條（成功 ${s.succeeded} / 失敗 ${s.failed} / 略過 ${s.skipped || 0}）`;
    setStatus('時間音批次完成');
  }
  refreshTimeVoiceTab().catch(() => {});
}

// ── utils ────────────────────────────────────────
function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatTs(s) {
  if (!s) return null;
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleString();
  } catch (_e) { return s; }
}

init().catch(showError);
