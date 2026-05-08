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
  constructor({ inputMonitor, contextState, registry, getSettings, logger = console } = {}) {
    super();
    this._input = inputMonitor;
    this._contextState = contextState;
    this._registry = registry;
    this._getSettings = getSettings || (() => ({}));
    this._log = logger;

    this._rules = [];
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
    this._tick = setInterval(() => {
      try { this._evaluate(); } catch (err) { this._log.warn?.('[trigger] evaluate:', err); }
    }, TICK_INTERVAL_MS);
  }

  stop() {
    if (this._tick) clearInterval(this._tick);
    this._tick = null;
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

  // 事件型規則直觸（如 character:drag-start）
  handleEvent(eventName, payload) {
    const ctx = this._buildContext();
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
      // 事件型規則只透過 handleEvent 觸發，tick 不挑
      if (r.condition?.type === 'event') return false;
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
    this.emit('fire', {
      rule_name: rule.name,
      category: rule.category,
      priority: rule.priority,
      fired_at: ctx.now,
      context: {
        input: ctx.input,
        contextState: ctx.contextState,
      },
    });
  }

  _buildContext() {
    return {
      now: Date.now(),
      input: this._input?.snapshot() || {},
      contextState: this._contextState?.getState() || {},
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
    case 'weekday':
      return Array.isArray(cond.days) && cond.days.includes(new Date(ctx.now).getDay());
    case 'event':
      return false; // 由 handleEvent 直接觸發
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
      case 'context_state': {
        const caps = CONTEXT_STATE_CAPS[c.state] || [];
        for (const cap of caps) set.add(cap);
        break;
      }
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
