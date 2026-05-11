// TriggerEngine — 行為決策層
//
// 對外契約：
//   - loadRules({ rules, dynamic_cooldown })
//   - start() / stop()
//   - emit 'fire' { rule_name, category, fired_at, context }
//   - emit 'rule:disabled' { rule_name, missing_capabilities }
//   - handleEvent(name, payload)            事件型規則直觸（如 character:drag-start）
//   - resetCooldowns()                      Debug 用
//   - getRuleStatus()                       Debug 面板用
//   - forceFire(ruleName)                   Debug 用
//
// 設計要點（plan §6）：
//   - 每秒 tick 評估規則
//   - 規則 condition 用到的 context_state 自動推導所需 capability，缺則 disabled
//   - 壓制器層（priority >= 990）先處理：suppress_all / suppress_categories / multiply_cooldown
//   - 動態冷卻：依最近 60 分鐘 trigger_fired 數調整 cooldown 倍率

const EventEmitter = require('node:events');

const TICK_INTERVAL_MS = 1000;
const SUPPRESSOR_PRIORITY = 990;
const DEFAULT_EXEMPT_PRIORITY = 100;
const DYNAMIC_WINDOW_MS = 60 * 60 * 1000;

// context_state 名稱 → 必要 capability（保守集合：缺這些一定算不出來）
const CONTEXT_STATE_CAPS = {
  in_meeting:     ['foreground_window'],
  in_game:        ['foreground_window', 'fullscreen_state'],
  watching_video: ['foreground_window'],
  in_ide:         ['foreground_window'],
  screen_locked:  ['power_state'],
  on_battery:     ['power_state'],
  dark_mode:      ['theme_state'],
  focused_work:   ['keyboard_input', 'foreground_window'],
};

class TriggerEngine extends EventEmitter {
  constructor({ inputMonitor, contextState, registry, appClassification = null, getSettings, logger = console } = {}) {
    super();
    this._input = inputMonitor;
    this._contextState = contextState;
    this._registry = registry;
    this._appClassification = appClassification || {};
    this._getSettings = getSettings || (() => ({}));
    this._log = logger;

    this._rules = [];
    // P4: 事件 ring buffer（給 event_burst / streak_threshold 用）
    // Map<eventName, Array<timestamp>>，保留 5 分鐘內紀錄
    this._eventHistory = new Map();
    this._eventHistoryRetentionMs = 5 * 60 * 1000;
    this._inputSubscriptions = [];
    // P4: state_edge 偵測 — 上一次 evaluate 時各 state 的值快照
    this._prevStateSnapshot = new Map();   // Map<stateName, value>
    this._activeRules = [];
    this._dynamicCooldown = null;
    this._lastFireByCategory = new Map();
    this._recentFires = [];
    this._tick = null;
  }

  loadRules({ rules = [], dynamic_cooldown = null } = {}) {
    this._rules = Array.isArray(rules) ? rules : [];
    this._dynamicCooldown = dynamic_cooldown;
    this._reconcileActiveRules();
  }

  start() {
    if (this._tick) return;
    this._reconcileActiveRules();
    this._subscribeInputEvents();
    this._tick = setInterval(() => {
      try { this._evaluate(); } catch (err) { this._log.warn?.('[trigger] evaluate:', err); }
    }, TICK_INTERVAL_MS);
  }

  stop() {
    if (this._tick) clearInterval(this._tick);
    this._tick = null;
    this._unsubscribeInputEvents();
  }

  // P4: 訂閱 InputMonitor 的 typing-burst / click 事件，存入 _eventHistory
  _subscribeInputEvents() {
    if (!this._input || this._inputSubscriptions.length > 0) return;
    const events = ['typing-burst', 'click'];
    for (const evt of events) {
      const handler = () => this._recordEvent(evt, Date.now());
      this._input.on(evt, handler);
      this._inputSubscriptions.push({ event: evt, handler });
    }
  }

  _unsubscribeInputEvents() {
    if (!this._input) return;
    for (const { event, handler } of this._inputSubscriptions) {
      try { this._input.off(event, handler); } catch (_e) {}
    }
    this._inputSubscriptions = [];
  }

