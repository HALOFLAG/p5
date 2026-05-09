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
  fireRangeDays: 7,        // 統計 tab 用
  selectedSequence: null,  // { category, sequenceId, ref(指向 dialogues 內的 obj) }
  unlocked: false,         // 是否已解鎖編輯 initial 句
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
  for (const sel of [$('browse-persona'), $('import-persona'), $('stats-persona'), $('prompt-persona')]) {
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

  // 預設 batch tag
  updateImportBatchTagPlaceholder();

  bindEvents();

  await loadCurrent();
  await loadFireCounts();
  renderBrowse();
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
  $('btn-unlock').addEventListener('click', () => {
    if (!confirm('解鎖後可編輯 initial 句。\n注意：dialogues-initial.json 不會被同步更新（種子檔不可變）。\n\n確定要解鎖嗎？')) return;
    state.unlocked = true;
    renderEditPanel();
  });

  // ── Tab 2 import ──
  $('import-persona').addEventListener('change', () => {
    updateImportBatchTagPlaceholder();
  });
  $('import-category').addEventListener('change', updateImportBatchTagPlaceholder);
  $('btn-preview').addEventListener('click', () => onImport({ dryRun: true }));
  $('btn-apply').addEventListener('click', () => onImport({ dryRun: false }));

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
  $('prompt-category').addEventListener('change', () => clearPromptOutput());

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
  } catch (err) {
    showError(err);
  }
}

async function loadFireCounts() {
  if (!state.currentPersona) return;
  try {
    const result = await api.fireStats(state.currentPersona, state.fireRangeDays);
    state.fireCounts = result.counts || {};
  } catch (err) {
    state.fireCounts = {};
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
    tbody.innerHTML = '<tr><td colspan="5" class="empty">沒有資料</td></tr>';
    setText('browse-meta', '—');
    return;
  }

  const filterCat = $('browse-category').value;
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
    tbody.innerHTML = '<tr><td colspan="5" class="empty">無符合條件的 sequences</td></tr>';
  } else {
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.dataset.category = r.category;
      tr.dataset.sequenceId = r.sequence.sequenceId;
      if (r.isInitial) tr.classList.add('row-locked');
      if (r.sequence.type === 'thought') tr.classList.add('row-thought');
      if (state.selectedSequence?.sequenceId === r.sequence.sequenceId) tr.classList.add('selected');

      tr.innerHTML = `
        <td class="col-id">${escapeHtml(r.sequence.sequenceId)}</td>
        <td class="col-type">${escapeHtml(r.sequence.type || 'speech')}</td>
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

  const firstLine = seq.lines?.[0] || { text: '', expression: '' };
  $('edit-type').value = seq.type || 'speech';
  $('edit-expression').value = firstLine.expression || '';
  $('edit-text').value = firstLine.text || '';
  $('edit-interaction').value = seq.interaction || '';
  $('edit-auto-close').value = seq.auto_close_ms || '';

  setText('meta-source', seq._meta?.source_batch || '—');
  setText('meta-created', formatTs(seq._meta?.created_at));
  setText('meta-edited', formatTs(seq._meta?.edited_at) || '從未');
  setText('meta-fire-count', String(seq._meta?.fire_count_lifetime || 0));

  $('btn-save').disabled = locked;
  $('btn-delete').disabled = locked;
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

  const interaction = $('edit-interaction').value;
  if (interaction) seq.interaction = interaction;
  else delete seq.interaction;

  const ms = parseInt($('edit-auto-close').value, 10);
  if (Number.isFinite(ms) && ms > 0) seq.auto_close_ms = ms;
  else delete seq.auto_close_ms;

  seq._meta = seq._meta || {};
  seq._meta.edited_at = new Date().toISOString();

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
  const category = $('import-category').value;
  const batch_tag = $('import-batch-tag').value.trim() || $('import-batch-tag').placeholder;
  const raw_text = $('import-text').value;
  const format = $('import-format').value;
  const mode = document.querySelector('input[name="import-mode"]:checked').value;

  if (!raw_text.trim()) {
    setImportPreview('（先貼草稿再按）', 'error');
    return;
  }

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
      // reload
      await loadCurrent();
      await loadFireCounts();
      renderBrowse();
    }
    setImportPreview(lines.join('\n'), dryRun ? 'ok' : 'ok');
    setStatus(dryRun ? '預覽完成' : '匯入完成');
  } catch (err) {
    setImportPreview(`錯誤：${err.message || err}`, 'error');
    setStatus('匯入失敗');
  }
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

    // 總覽
    let initialCount = 0;
    let otherCount = 0;
    const allSeqs = [];
    for (const [catName, cat] of Object.entries(data.categories || {})) {
      for (const seq of cat.sequences || []) {
        if (seq._meta?.source_batch === 'initial') initialCount++;
        else otherCount++;
        allSeqs.push({ category: catName, seq });
      }
    }
    const ov = $('stats-overview');
    ov.innerHTML = '';
    const total = initialCount + otherCount;
    ov.innerHTML = `
      <div>總句數：<strong>${total}</strong>（initial ${initialCount} / 其他 ${otherCount}）</div>
      <div>fire 總次數（範圍內）：<strong>${Object.values(counts).reduce((a, b) => a + b, 0)}</strong></div>
      <div>有 fire 的 sequence：<strong>${Object.keys(counts).length}</strong></div>
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

    const rangeLabel = days === 0 ? '全部' : `過去 ${days} 天`;
    setText('stats-meta', `${rangeLabel}（${new Date(statsRes.since || 0).toLocaleString()} ~ now）`);
    setStatus('統計就緒');
  } catch (err) {
    showError(err);
  }
}

// ── Tab 4: LLM Prompt ───────────────────────────
async function onGenPrompt() {
  const persona = $('prompt-persona').value;
  const category = $('prompt-category').value;
  if (!persona || !category) return;
  setStatus('產生 prompt...');
  $('btn-gen-prompt').disabled = true;
  try {
    const result = await api.genPrompt(persona, category);
    $('prompt-output').value = result.prompt;
    $('btn-copy-prompt').disabled = false;
    const lines = result.prompt.split('\n').length;
    const chars = result.prompt.length;
    setText('prompt-meta', `${persona} / ${category}　${lines} 行 / ${chars} 字`);
    setStatus('Prompt 已產生');
  } catch (err) {
    showError(err);
    $('prompt-output').value = `錯誤：${err.message || err}`;
  } finally {
    $('btn-gen-prompt').disabled = false;
  }
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
