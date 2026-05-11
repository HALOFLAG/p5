// wipe-all-content.js
//
// 清除：
//   - personas/<id>/voices/<lang>/*.wav + manifest.json
//   - personas/<id>/voices-time/<lang>/*.wav + manifest.json
//   - personas/<id>/dialogues.json 內所有 sequences（保 category structure）
//   - personas/<id>/dialogues-initial.json 同上
//
// 備份：所有刪掉的東西先複製到 personas/<id>/_wipe-all-<timestamp>/
//
// 用途：persona pack 重構前的乾淨化
//
// 用法：
//   node scripts/wipe-all-content.js [--dry-run]

'use strict';

const fs = require('fs');
const path = require('path');

const PERSONAS_DIR = path.join(__dirname, '..', 'personas');
const PERSONAS = ['haiyin', 'liss'];
const DIALOGUE_FILES = ['dialogues.json', 'dialogues-initial.json'];

const dryRun = process.argv.includes('--dry-run');

function rmRf(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

function moveIfExists(from, to) {
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  return true;
}

function countWavs(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).length;
}

function wipeFile(filePath) {
  if (!fs.existsSync(filePath)) return { skipped: true };
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  let totalSeq = 0;
  for (const cat of Object.values(data.categories || {})) {
    totalSeq += Array.isArray(cat.sequences) ? cat.sequences.length : 0;
    cat.sequences = [];
  }
  if (!dryRun) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  }
  return { totalSeq };
}

console.log('=== Wipe all content（persona pack 重構前）===');
if (dryRun) console.log('[DRY RUN] — 不會動到檔案\n');

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

for (const personaId of PERSONAS) {
  console.log(`\n[${personaId}]`);
  const personaDir = path.join(PERSONAS_DIR, personaId);
  const backupDir = path.join(personaDir, `_wipe-all-${timestamp}`);

  // 1. Voices — 整個 voices/ + voices-time/ 移到 backup
  for (const sub of ['voices', 'voices-time']) {
    const subDir = path.join(personaDir, sub);
    if (!fs.existsSync(subDir)) {
      console.log(`  [skip] ${sub}/ 不存在`);
      continue;
    }
    let totalWavs = 0;
    for (const lang of fs.readdirSync(subDir)) {
      const langDir = path.join(subDir, lang);
      if (!fs.statSync(langDir).isDirectory()) continue;
      const n = countWavs(langDir);
      totalWavs += n;
      console.log(`  ${sub}/${lang}: ${n} 個 wav`);
    }
    if (!dryRun && totalWavs > 0) {
      const target = path.join(backupDir, sub);
      moveIfExists(subDir, target);
      console.log(`  [moved] ${sub}/ → backup ${path.relative(personaDir, target)}`);
    } else if (!dryRun) {
      // 空資料夾也清掉重建
      rmRf(subDir);
    }
  }

  // 2. Dialogues — sequences 清空（保 category structure），備份原檔
  for (const fname of DIALOGUE_FILES) {
    const fpath = path.join(personaDir, fname);
    if (!fs.existsSync(fpath)) {
      console.log(`  [skip] ${fname} 不存在`);
      continue;
    }
    if (!dryRun) {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.copyFileSync(fpath, path.join(backupDir, fname));
    }
    const result = wipeFile(fpath);
    console.log(`  [${dryRun ? 'dry' : 'wiped'}] ${fname} ← 清掉 ${result.totalSeq} 句`);
  }

  if (!dryRun) {
    if (fs.existsSync(backupDir)) {
      console.log(`  backup → ${path.relative(process.cwd(), backupDir)}`);
    }
  }
}

console.log('\n=== Done ===');
if (dryRun) {
  console.log('\n預演完成，移除 --dry-run 後執行真正清除。');
}