  _recordEvent(eventName, t) {
    let arr = this._eventHistory.get(eventName);
    if (!arr) { arr = []; this._eventHistory.set(eventName, arr); }
    arr.push(t);
    // 清理過期（沿用 retention）
    const cutoff = t - this._eventHistoryRetentionMs;
    while (arr.length && arr[0] < cutoff) arr.shift();
  }

  // P4: 比對 state 跟上次 snapshot，回傳 edge map（只列有變動的 state）
  _computeStateEdges(currentState) {
    const edges = {};
    const seen = new Set();
    for (const [name, info] of Object.entries(currentState || {})) {
      const cur = info?.value ?? null;
      const prev = this._prevStateSnapshot.has(name) ? this._prevStateSnapshot.get(name) : null;
      if (cur !== prev) edges[name] = { from: prev, to: cur };
      seen.add(name);
      this._prevStateSnapshot.set(name, cur);
    }
    // 移除已不存在的 state
    for (const name of [...this._prevStateSnapshot.keys()]) {
      if (!seen.has(name)) this._prevStateSnapshot.delete(name);
    }
    return edges;
  }

  _countEventsInWindow(eventName, windowSec, now) {
    const arr = this._eventHistory.get(eventName);
    if (!arr || arr.length === 0) return 0;
    const cutoff = now - windowSec * 1000;
    let n = 0;
    // 從尾巴往前數
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] >= cutoff) n++;
      else break;
    }
    return n;
  }

  resetCooldowns() {
    this._lastFireByCategory.clear();
    this._recentFires = [];
  }

  forceFire(ruleName) {
    const rule = this._activeRules.find((r) => r.name === ruleName);
    if (!rule) return false;
    this._fire(rule, this._buildContext());
    return true;
  }

  getRuleStatus() {
    return this._rules.map((rule) => {
      const active = this._activeRules.find((r) => r.name === rule.name);
      const lastFired = this._lastFireByCategory.get(rule.category) || null;
      return {
        name: rule.name,
        category: rule.category,
        priority: rule.priority,
        enabled: !!active,
        missing_capabilities: rule._missingCaps || [],
        last_fired_at: lastFired,
      };
    });
  }

  // P4: 切前景視窗時呼叫；payload: { app, title, exe_path }
  // 對符合 classifications 的 app_focus rule 過機率 + cooldown 後 fire
  handleAppFocus(payload) {
    if (!payload) return false;
    const ctx = this._buildContext();
    const classes = this._classifyApp(payload);
    if (classes.size === 0) return false;
    let fired = false;
    for (const rule of this._activeRules) {
      const cond = rule.condition;
      if (cond?.type !== 'app_focus') continue;
      const wanted = Array.isArray(cond.classifications) ? cond.classifications : [];
      if (!wanted.some((c) => classes.has(c))) continue;
      // 機率 gate
      if (Number.isFinite(cond.probability) && cond.probability >= 0 && cond.probability < 1) {
        if (Math.random() >= cond.probability) continue;
      }
      // cooldown
      if (this._isCategoryCooldown(rule.category, ctx.now)) continue;
      this._fire(rule, ctx);
      fired = true;
      break;   // 一次切換只觸發 priority 最高的一條
    }
    return fired;
  }

  _classifyApp(payload) {
    const out = new Set();
    const exe = String(payload?.exe_path || payload?.app || '').toLowerCase();
    const title = String(payload?.title || '').toLowerCase();
    if (!exe && !title) return out;
    const baseExe = exe.includes('\\') ? exe.split('\\').pop()
                  : exe.includes('/') ? exe.split('/').pop() : exe;
    for (const [classKey, list] of Object.entries(this._appClassification || {})) {
      if (!Array.isArray(list)) continue;
      // 純字串列表
      if (list.some((entry) => typeof entry === 'string' && entry.toLowerCase() === baseExe)) {
        out.add(classKey);
      }
    }
    // 額外：video_keywords 對 title 做 contain 檢查
    const vk = this._appClassification?.video_keywords;
    if (Array.isArray(vk) && vk.some((kw) => title.includes(String(kw).toLowerCase()))) {
      out.add('video_apps');
    }
    return out;
  }

  // 事件型規則直觸（如 character:drag-start）
  handleEvent(eventName, payload) {
    const ctx = this._buildContext();
    // P4: 把 IPC-推進來的 event 也存進 history（character:click 給 streak_threshold 用）
    this._recordEvent(eventName, ctx.now);
    for (const rule of this._activeRules) {
      if (!conditionUsesEvent(rule.condition, eventName)) continue;
      if (this._isCategoryCooldown(rule.category, ctx.now)) continue;
      this._fire(rule, ctx);
      return true;
    }
    return false;
  }

  _reconcileActiveRules() {
    const activeCaps = new Set(this._registry?.getActiveCapabilities?.() || []);
    // InputMonitor 是 Tier 1 核心，沒進 registry。動態從它取 capability
    if (this._input && this._input.getStatus?.().healthy !== false) {
      for (const c of (this._input.constructor?.capabilities || [])) activeCaps.add(c);
    }

    this._activeRules = [];
    for (const rule of this._rules) {
      const required = extractRequiredCapabilities(rule.condition);
      const missing = [...required].filter((c) => !activeCaps.has(c));
      rule._missingCaps = missing;
      if (missing.length === 0) {
        this._activeRules.push(rule);
      } else {
        this._log.warn?.(
          `[trigger] rule "${rule.name}" disabled (missing: ${missing.join(', ')})`
        );
        this.emit('rule:disabled', { rule_name: rule.name, missing_capabilities: missing });
      }
    }
  }

  _evaluate() {
    if (this._isInDnd()) return;

    const ctx = this._buildContext();
    // P4: 計算這個 tick 哪些 context_state 發生 edge transition
    ctx.stateEdges = this._computeStateEdges(ctx.contextState);
    const matched = [];

    for (const rule of this._activeRules) {
      if (evaluateCondition(rule.condition, ctx)) matched.push(rule);
    }

    // 壓制器層
    let suppressAll = false;
    let suppressedCategories = new Set();
    let cooldownMultiplier = 1;
    let exemptPriorityGte = DEFAULT_EXEMPT_PRIORITY;

    for (const sup of matched.filter((r) => r.priority >= SUPPRESSOR_PRIORITY)) {
      switch (sup.action) {
        case 'suppress_all':
          suppressAll = true;
          if (sup.exempt_priority_gte != null) exemptPriorityGte = sup.exempt_priority_gte;
          break;
        case 'suppress_categories':
          for (const c of sup.categories || []) suppressedCategories.add(c);
          break;
        case 'multiply_cooldown':
          cooldownMultiplier *= sup.factor || 1;
          break;
        default:
          break;
      }
    }

    cooldownMultiplier *= this._calcDynamicMultiplier();

    const candidates = matched.filter((r) => {
      if (r.priority >= SUPPRESSOR_PRIORITY) return false;
      if (suppressAll && r.priority < exemptPriorityGte) return false;
      if (suppressedCategories.has(r.category)) return false;
      const effCdSec = (r.cooldown_sec || 0) * cooldownMultiplier;
      const lastFired = this._lastFireByCategory.get(r.category);
      if (lastFired && ctx.now - lastFired < effCdSec * 1000) return false;
      // 事件型 / app_focus 規則只透過 handleEvent / handleAppFocus 觸發，tick 不挑
      if (r.condition?.type === 'event') return false;
      if (r.condition?.type === 'app_focus') return false;
      return true;
    });

    if (candidates.length === 0) return;

    const maxPri = Math.max(...candidates.map((r) => r.priority));
    const top = candidates.filter((r) => r.priority === maxPri);
    const chosen = top[Math.floor(Math.random() * top.length)];
    this._fire(chosen, ctx);
  }

  _fire(rule, ctx) {
    this._lastFireByCategory.set(rule.category, ctx.now);
    this._recentFires.push(ctx.now);
    const cutoff = ctx.now - DYNAMIC_WINDOW_MS;
    while (this._recentFires.length && this._recentFires[0] < cutoff) {
      this._recentFires.shift();
    }
    // P5: streak_threshold fired → 清掉對應 event history（避免同 5 下又再 fire）
    if (rule.condition?.type === 'streak_threshold' && rule.condition.event) {
      this._eventHistory.delete(rule.condition.event);
    }
    this.emit('fire', {
      rule_name: rule.name,
      category: rule.category,
      priority: rule.priority,
      voice_prefix: rule.voice_prefix || null,    // P3: 給 director 組時間語音串接路徑
      fired_at: ctx.now,
      context: {
        input: ctx.input,
        contextState: ctx.contextState,
      },
    });
  }

  _buildContext() {
    const now = Date.now();
    return {
      now,
      input: this._input?.snapshot() || {},
      contextState: this._contextState?.getState() || {},
      // P4: 給 event_burst / streak_threshold condition 查 ring buffer 用
      countEvents: (eventName, windowSec) => this._countEventsInWindow(eventName, windowSec, now),
    };
  }

  _isCategoryCooldown(category, now) {
    const lastFired = this._lastFireByCategory.get(category);
    if (!lastFired) return false;
    const rule = this._activeRules.find((r) => r.category === category);
    if (!rule) return false;
    const cdMs = (rule.cooldown_sec || 0) * 1000;
    return now - lastFired < cdMs;
  }

  _calcDynamicMultiplier() {
    const cfg = this._dynamicCooldown;
    if (!cfg || !cfg.enabled) return 1;

    const now = Date.now();
    const cutoff = now - DYNAMIC_WINDOW_MS;
    while (this._recentFires.length && this._recentFires[0] < cutoff) {
      this._recentFires.shift();
    }
    const count = this._recentFires.length;

    if (count >= (cfg.high_activity_threshold ?? 8)) return cfg.high_activity_multiplier ?? 0.7;
    if (count <= (cfg.low_activity_threshold ?? 2)) return cfg.low_activity_multiplier ?? 1.5;
    return 1;
  }

  _isInDnd() {
    const settings = this._getSettings() || {};
    const dnd = settings.do_not_disturb || {};
    if (dnd.manual === true) return true;

    if (dnd.schedule_enabled && Array.isArray(dnd.schedule)) {
      const now = new Date();
      const minutes = now.getHours() * 60 + now.getMinutes();
      const day = now.getDay();
      for (const slot of dnd.schedule) {
        if (!slot?.from || !slot?.to) continue;
        if (Array.isArray(slot.days) && !slot.days.includes(day)) continue;
        const fromMin = parseHm(slot.from);
        const toMin = parseHm(slot.to);
        if (fromMin == null || toMin == null) continue;
        const inSlot = fromMin <= toMin
          ? minutes >= fromMin && minutes < toMin
          : minutes >= fromMin || minutes < toMin;
        if (inSlot) return true;
      }
    }
    return false;
  }
}

