#!/usr/bin/env node
// csv-to-dialogues.js — 把 LLM 草稿合併進 personas/<id>/dialogues.json
//
// 支援兩種輸入：
//   - LLM 原始輸出 .txt：每行 `[type] text | expression: xxx`
//   - 結構化 .csv：persona,category,type,text,expression,interaction,auto_close_ms
//
// 用法：
//   node scripts/csv-to-dialogues.js --persona haiyin --category long_idle --input drafts/x.txt
//   node scripts/csv-to-dialogues.js --csv drafts/all-fallback.csv
//   node scripts/csv-to-dialogues.js --persona haiyin --category drag --input x.txt --replace
//   node scripts/csv-to-dialogues.js --persona haiyin --category long_idle --input x.txt \
//        --batch-tag m4-llm-batch-3
//
// 行為：
//   - 自動續編 sequenceId（haiyin_idle_004, haiyin_idle_005, ...）
//   - 預設 --append（保留舊 sequences）
//   - --replace 清空該 category 舊的（initial 鎖定句保留不動）
//   - --batch-tag 寫進 _meta.source_batch（預設 manual-edit）
//   - 寫前自動 backup 為 dialogues.json.bak.<timestamp>
//
// M4.5 重構：parser / merge 邏輯抽到 src/main/dialogues-merger.js，這裡只剩 CLI。

const path = require('node:path');
const fs = require('node:fs');
const {
  parseTxtLines,
  parseCSV,
  mergeIntoDialogues,
  loadDialogues,
  saveDialogues,
} = require('../src/main/dialogues-merger');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PERSONAS_DIR = path.join(PROJECT_ROOT, 'personas');

const args = process.argv.slice(2);
const opts = {
  persona: null,
  category: null,
  input: null,
  csv: null,
  dryRun: false,
  replace: false,
  batchTag: null,
};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--persona') opts.persona = args[++i];
  else if (a === '--category') opts.category = args[++i];
  else if (a === '--input') opts.input = args[++i];
  else if (a === '--csv') opts.csv = args[++i];
  else if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--replace') opts.replace = true;
  else if (a === '--batch-tag') opts.batchTag = args[++i];
  else if (a === '-h' || a === '--help') { showHelp(); process.exit(0); }
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
  process.exit(1);
});

async function main() {
  let entries;

  if (opts.csv) {
    const text = await fs.promises.readFile(opts.csv, 'utf-8');
    const result = parseCSV(text);
    entries = result.entries;
    console.log(`Parsed ${entries.length} entries from CSV: ${opts.csv} (skipped ${result.skipped})`);
  } else if (opts.input) {
    if (!opts.persona || !opts.category) {
      throw new Error('--input 模式必須指定 --persona 跟 --category');
    }
    const text = await fs.promises.readFile(opts.input, 'utf-8');
    const result = parseTxtLines(text, opts.persona, opts.category, {
      onWarn: (msg) => console.warn(`  [warn] ${msg}`),
    });
    entries = result.entries;
    console.log(`Parsed ${entries.length} entries from txt: ${opts.input} (valid=${result.valid} skipped=${result.skipped})`);
  } else {
    showHelp();
    throw new Error('需要 --input 或 --csv（看 --help）');
  }

  if (entries.length === 0) {
    console.log('(沒有有效的 entries 可合併)');
    return;
  }

  const batchTag = opts.batchTag || `manual-${new Date().toISOString().slice(0, 10)}`;

  // 按 persona 分組（同 persona 內多 category 合併到同一份檔）
  const byPersona = new Map();
  for (const e of entries) {
    if (!byPersona.has(e.persona)) byPersona.set(e.persona, []);
    byPersona.get(e.persona).push(e);
  }

  for (const [personaId, list] of byPersona) {
    const dialoguesPath = path.join(PERSONAS_DIR, personaId, 'dialogues.json');
    const data = await loadDialogues(dialoguesPath);
    if (!data) {
      console.warn(`  [skip] ${personaId}: ${dialoguesPath} 不存在（先跑 schema migration）`);
      continue;
    }

    console.log(`\n──── ${personaId} (${path.relative(PROJECT_ROOT, dialoguesPath)}) ────`);

    const summary = mergeIntoDialogues({
      data,
      persona: personaId,
      entries: list,
      replace: opts.replace,
      batchTag,
    });

    for (const [catName, info] of Object.entries(summary.byCategory)) {
      const action = opts.replace
        ? `REPLACE - 清掉舊的 ${info.replaced}（保留 initial）+ 新增 ${info.added}`
        : `APPEND - 新增 ${info.added}`;
      console.log(`  ${catName}: ${action}`);
      if (info.first) {
        console.log(`     新增範圍：${info.first} → ${info.last}（合計 ${info.total} 句）`);
      }
    }

    if (opts.dryRun) {
      console.log(`  [dry-run] 略過寫檔`);
      continue;
    }

    await saveDialogues(dialoguesPath, data);
    console.log(`  [wrote ] ${path.relative(PROJECT_ROOT, dialoguesPath)} (batch_tag="${batchTag}")`);
  }

  console.log('\n=== 完成 ===');
  if (opts.dryRun) console.log('(--dry-run 模式，未寫檔)');
}

