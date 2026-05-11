#!/usr/bin/env node
// llm-fallback-builder.js — 動態組 LLM prompt 出來給使用者複製
//
// 路線：M4 Phase 4.1 — 用 LLM 生 fallback 台詞草稿，使用者篩選後合併進 dialogues.json
//
// 用法：
//   node scripts/llm-fallback-builder.js                       # 列出所有 prompt（10 份）
//   node scripts/llm-fallback-builder.js --persona haiyin      # 只海音 5 份
//   node scripts/llm-fallback-builder.js --persona liss        # 只莉絲 5 份
//   node scripts/llm-fallback-builder.js --category deep_night # 兩人格 deep_night（2 份）
//   node scripts/llm-fallback-builder.js --persona haiyin --category drag --count 50
//   node scripts/llm-fallback-builder.js --list                # 只列 prompt 標題
//
// 設計：
//   - 純 Node script
//   - prompt 組裝邏輯抽到 src/main/llm-prompt-builder.js（CLI / UI 共用）
//   - 直接 console.log 出 prompt，使用者複製貼到任意 LLM
//   - 不實際呼叫 LLM API（保留 stub 給未來整合）
//
// 文件對照：文件/M4-fallback-prompt-模板.md（人類可讀版本）

const fs = require('node:fs');
const path = require('node:path');

const { buildPrompt } = require('../src/main/llm-prompt-builder');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PERSONAS_DIR = path.join(PROJECT_ROOT, 'personas');

// ─── 解析參數 ─────────────────────────────────────────────
const args = process.argv.slice(2);
const opts = {
  persona: null,
  category: null,
  count: 30,
  list: false,
};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--persona') opts.persona = args[++i];
  else if (a === '--category') opts.category = args[++i];
  else if (a === '--count') opts.count = parseInt(args[++i], 10);
  else if (a === '--list') opts.list = true;
  else if (a === '-h' || a === '--help') {
    console.log(usageText());
    process.exit(0);
  }
}

// ─── 主流程 ──────────────────────────────────────────────
const personas = ['haiyin', 'liss'];
const categories = [
  'click_too_much',
  'long_idle',
  'continuous_use',
  'deep_night',
  'drag',
  'hourly_chime',
];

const targets = [];
for (const pid of personas) {
  if (opts.persona && opts.persona !== pid) continue;
  for (const cat of categories) {
    if (opts.category && opts.category !== cat) continue;
    targets.push({ pid, cat });
  }
}

if (targets.length === 0) {
  console.error('[!] 沒有匹配的 persona / category 組合');
  console.error(usageText());
  process.exit(1);
}

const personaCache = {};
const initialCache = {};
for (const pid of new Set(targets.map((t) => t.pid))) {
  personaCache[pid] = loadPersona(pid);
  initialCache[pid] = loadDialoguesInitial(pid);
}

if (opts.list) {
  console.log('');
  console.log('可用 prompt（10 份）：');
  console.log('');
  for (let i = 0; i < targets.length; i++) {
    const { pid, cat } = targets[i];
    const persona = personaCache[pid];
    const guide = persona.trigger_voice_guide?.[cat] || '';
    console.log(`  [${String(i + 1).padStart(2)}] ${pid.padEnd(7)} / ${cat.padEnd(16)} ${guide.slice(0, 30)}${guide.length > 30 ? '⋯' : ''}`);
    console.log(`       node scripts/llm-fallback-builder.js --persona ${pid} --category ${cat}`);
    console.log('');
  }
  console.log('─'.repeat(70));
  console.log('要看 prompt 完整內容：去掉 --list 跑（會輸出所有 10 份）');
  console.log('要單獨跑一份：複製上方任一行命令');
  console.log('改生成數量：加 --count 50（預設 30）');
  console.log('─'.repeat(70));
} else {
  for (let i = 0; i < targets.length; i++) {
    const { pid, cat } = targets[i];
    const persona = personaCache[pid];
    const title = `[${i + 1}/${targets.length}] ${pid} / ${cat}`;
    console.log('');
    console.log('═'.repeat(70));
    console.log(title);
    console.log('═'.repeat(70));
    console.log('');
    console.log(buildPrompt({
      persona,
      category: cat,
      count: opts.count,
      dialoguesInitial: initialCache[pid],
    }));
  }

  console.log('');
  console.log('─'.repeat(70));
  console.log(`[OK] 共 ${targets.length} 份 prompt。複製上面整段（不含分隔線）餵 LLM。`);
  console.log('整理後的草稿合併工具：scripts/csv-to-dialogues.js 或 對話庫管理視窗 Tab 「📋 批次匯入」');
  console.log('─'.repeat(70));
}

// ─── IO Helpers ─────────────────────────────────────────
function loadPersona(pid) {
  const file = path.join(PERSONAS_DIR, pid, 'persona.json');
  if (!fs.existsSync(file)) {
    console.error(`[!] 找不到 persona 檔：${file}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function loadDialoguesInitial(pid) {
  const file = path.join(PERSONAS_DIR, pid, 'dialogues-initial.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    console.error(`[!] 解析 ${file} 失敗：${err.message}`);
    return null;
  }
}

function usageText() {
  return `用法：
  node scripts/llm-fallback-builder.js                       # 列出所有 prompt（10 份）
  node scripts/llm-fallback-builder.js --persona haiyin      # 只海音 5 份
  node scripts/llm-fallback-builder.js --persona liss        # 只莉絲 5 份
  node scripts/llm-fallback-builder.js --category deep_night # 兩人格 deep_night（2 份）
  node scripts/llm-fallback-builder.js --persona haiyin --category drag --count 50
  node scripts/llm-fallback-builder.js --list                # 只列 prompt 標題

選項：
  --persona <id>      haiyin / liss
  --category <name>   click_too_much / long_idle / continuous_use / deep_night / drag
  --count <n>         每份 prompt 要求生成的句數（預設 30）
  --list              只列標題不出 body
  -h, --help          顯示此說明

提示：對話庫管理視窗 Tab「📝 LLM Prompt」可在 UI 內生成 + 一鍵複製。
`;
}
