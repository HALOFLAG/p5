#!/usr/bin/env node
// build-rollup.js — 對既有 events JSONL 做 retroactive hourly rollup
//
// 用法：
//   node scripts/build-rollup.js                          # 處理所有現存 events 檔
//   node scripts/build-rollup.js 2026-05-08               # 只處理指定日期
//   node scripts/build-rollup.js --range 2026-04-01 2026-05-09
//   node scripts/build-rollup.js --print                  # 處理後印出統計
//   node scripts/build-rollup.js --dry-run                # 不寫檔，只預覽
//
// 輸出：data/rollups/<YYYY-MM-DD>.jsonl
//   每小時一行 hourly-rollup（沒事件的 hour 跳過）

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const EVENTS_DIR = path.join(PROJECT_ROOT, 'data', 'events');
const ROLLUPS_DIR = path.join(PROJECT_ROOT, 'data', 'rollups');

const { RollupAggregator } = require(path.join(PROJECT_ROOT, 'src', 'main', 'rollup-aggregator'));

// ─── 解析參數 ─────────────────────────────────────────────
const args = process.argv.slice(2);
const opts = {
  date: null,
  rangeFrom: null,
  rangeTo: null,
  print: false,
  dryRun: false,
};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--print') opts.print = true;
  else if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--range') {
    opts.rangeFrom = args[++i];
    opts.rangeTo = args[++i];
  }
  else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) opts.date = a;
  else if (a === '-h' || a === '--help') { showHelp(); process.exit(0); }
}

main().catch((err) => {
  console.error('build-rollup failed:', err.message);
  process.exit(1);
});

async function main() {
  const eventFiles = await discoverEventFiles();
  if (eventFiles.length === 0) {
    console.log('(no events files found)');
    return;
  }

  console.log(`Processing ${eventFiles.length} events file(s)...`);
  const allEvents = [];
  for (const f of eventFiles) {
    const events = await readEventsFile(f);
    console.log(`  ${path.basename(f)}: ${events.length} events`);
    allEvents.push(...events);
  }

  if (allEvents.length === 0) {
    console.log('(no events after parsing)');
    return;
  }

  const aggregator = new RollupAggregator({ rollupsDir: ROLLUPS_DIR });
  const rollups = aggregator.rebuild(allEvents);
  console.log(`\nGenerated ${rollups.length} hourly rollup(s).`);

  if (opts.dryRun) {
    console.log('(dry-run, no files written)');
  } else {
    await aggregator.writeRollups(rollups);
    console.log(`Written to ${path.relative(PROJECT_ROOT, ROLLUPS_DIR)}/`);
  }

  if (opts.print) {
    printRollupSummary(rollups);
  }
}

// ─── 檔案探索與讀取 ──────────────────────────────────────
async function discoverEventFiles() {
  let files;
  try {
    files = await fs.promises.readdir(EVENTS_DIR);
  } catch (_e) {
    return [];
  }

  const matched = files
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(f))
    .filter((f) => filterByOpts(f))
    .sort();

  return matched.map((f) => path.join(EVENTS_DIR, f));
}

function filterByOpts(file) {
  const date = file.slice(0, 10);
  if (opts.date) return date === opts.date;
  if (opts.rangeFrom && opts.rangeTo) {
    return date >= opts.rangeFrom && date <= opts.rangeTo;
  }
  return true;
}

async function readEventsFile(filePath) {
  const buf = await fs.promises.readFile(filePath);
  const text = filePath.endsWith('.gz')
    ? zlib.gunzipSync(buf).toString('utf-8')
    : buf.toString('utf-8');

  const events = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { events.push(JSON.parse(line)); } catch (_e) { /* skip */ }
  }
  return events;
}

