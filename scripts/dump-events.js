#!/usr/bin/env node
// dump-events.js — 把 events JSONL 轉成人類可讀時序日誌
//
// 用法：
//   node scripts/dump-events.js                          # 今天全部
//   node scripts/dump-events.js 2026-05-08               # 指定日期
//   node scripts/dump-events.js --tail 50                # 最後 50 筆
//   node scripts/dump-events.js --since 30m              # 過去 30 分鐘（30m / 2h / 1d）
//   node scripts/dump-events.js --types trigger:fired,clipboard:changed
//   node scripts/dump-events.js --summary                # 統計總覽
//   node scripts/dump-events.js --raw                    # 不轉譯，保留 JSON
//   node scripts/dump-events.js --file <path>.jsonl(.gz) # 直接讀檔

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const EVENTS_DIR = path.join(PROJECT_ROOT, 'data', 'events');

// ─── 解析參數 ─────────────────────────────────────────────
const args = process.argv.slice(2);
const opts = {
  date: null,
  file: null,
  tail: null,
  since: null,
  types: null,
  summary: false,
  raw: false,
};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--summary') opts.summary = true;
  else if (a === '--raw') opts.raw = true;
  else if (a === '--tail') opts.tail = parseInt(args[++i], 10);
  else if (a === '--since') opts.since = parseSince(args[++i]);
  else if (a === '--types') opts.types = new Set(args[++i].split(','));
  else if (a === '--file') opts.file = args[++i];
  else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) opts.date = a;
  else if (a === '-h' || a === '--help') { showHelp(); process.exit(0); }
}

main().catch((err) => {
  console.error('dump-events failed:', err.message);
  process.exit(1);
});

async function main() {
  const filePath = opts.file || resolveTargetFile(opts.date);
  const events = await readEventsFile(filePath);

  let filtered = events;
  if (opts.since != null) {
    const cutoff = Date.now() - opts.since;
    filtered = filtered.filter((e) => e.t >= cutoff);
  }
  if (opts.types) {
    filtered = filtered.filter((e) => opts.types.has(e.type));
  }
  if (opts.tail) {
    filtered = filtered.slice(-opts.tail);
  }

  if (opts.summary) {
    showSummary(filtered, filePath);
  } else if (opts.raw) {
    for (const e of filtered) console.log(JSON.stringify(e));
  } else {
    showTimeline(filtered);
  }
}

// ─── 讀檔 ─────────────────────────────────────────────────
function resolveTargetFile(date) {
  const d = date || new Date().toISOString().slice(0, 10);
  const jsonl = path.join(EVENTS_DIR, `${d}.jsonl`);
  const gz = path.join(EVENTS_DIR, `${d}.jsonl.gz`);
  if (fs.existsSync(jsonl)) return jsonl;
  if (fs.existsSync(gz)) return gz;
  throw new Error(`no events file for ${d} (looked for ${jsonl})`);
}

async function readEventsFile(filePath) {
  const buf = await fs.promises.readFile(filePath);
  const text = filePath.endsWith('.gz') ? zlib.gunzipSync(buf).toString('utf-8') : buf.toString('utf-8');
  const events = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { events.push(JSON.parse(line)); } catch (_e) { /* skip malformed */ }
  }
  return events;
}

// ─── 時序日誌 ─────────────────────────────────────────────
function showTimeline(events) {
  if (events.length === 0) {
    console.log('(no events match)');
    return;
  }
  for (const e of events) {
    console.log(formatEvent(e));
  }
}

function formatEvent(e) {
  const ts = formatTime(e.t);
  const desc = describe(e);
  return `[${ts}] ${desc}`;
}

