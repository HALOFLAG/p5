// wipe-dialogues-content.js
//
// 把所有 persona 的 dialogues.json + dialogues-initial.json 內所有 category
// 的 sequences 清空（category structure 保留），同時備份原檔。
//
// 用途：雙語架構翻新 — 既有內容跟新 schema 不一致，整個 wipe 從 LLM 重生。
//
// 用法：
//   node scripts/wipe-dialogues-content.js [--dry-run]
//
// Backup 寫到 personas/<id>/_wipe-backup-<timestamp>/ 下，可隨時還原。

'use strict';

const fs = require('fs');
const path = require('path');

const PERSONAS_DIR = path.join(__dirname, '..', 'personas');
const PERSONAS = ['haiyin', 'liss'];
const TARGET_FILES = ['dialogues.json', 'dialogues-initial.json'];

const dryRun = process.argv.includes('--dry-run');

function wipeFile(filePath, backupDir) {
  if (!fs.existsSync(filePath)) {
    console.log(`  [skip] ${filePath} 不存在`);
    return { skipped: true };
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const before = {};
  let totalSeq = 0;
  for (const [cat, info] of Object.entries(data.categories || {})) {
    const n = Array.isArray(info.sequences) ? info.sequences.length : 0;
    before[cat] = n;
    totalSeq += n;
  }

  // Backup
  if (!dryRun) {
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, path.basename(filePath)), JSON.stringify(data, null, 2));
  }

  // Wipe sequences but keep category structure
  for (const cat of Object.keys(data.categories || {})) {
    data.categories[cat] = { sequences: [] };
  }

  if (!dryRun) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  }

  console.log(`  [${dryRun ? 'dry-run' : 'wiped'}] ${path.basename(filePath)} — 清掉 ${totalSeq} 句（${Object.keys(before).length} category）`);
  for (const [cat, n] of Object.entries(before)) {
    if (n > 0) console.log(`    - ${cat}: ${n} 句`);
  }
  return { totalSeq, before };
}

console.log('=== Wipe dialogues content（雙語架構翻新）===');
if (dryRun) console.log('[DRY RUN] — 不會寫檔');

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

for (const personaId of PERSONAS) {
  console.log(`\n[${personaId}]`);
  const personaDir = path.join(PERSONAS_DIR, personaId);
  const backupDir = path.join(personaDir, `_wipe-backup-${timestamp}`);
  if (!dryRun) {
    console.log(`  backup → ${backupDir}`);
  }
  for (const fname of TARGET_FILES) {
    wipeFile(path.join(personaDir, fname), backupDir);
  }
}

console.log('\n=== Done ===');
if (!dryRun) {
  console.log('\n備份位置：personas/<id>/_wipe-backup-' + timestamp);
  console.log('要還原：把備份檔複製回 dialogues.json / dialogues-initial.json');
} else {
  console.log('\n預演完成，加上 --execute 才會真的清掉。實際執行：');
  console.log('  node scripts/wipe-dialogues-content.js');
}