function evaluateCondition(cond, ctx) {
  if (!cond || typeof cond !== 'object') return false;
  switch (cond.type) {
    case 'counter_threshold':
      return cmp(ctx.input?.[cond.counter], cond.operator, cond.value);
    case 'idle_duration':
      return cmp(ctx.input?.idle_sec, cond.operator, cond.value_sec);
    case 'session_duration':
      return cmp(ctx.input?.session_sec, cond.operator, cond.value_sec);
    case 'time_window':
      return inTimeWindow(cond.from, cond.to, ctx.now);
    case 'time_marker': {
      // 整點 / 半點觸發：minute 等於 cond.minute（預設 0）才 true
      // 一分鐘內 evaluate 多次都會通過，靠 cooldown_sec ≥ 60 防多重 fire
      const d = new Date(ctx.now);
      const targetMinute = Number.isFinite(cond.minute) ? cond.minute : 0;
      if (d.getMinutes() !== targetMinute) return false;
      // hour_range 限制（[start, end] 包含端點），undefined = 24/7
      if (Array.isArray(cond.hour_range) && cond.hour_range.length === 2) {
        const [start, end] = cond.hour_range;
        const h = d.getHours();
        if (h < start || h > end) return false;
      }
      // P3: min_active_sec — 要求過去 N 秒內有 input 才觸發（避免空電腦觸發報時）
      if (Number.isFinite(cond.min_active_sec)) {
        const idle = ctx.input?.idle_sec;
        if (!Number.isFinite(idle) || idle > cond.min_active_sec) return false;
      }
      return true;
    }
    case 'weekday':
      return Array.isArray(cond.days) && cond.days.includes(new Date(ctx.now).getDay());
    case 'event':
      return false; // 由 handleEvent 直接觸發
    case 'random_interval': {
      // 每 tick (1s) 過機率 gate；hour_range 限制活躍時段
      // 真正節奏靠 cooldown_sec 控（cd 後再開始 random eval）
      if (Array.isArray(cond.hour_range) && cond.hour_range.length === 2) {
        const h = new Date(ctx.now).getHours();
        if (h < cond.hour_range[0] || h > cond.hour_range[1]) return false;
      }
      const p = Number.isFinite(cond.probability_per_eval) ? cond.probability_per_eval : 0;
      if (p <= 0) return false;
      return Math.random() < p;
    }
    case 'event_burst':
    case 'streak_threshold': {
      // P4 / P5: window_sec 內某 event 累計 ≥ min_count 才觸發
      // event_burst 跟 streak_threshold 邏輯相同，差別在語意（前者一般爆發、後者連續互動）
      if (typeof ctx.countEvents !== 'function') return false;
      if (!cond.event || !Number.isFinite(cond.window_sec) || !Number.isFinite(cond.min_count)) return false;
      return ctx.countEvents(cond.event, cond.window_sec) >= cond.min_count;
    }
    case 'state_edge': {
      // P4: 該 state 從 cond.from 變 cond.to 的 tick 才觸發（邊緣觸發 = 一次性）
      const edge = ctx.stateEdges?.[cond.state];
      if (!edge) return false;
      if (edge.from !== cond.from || edge.to !== cond.to) return false;
      // 可選：min_confidence 檢查當前 state 信心度
      if (Number.isFinite(cond.min_confidence)) {
        const cur = ctx.contextState?.[cond.state];
        if (!cur || (cur.confidence ?? 0) < cond.min_confidence) return false;
      }
      return true;
    }
    case 'context_state': {
      const s = ctx.contextState[cond.state];
      if (!s || s.value === null) return false;
      const minConf = cond.min_confidence ?? 0.6;
      return s.value === cond.equals && s.confidence >= minConf;
    }
    case 'env_field': {
      // M3 暫不深入支援；M4-M5 視需要實作
      return false;
    }
    case 'composite': {
      const subs = Array.isArray(cond.conditions) ? cond.conditions : [];
      if (cond.op === 'and') return subs.every((c) => evaluateCondition(c, ctx));
      if (cond.op === 'or') return subs.some((c) => evaluateCondition(c, ctx));
      if (cond.op === 'not') return subs.length > 0 && !evaluateCondition(subs[0], ctx);
      return false;
    }
    default:
      return false;
  }
}