function describe(e) {
  switch (e.type) {
    case 'typing-burst':
      return `⌨ 打字 ${e.key_count} 鍵 / ${ms(e.duration_ms)}（修飾 ${pct(e.modifier_ratio)}, Backspace ${pct(e.backspace_ratio)}）`;
    case 'mouse-burst':
      return `🖱 滑鼠 ${e.distance_px}px / 活動 ${ms(e.active_ms)} / 最快 ${e.max_speed_px_per_sec}px/s`;
    case 'click':
      return `👆 點擊（${e.button}）`;
    case 'click-burst':
      return `👆 click-burst：${e.count} 次（左 ${e.by_button.left} / 右 ${e.by_button.right}）/ ${ms(e.duration_ms)}`;
    case 'idle-start':
      return `💤 idle 開始`;
    case 'idle-end':
      return `🌅 idle 結束（持續 ${ms(e.duration_ms)}）`;
    case 'power:lock':       return `🔒 鎖屏`;
    case 'power:unlock':     return `🔓 解鎖`;
    case 'power:sleep':      return `🌙 系統睡眠`;
    case 'power:resume':     return `🌅 系統喚醒`;
    case 'power:ac':         return `🔌 接電源`;
    case 'power:battery':    return `🔋 用電池`;
    case 'screen:added':     return `🖥 螢幕加入：id=${e.display?.id}`;
    case 'screen:removed':   return `🖥 螢幕移除：id=${e.display?.id}`;
    case 'screen:metrics-changed':
      return `🖥 螢幕設定變化（${(e.changedMetrics || []).join(',')})`;
    case 'theme:dark-mode-changed':
      return `🌓 深色模式：${e.isDark ? '開' : '關'}`;
    case 'window:focus-changed':
      return `🪟 視窗焦點：${e.app || '?'}　「${e.title || ''}」`;
    case 'fullscreen:state':
      return e.active
        ? `⛶ 全螢幕開始（${e.app}, conf=${e.confidence}）`
        : `⛶ 全螢幕結束（持續 ${ms(e.duration_ms)}, conf=${e.confidence}）`;
    case 'system:stats-tick':
      return `📊 CPU ${pad(e.cpu_pct)}% / GPU ${pad(e.gpu_pct)}% / RAM ${pad(e.ram_pct)}%`;
    case 'audio:session-started':
      return `🔊 audio session 開始：${e.exe}`;
    case 'audio:session-ended':
      return `🔇 audio session 結束：${e.exe}（持續 ${ms(e.duration_ms)}）`;
    case 'mic:recent-access-by':
      return `🎤 麥克風使用：${e.exe}`;
    case 'mic:released-by':
      return `🎤 麥克風釋放：${e.exe}`;
    case 'cam:recent-access-by':
      return `📷 相機使用：${e.exe}`;
    case 'cam:released-by':
      return `📷 相機釋放：${e.exe}`;
    case 'clipboard:changed': {
      const flags = [
        e.has_url ? 'URL' : null,
        e.has_email_pattern ? 'email' : null,
      ].filter(Boolean).join('+') || '純文字';
      return `📋 剪貼簿變動：${e.length} 字元 / ${flags} / hash=${(e.hash || '').slice(0, 7)}`;
    }
    case 'trigger:fired':
      return `🎯 觸發 ${e.rule_name} (cat=${e.category}) → ${e.sequence_id} [${e.persona}]`;
    case 'plugin:degraded':
      return `⚠ plugin 降級：${e.plugin}（${e.reason}）${e.error ? ` — ${e.error}` : ''}`;
    default:
      return `❓ ${e.type}　${JSON.stringify(omit(e, ['type', 't', 'source_plugin']))}`;
  }
}