// ─── 統計輸出 ────────────────────────────────────────────
function printRollupSummary(rollups) {
  console.log('\n=== rollup 摘要 ===');
  for (const r of rollups) {
    const fgTop = topAppByMs(r.fg_app_ms, 3);
    const triggers = Object.entries(r.trigger_count)
      .map(([k, v]) => `${k}:${v}`).join(', ') || '—';
    const ctx = formatContextMs(r);

    console.log(`\n[${r.hour_local}]`);
    console.log(`  輸入：${r.click_count} click / ${r.key_count} 鍵 (${r.typing_burst_count} burst, mod ${pct(r.modifier_ratio_avg)}, BS ${pct(r.backspace_ratio_avg)})`);
    console.log(`  滑鼠：${r.mouse_distance_total_px}px / 活動 ${msToMin(r.mouse_active_ms)}`);
    console.log(`  閒置：${r.idle_minutes}m × ${r.idle_periods}`);
    console.log(`  系統：CPU ${pct1(r.cpu_avg_pct)}%, GPU ${pct1(r.gpu_avg_pct)}%, RAM ${pct1(r.ram_avg_pct)}%`);
    console.log(`  前景 top3：${fgTop || '—'}`);
    console.log(`  狀態：fullscreen ${msToMin(r.fullscreen_ms)} / locked ${msToMin(r.screen_locked_ms)} / audio ${msToMin(r.audio_active_ms)} / mic ${msToMin(r.mic_active_ms)}`);
    if (ctx) console.log(`  情境：${ctx}`);
    console.log(`  剪貼簿：${r.clipboard_changes} 次`);
    console.log(`  觸發：${triggers}`);
  }

  // 全域 totals
  const totals = aggregateTotals(rollups);
  console.log('\n=== 累計 ===');
  console.log(`  小時數：${rollups.length}`);
  console.log(`  click ${totals.clicks} / 鍵 ${totals.keys} / 觸發 ${totals.triggers}`);
  console.log(`  fg_app top 5：${topAppByMs(totals.fg_app_ms, 5)}`);
}

function topAppByMs(map, n) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([app, ms]) => `${app} ${msToMin(ms)}`)
    .join(', ');
}

function aggregateTotals(rollups) {
  const totals = {
    clicks: 0, keys: 0, triggers: 0, fg_app_ms: {},
  };
  for (const r of rollups) {
    totals.clicks += r.click_count;
    totals.keys += r.key_count;
    for (const v of Object.values(r.trigger_count)) totals.triggers += v;
    for (const [app, ms] of Object.entries(r.fg_app_ms)) {
      totals.fg_app_ms[app] = (totals.fg_app_ms[app] || 0) + ms;
    }
  }
  return totals;
}

function formatContextMs(r) {
  const parts = [];
  if (r.in_meeting_ms > 0) parts.push(`meeting ${msToMin(r.in_meeting_ms)}`);
  if (r.in_game_ms > 0) parts.push(`game ${msToMin(r.in_game_ms)}`);
  if (r.watching_video_ms > 0) parts.push(`video ${msToMin(r.watching_video_ms)}`);
  if (r.in_ide_ms > 0) parts.push(`ide ${msToMin(r.in_ide_ms)}`);
  return parts.join(', ');
}

function msToMin(ms) {
  if (ms == null) return '?';
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function pct(v) {
  if (v == null) return '?';
  return `${Math.round(v * 100)}%`;
}

function pct1(v) {
  if (v == null) return ' n/a';
  return v.toFixed(1);
}

function showHelp() {
  console.log(`build-rollup.js — events JSONL → hourly rollup

用法：
  node scripts/build-rollup.js                          # 全部 events 檔
  node scripts/build-rollup.js 2026-05-08               # 指定日期
  node scripts/build-rollup.js --range 2026-04-01 2026-05-09
  node scripts/build-rollup.js --print                  # 寫檔 + 印摘要
  node scripts/build-rollup.js --dry-run --print        # 預覽不寫檔

輸出：data/rollups/<YYYY-MM-DD>.jsonl
`);
}