function showHelp() {
  console.log(`csv-to-dialogues.js — 合併 LLM 草稿到 personas/<id>/dialogues.json

用法：
  node scripts/csv-to-dialogues.js --persona <id> --category <cat> --input <path>.txt
  node scripts/csv-to-dialogues.js --csv <path>.csv
  node scripts/csv-to-dialogues.js --csv <path>.csv --dry-run
  node scripts/csv-to-dialogues.js --persona haiyin --category drag --input x.txt --replace
  node scripts/csv-to-dialogues.js --persona haiyin --category long_idle --input x.txt --batch-tag m4-llm-batch-3

選項：
  --persona <id>       人格 id (haiyin / liss)
  --category <cat>     類別 (click_too_much / long_idle / continuous_use / deep_night / drag)
  --input <path>       LLM 原始輸出 .txt
  --csv <path>         結構化 CSV 檔案
  --replace            清空該 category 的舊 sequences（initial 鎖定句保留）
  --batch-tag <name>   寫進 _meta.source_batch（預設 manual-<日期>）
  --dry-run            不寫檔，只顯示會合併什麼
  -h, --help           顯示此說明

txt 格式（LLM 原始輸出）：
  [speech] 點什麼點呐～ | expression: pout
  [thought] （手指又在亂動了⋯⋯） | expression: annoyed
  [speech] 看看我這邊嘛 | expression: happy

CSV 格式：
  persona,category,type,text,expression,interaction,auto_close_ms
  haiyin,click_too_much,speech,點什麼點呐,pout,,
  haiyin,click_too_much,thought,（手指又在亂動）,annoyed,display,5000
  liss,long_idle,speech,主人您回來了,happy,,

行為：
  - 自動續編 sequenceId（haiyin_idle_004, haiyin_idle_005, ...）
  - 預設 --append（保留既有 sequences）
  - --replace 清空該 category 舊的（initial 鎖定句永遠保留）
  - 寫前自動 backup 為 .bak.<timestamp>
  - --dry-run 預覽合併計畫不寫檔
  - 每筆新加 sequence 自動帶 _meta（source_batch / created_at / fire_count_lifetime=0）

範例工作流：
  1. 跑 LLM 拿到 30 句草稿
  2. 篩選保留 20 句精華 → 存到 drafts/haiyin-long_idle.txt
  3. 跑 --dry-run 看效果：
     node scripts/csv-to-dialogues.js --persona haiyin --category long_idle --input drafts/haiyin-long_idle.txt --batch-tag m4-llm-batch-1 --dry-run
  4. 確認沒問題，去掉 --dry-run 正式寫入
`);
}