// ─── 統計總覽 ─────────────────────────────────────────────
function showSummary(events, filePath) {
  if (events.length === 0) { console.log('(no events)'); return; }

  const byType = new Map();
  let firstT = Infinity, lastT = -Infinity;
  for (const e of events) {
    byType.set(e.type, (byType.get(e.type) || 0) + 1);
    if (e.t < firstT) firstT = e.t;
    if (e.t > lastT) lastT = e.t;
  }

  const fileSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  const span = lastT - firstT;

  console.log(`\n=== events 總覽 ===`);
  console.log(`檔案：${path.relative(PROJECT_ROOT, filePath)}（${formatBytes(fileSize)}）`);
  console.log(`筆數：${events.length}`);
  console.log(`區間：${formatTime(firstT)} ~ ${formatTime(lastT)}（${ms(span)}）`);
  console.log();
  console.log(`類型分布：`);
  const sorted = [...byType.entries()].sort((a, b) => b[1] - a[1]);
  const maxCount = sorted[0][1];
  for (const [type, count] of sorted) {
    const bar = '▇'.repeat(Math.max(1, Math.round((count / maxCount) * 30)));
    console.log(`  ${type.padEnd(28)} ${String(count).padStart(5)}  ${bar}`);
  }

  // 觸發摘要
  const fires = events.filter((e) => e.type === 'trigger:fired');
  if (fires.length > 0) {
    console.log(`\n觸發明細（${fires.length} 次）：`);
    const byRule = new Map();
    for (const f of fires) {
      const k = `${f.rule_name} (${f.category})`;
      byRule.set(k, (byRule.get(k) || 0) + 1);
    }
    for (const [rule, count] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${rule.padEnd(32)} ${count}`);
    }
  }

  // 應用焦點 top 5
  const focuses = events.filter((e) => e.type === 'window:focus-changed');
  if (focuses.length > 0) {
    console.log(`\n前景應用 top 10（${focuses.length} 次切換）：`);
    const byApp = new Map();
    for (const f of focuses) byApp.set(f.app, (byApp.get(f.app) || 0) + 1);
    for (const [app, count] of [...byApp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`  ${(app || '(unknown)').padEnd(28)} ${count}`);
    }
  }

  // 鍵滑活動
  const typing = events.filter((e) => e.type === 'typing-burst');
  const clicks = events.filter((e) => e.type === 'click');
  if (typing.length > 0 || clicks.length > 0) {
    const totalKeys = typing.reduce((s, e) => s + (e.key_count || 0), 0);
    console.log(`\n活動：${totalKeys} 鍵（${typing.length} burst） / ${clicks.length} 點擊`);
    if (typing.length > 0) {
      const avgMod = typing.reduce((s, e) => s + (e.modifier_ratio || 0), 0) / typing.length;
      const avgBs = typing.reduce((s, e) => s + (e.backspace_ratio || 0), 0) / typing.length;
      console.log(`  平均修飾鍵比：${pct(avgMod)} / 平均 Backspace 比：${pct(avgBs)}`);
    }
  }

  console.log();
}

// ─── 工具函式 ─────────────────────────────────────────────
function formatTime(t) {
  const d = new Date(t);
  const HH = String(d.getHours()).padStart(2, '0');
  const MM = String(d.getMinutes()).padStart(2, '0');
  const SS = String(d.getSeconds()).padStart(2, '0');
  const MS = String(d.getMilliseconds()).padStart(3, '0');
  return `${HH}:${MM}:${SS}.${MS}`;
}

function ms(v) {
  if (v == null) return '?';
  if (v < 1000) return `${v}ms`;
  if (v < 60000) return `${(v / 1000).toFixed(1)}s`;
  if (v < 3600000) return `${(v / 60000).toFixed(1)}m`;
  return `${(v / 3600000).toFixed(1)}h`;
}

function pct(v) {
  if (v == null) return '?';
  return `${Math.round(v * 100)}%`;
}

function pad(v) {
  if (v == null) return ' n/a';
  return String(v).padStart(4);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function parseSince(s) {
  if (!s) return null;
  const m = s.match(/^(\d+)([smhd])$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
  return n * unit;
}

function omit(obj, keys) {
  const r = {};
  for (const k of Object.keys(obj)) if (!keys.includes(k)) r[k] = obj[k];
  return r;
}

function showHelp() {
  console.log(`dump-events.js — events JSONL 人類可讀轉譯

用法：
  node scripts/dump-events.js [date]      # 預設今天，可傳 YYYY-MM-DD
  --tail N                                # 最後 N 筆
  --since 30m | 2h | 1d                   # 過去 N 分鐘/小時/天
  --types t1,t2,...                       # 只看指定類型（逗號分隔）
  --summary                               # 統計總覽（類型分布 / 觸發 / 前景 app）
  --raw                                   # 保留 JSON 不轉譯
  --file <path>                           # 直接讀指定檔（含 .gz）

範例：
  node scripts/dump-events.js --tail 30
  node scripts/dump-events.js --since 5m --types trigger:fired
  node scripts/dump-events.js 2026-05-08 --summary
`);
}
