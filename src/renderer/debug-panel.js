// p5 Debug 面板 renderer
//
// 設計：
//   - 6 個 tab，nav.tab-btn[data-tab=...] ↔ section.tab-content[data-tab=...]
//   - 切換不刷新整頁，只 hide/show
//   - 每 tab 有自己的 init / refresh / cleanup（cleanup 只在「切離」時叫，目前只 Tab 1 polling 需要）
//   - 第一次點 tab 才 fetch（lazy load），手動「重新整理」按鈕 force refetch
//   - Tab 1（即時）獨立 1 秒 interval；切離時 clearInterval
//   - 全部呼叫 window.debugApi.*（preload exposed）

(function () {
  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root = document) => root.querySelectorAll(sel);
  const fmtTime = (ms) => new Date(ms).toLocaleString('zh-Hant', { hour12: false });
  const DAY_LABELS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

  // ── 全域狀態 ──────────────────────────────────────
  let activeTab = 'counters';
  let pollHandle = null;
  const initialized = new Set();

  // ── env / footer ─────────────────────────────────
  window.debugApi.envInfo()
    .then((env) => {
      const parts = [];
      if (env) {
        if (env.electronVersion) parts.push(`Electron ${env.electronVersion}`);
        if (env.nodeVersion) parts.push(`Node ${env.nodeVersion}`);
        if (env.appVersion) parts.push(`p5 ${env.appVersion}`);
        if (env.isDev) parts.push('DEV');
      }
      $('env-info').textContent = parts.join(' · ') || '—';
    })
    .catch(() => { $('env-info').textContent = '(env unavailable)'; });

  // ── Tab navigation ───────────────────────────────
  $$('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  function switchTab(name) {
    if (name === activeTab) return;
    // cleanup 舊 tab
    cleanupTab(activeTab);

    activeTab = name;
    $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab-content').forEach((s) => s.classList.toggle('active', s.dataset.tab === name));

    if (!initialized.has(name)) {
      initialized.add(name);
      initTab(name);
    } else {
      // 第二次以後切回也允許自動 refresh（除了 polling tab，由 init 重啟）
      if (name === 'counters') startPolling();
    }
  }

  function initTab(name) {
    switch (name) {
      case 'counters':  return startPolling();
      case 'history':   return refreshHistory();
      case 'heatmap':   return refreshHeatmap();
      case 'apps':      return refreshApps();
      case 'fire':      return refreshRules();
      case 'danger':    return; // 無資料需 fetch
    }
  }

  function cleanupTab(name) {
    if (name === 'counters') stopPolling();
  }

  // ── Tab 1：即時計數器 ─────────────────────────────
  function startPolling() {
    if (pollHandle) return;
    refreshCounters();
    pollHandle = setInterval(refreshCounters, 1000);
  }
  function stopPolling() {
    if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
  }
  async function refreshCounters() {
    try {
      const [counters, ctxState, plugins] = await Promise.all([
        window.debugApi.countersGet(),
        window.debugApi.contextStateGet(),
        window.debugApi.pluginsStatus(),
      ]);
      renderInputCounters(counters);
      renderContextState(ctxState);
      renderPluginsStatus(plugins);
    } catch (err) {
      console.warn('[debug] refreshCounters failed:', err);
    }
  }

  function renderInputCounters(c) {
    const el = $('counters-input');
    if (!c) { el.innerHTML = '<div class="kv-empty">(InputMonitor 未啟用)</div>'; return; }
    const rows = [
      ['clicks_total', c.clicks_total ?? 0],
      ['keys_total', c.keys_total ?? 0],
      ['typing_bursts_total', c.typing_bursts_total ?? 0],
      ['mouse_distance_total_px', Math.round(c.mouse_distance_total_px ?? 0)],
      ['mouse_active_ms', Math.round(c.mouse_active_ms ?? 0)],
      ['idle_sec', c.idle_sec ?? 0],
      ['session_sec', c.session_sec ?? 0],
      ['is_idle', boolBadge(c.is_idle)],
      ['is_typing', boolBadge(c.is_typing)],
      ['is_typing_intense', boolBadge(c.is_typing_intense)],
      ['last_input_at', c.last_input_at ? relTime(c.last_input_at) : '—'],
    ];
    el.innerHTML = rows.map(([k, v]) =>
      `<div class="kv-row"><span class="kv-key">${escapeHtml(String(k))}</span><span class="kv-val">${v}</span></div>`
    ).join('');
  }

  function renderContextState(state) {
    const el = $('counters-context');
    const entries = state ? Object.entries(state) : [];
    if (entries.length === 0) {
      el.innerHTML = '<div class="kv-empty">(無 state 資料)</div>';
      return;
    }
    el.innerHTML = entries.map(([name, s]) => {
      const conf = Math.max(0, Math.min(1, s?.confidence ?? 0));
      const valueClass = s?.value === null || s?.value === undefined
        ? 'state-value-null'
        : (s.value === true ? 'state-value-true' : 'state-value-false');
      const valueText = s?.value === null || s?.value === undefined
        ? `null (${escapeHtml(s?.reason || 'n/a')})`
        : String(s.value);
      const sources = (s?.sources || []).join(', ') || '—';
      return `
        <div class="state-row">
          <span class="state-name">${escapeHtml(name)}</span>
          <span class="${valueClass}">${escapeHtml(valueText)}</span>
          <span class="state-meta">conf ${conf.toFixed(2)} · src ${escapeHtml(sources)}</span>
          <div class="confidence-bar"><div class="confidence-bar-fill" style="width:${(conf * 100).toFixed(0)}%"></div></div>
        </div>
      `;
    }).join('');
  }

  function renderPluginsStatus(plugins) {
    const el = $('counters-plugins');
    const entries = plugins ? Object.entries(plugins) : [];
    if (entries.length === 0) {
      el.innerHTML = '<div class="kv-empty">(無 plugin 啟動)</div>';
      return;
    }
    el.innerHTML = entries.map(([id, st]) => {
      let cls = 'disabled';
      if (st?.healthy === true) cls = 'healthy';
      else if (st?.healthy === false && st?.enabled) cls = 'failed';
      else if (st?.degraded) cls = 'degraded';
      const lastHb = st?.lastHeartbeat || st?.last_heartbeat;
      const meta = lastHb ? relTime(lastHb) : (st?.enabled === false ? 'disabled' : '—');
      return `
        <div class="plugin-row">
          <span class="plugin-light ${cls}" title="${cls}"></span>
          <span class="plugin-id">${escapeHtml(id)}</span>
          <span class="plugin-meta">${escapeHtml(meta)}</span>
        </div>
      `;
    }).join('');
  }

  // ── Tab 2：觸發紀錄 ──────────────────────────────
  $('history-refresh').addEventListener('click', refreshHistory);
  async function refreshHistory() {
    const tbody = $('history-tbody');
    tbody.innerHTML = '<tr><td colspan="5" class="empty">載入中…</td></tr>';
    try {
      const list = await window.debugApi.triggerHistory(50);
      $('history-meta').textContent = `共 ${list.length} 筆（最多 50）`;
      if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty">（過去 7 天無 trigger:fired 記錄）</td></tr>';
        return;
      }
      tbody.innerHTML = list.map((e) => `
        <tr>
          <td>${escapeHtml(fmtTime(e.t || e.fired_at || 0))}</td>
          <td>${escapeHtml(e.category || '—')}</td>
          <td>${escapeHtml(e.rule_name || '—')}</td>
          <td>${escapeHtml(e.persona || '—')}</td>
          <td>${escapeHtml(e.sequence_id || '—')}</td>
        </tr>
      `).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty">載入失敗：${escapeHtml(err.message || String(err))}</td></tr>`;
    }
  }

  // ── Tab 3：時段熱力 ──────────────────────────────
  $('heatmap-refresh').addEventListener('click', refreshHeatmap);
  async function refreshHeatmap() {
    const grid = $('heatmap-grid');
    grid.innerHTML = '<div class="kv-empty" style="grid-column:1/-1;padding:24px 0;">載入中…</div>';
    try {
      const data = await window.debugApi.heatmap({ days: 7 });
      $('heatmap-meta').textContent = data?.total_days
        ? `${data.total_days} 天資料 · max=${data.max_value}`
        : '無資料';
      renderHeatmap(data?.matrix || zeroMatrix(), data?.max_value || 0);
    } catch (err) {
      grid.innerHTML = `<div class="kv-empty" style="grid-column:1/-1;padding:24px 0;color:var(--danger)">載入失敗：${escapeHtml(err.message || String(err))}</div>`;
    }
  }
  function zeroMatrix() {
    return Array.from({ length: 7 }, () => Array(24).fill(0));
  }
  function renderHeatmap(matrix, maxVal) {
    const grid = $('heatmap-grid');
    const parts = [];
    // 第 0 列：左上空、24 個 hour label
    parts.push(`<div class="corner"></div>`);
    for (let h = 0; h < 24; h++) {
      parts.push(`<div class="col-label">${h}</div>`);
    }
    // 7 列：weekday label + 24 cells
    for (let d = 0; d < 7; d++) {
      parts.push(`<div class="row-label">${DAY_LABELS[d]}</div>`);
      for (let h = 0; h < 24; h++) {
        const v = matrix[d]?.[h] || 0;
        const ratio = maxVal > 0 ? Math.min(1, v / maxVal) : 0;
        // lightness 95% → 30%（淺到深）
        const lightness = (95 - ratio * 65).toFixed(0);
        const tip = `${DAY_LABELS[d]} ${String(h).padStart(2, '0')}:00 — ${v.toLocaleString()} 活動量`;
        parts.push(`<div class="heatmap-cell" style="background:hsl(var(--heat-hue), var(--heat-sat), ${lightness}%)" title="${escapeHtml(tip)}"></div>`);
      }
    }
    grid.innerHTML = parts.join('');
  }

  // ── Tab 4：應用 Top-10 ───────────────────────────
  $('apps-refresh').addEventListener('click', refreshApps);
  $$('input[name="apps-range"]').forEach((r) => r.addEventListener('change', refreshApps));
  async function refreshApps() {
    const days = parseInt(getRadioValue('apps-range'), 10) || 7;
    const container = $('apps-bars');
    container.innerHTML = '<div class="empty">載入中…</div>';
    try {
      const data = await window.debugApi.appUsage({ days });
      $('apps-meta').textContent = data?.total_ms
        ? `總前景時間 ${formatHours(data.total_ms)} · ${data.apps?.length || 0} 個應用`
        : '無資料';
      renderApps(data?.apps || [], data?.total_ms || 0);
    } catch (err) {
      container.innerHTML = `<div class="empty" style="color:var(--danger)">載入失敗：${escapeHtml(err.message || String(err))}</div>`;
    }
  }
  function renderApps(apps, totalMs) {
    const container = $('apps-bars');
    if (!apps.length) {
      container.innerHTML = '<div class="empty">（指定區間無 fg_app_ms 資料）</div>';
      return;
    }
    const maxMs = apps[0].total_ms || 1;
    container.innerHTML = apps.map((a) => {
      const widthPct = ((a.total_ms / maxMs) * 100).toFixed(1);
      const sharePct = totalMs > 0 ? ((a.total_ms / totalMs) * 100).toFixed(1) : '0';
      return `
        <div class="bar-row">
          <span class="bar-name" title="${escapeHtml(a.exe)}">${escapeHtml(a.exe)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${widthPct}%"></div></div>
          <span class="bar-meta">${formatHours(a.total_ms)} · ${sharePct}%</span>
        </div>
      `;
    }).join('');
  }

  // ── Tab 5：手動觸發 ──────────────────────────────
  $('fire-refresh').addEventListener('click', refreshRules);
  async function refreshRules() {
    const tbody = $('fire-tbody');
    tbody.innerHTML = '<tr><td colspan="5" class="empty">載入中…</td></tr>';
    try {
      const rules = await window.debugApi.rulesStatus();
      const enabled = rules.filter((r) => r.enabled).length;
      $('fire-meta').textContent = `${rules.length} 條規則，${enabled} 條 enabled`;
      if (!rules.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty">（未載入任何規則）</td></tr>';
        return;
      }
      tbody.innerHTML = rules.map((r) => {
        const cls = r.enabled ? '' : 'disabled';
        const status = r.enabled
          ? `<span class="rule-status"><span class="dot"></span>enabled</span>`
          : `<span class="rule-status"><span class="dot"></span>disabled</span><div class="rule-missing">missing: ${escapeHtml((r.missing_capabilities || []).join(', ') || 'unknown')}</div>`;
        const last = r.last_fired_at ? relTime(r.last_fired_at) : '—';
        const btnAttr = r.enabled ? '' : 'disabled';
        return `
          <tr class="${cls}">
            <td>${escapeHtml(r.name)}</td>
            <td>${escapeHtml(r.category || '—')}</td>
            <td>${status}</td>
            <td>${escapeHtml(last)}</td>
            <td class="col-action">
              <button type="button" class="btn fire-btn" data-rule="${escapeHtml(r.name)}" ${btnAttr}>觸發</button>
            </td>
          </tr>
        `;
      }).join('');
      // 綁 click
      $$('.fire-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const rule = btn.dataset.rule;
          window.debugApi.fire(rule);
          setFooterStatus(`已觸發：${rule}`);
          // 短延遲後 refresh 顯示 last_fired_at
          setTimeout(refreshRules, 400);
        });
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty">載入失敗：${escapeHtml(err.message || String(err))}</td></tr>`;
    }
  }

  // ── Tab 6：危險操作 ──────────────────────────────
  $('danger-reset-cooldowns').addEventListener('click', () => {
    window.debugApi.resetCooldowns();
    showDangerStatus('已送出 reset-cooldowns', 'ok');
  });
  $('danger-flush-events').addEventListener('click', async () => {
    try {
      await window.debugApi.flushEvents();
      showDangerStatus('events 已 flush', 'ok');
    } catch (err) {
      showDangerStatus(`flush 失敗：${err.message || err}`, 'error');
    }
  });
  $('danger-purge-events').addEventListener('click', async () => {
    if (!window.confirm('確定要清空所有 events / 今日 stats？此操作不可逆，rollups 不受影響。')) return;
    try {
      await window.debugApi.purgeEvents();
      showDangerStatus('events 已清空', 'ok');
    } catch (err) {
      showDangerStatus(`清空失敗：${err.message || err}`, 'error');
    }
  });
  function showDangerStatus(msg, kind) {
    const el = $('danger-status');
    el.textContent = `[${new Date().toLocaleTimeString('zh-Hant', { hour12: false })}] ${msg}`;
    el.className = `action-status ${kind || ''}`;
  }

  // ── Footer / close ───────────────────────────────
  $('close-btn').addEventListener('click', () => window.debugApi.close());
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.debugApi.close();
  });
  function setFooterStatus(msg) {
    $('footer-status').textContent = msg;
    setTimeout(() => { $('footer-status').textContent = '就緒'; }, 2500);
  }

  // ── Helpers ───────────────────────────────────────
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[m]);
  }
  function relTime(ms) {
    if (!ms) return '—';
    const diff = Date.now() - ms;
    if (diff < 0) return '即將';
    if (diff < 1000) return '剛剛';
    if (diff < 60_000) return `${Math.round(diff / 1000)}秒前`;
    if (diff < 3600_000) return `${Math.round(diff / 60_000)}分前`;
    if (diff < 86400_000) return `${Math.round(diff / 3600_000)}小時前`;
    return `${Math.round(diff / 86400_000)}天前`;
  }
  function boolBadge(v) {
    if (v === true) return '<span style="color:var(--ok);font-weight:600">true</span>';
    if (v === false) return '<span style="color:var(--fg-muted)">false</span>';
    return '<span style="color:var(--warn)">—</span>';
  }
  function getRadioValue(name) {
    const r = document.querySelector(`input[name="${name}"]:checked`);
    return r ? r.value : null;
  }
  function formatHours(ms) {
    const h = ms / 3_600_000;
    if (h >= 10) return `${h.toFixed(0)}h`;
    if (h >= 1) return `${h.toFixed(1)}h`;
    const m = ms / 60_000;
    return `${m.toFixed(0)}m`;
  }

  // ── 初始化第一個 tab ─────────────────────────────
  initTab(activeTab);
  initialized.add(activeTab);
})();