function conditionUsesEvent(cond, eventName) {
  if (!cond || typeof cond !== 'object') return false;
  if (cond.type === 'event') return cond.event === eventName;
  if (cond.type === 'composite') {
    return (cond.conditions || []).some((c) => conditionUsesEvent(c, eventName));
  }
  return false;
}

function extractRequiredCapabilities(cond) {
  const set = new Set();
  walk(cond);
  return set;

  function walk(c) {
    if (!c || typeof c !== 'object') return;
    switch (c.type) {
      case 'counter_threshold':
        if (c.counter && c.counter.includes('click')) set.add('mouse_input');
        if (c.counter && c.counter.includes('key')) set.add('keyboard_input');
        break;
      case 'idle_duration':
        set.add('idle_detection');
        break;
      case 'session_duration':
        set.add('keyboard_input');
        break;
      case 'context_state':
      case 'state_edge': {
        const caps = CONTEXT_STATE_CAPS[c.state] || [];
        for (const cap of caps) set.add(cap);
        break;
      }
      case 'app_focus':
        set.add('foreground_window');
        break;
      case 'composite':
        for (const sub of c.conditions || []) walk(sub);
        break;
      default:
        break;
    }
  }
}

function cmp(a, op, b) {
  if (a == null || b == null) return false;
  switch (op) {
    case '>=': return a >= b;
    case '<=': return a <= b;
    case '>':  return a > b;
    case '<':  return a < b;
    case '==': return a === b;
    case '!=': return a !== b;
    default:   return false;
  }
}

function inTimeWindow(from, to, now) {
  const fromMin = parseHm(from);
  const toMin = parseHm(to);
  if (fromMin == null || toMin == null) return false;
  const d = new Date(now);
  const m = d.getHours() * 60 + d.getMinutes();
  return fromMin <= toMin
    ? m >= fromMin && m < toMin
    : m >= fromMin || m < toMin;
}

function parseHm(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

module.exports = { TriggerEngine };
