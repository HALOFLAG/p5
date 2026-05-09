#!/usr/bin/env node
// migrate-persona-schema-v2.js — 一次性 backfill 工具
//
// 任務：
//   1. persona.json schema v1 → v2（加 preferences / behavioral_settings / linked_states）
//   2. dialogues.json 每個 sequence 加 _meta（source_batch="initial"）
//   3. 從 dialogues.json 複製生成 dialogues-initial.json（不可變範本）
//   4. 建 voices/zh/ + voices/ja/ 資料夾（含 .gitkeep）
//
// 用法：
//   node scripts/migrate-persona-schema-v2.js              # 跑兩個 persona
//   node scripts/migrate-persona-schema-v2.js --persona haiyin
//   node scripts/migrate-persona-schema-v2.js --dry-run    # 不寫檔，只顯示會做什麼
//
// 安全：寫前自動 backup persona.json + dialogues.json 為 .bak.<timestamp>

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PERSONAS_DIR = path.join(PROJECT_ROOT, 'personas');

// ─── CLI ───────────────────────────────────────────────────
const args = process.argv.slice(2);
const opts = { persona: null, dryRun: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--persona') opts.persona = args[++i];
  else if (a === '--dry-run') opts.dryRun = true;
  else if (a === '-h' || a === '--help') { showHelp(); process.exit(0); }
}

main().catch((err) => {
  console.error('\n[ERROR]', err.message);
  process.exit(1);
});

async function main() {
  const targets = opts.persona ? [opts.persona] : await listPersonas();
  if (targets.length === 0) {
    console.log('(沒有找到 personas/ 子資料夾)');
    return;
  }

  console.log(`Migration 目標：${targets.join(', ')}`);
  if (opts.dryRun) console.log('[DRY-RUN] 不會寫檔');
  console.log();

  const migrationTimestamp = new Date().toISOString();

  for (const id of targets) {
    await migratePersona(id, migrationTimestamp);
  }

  console.log('\n=== Migration 完成 ===');
  if (opts.dryRun) console.log('[DRY-RUN] 重跑時去掉 --dry-run');
}

async function listPersonas() {
  const entries = await fs.promises.readdir(PERSONAS_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function migratePersona(id, migrationTimestamp) {
  const dir = path.join(PERSONAS_DIR, id);
  const personaPath = path.join(dir, 'persona.json');
  const dialoguesPath = path.join(dir, 'dialogues.json');
  const initialPath = path.join(dir, 'dialogues-initial.json');

  console.log(`──── ${id} ────`);

  // ── Step 1: persona.json v1 → v2 ────────────────────
  let persona;
  try {
    persona = JSON.parse(await fs.promises.readFile(personaPath, 'utf-8'));
  } catch (err) {
    console.warn(`  [skip] 讀 persona.json 失敗：${err.message}`);
    return;
  }

  const personaUpgraded = upgradePersonaSchema(persona);
  const personaChanged = JSON.stringify(persona) !== JSON.stringify(personaUpgraded);

  if (personaChanged) {
    if (!opts.dryRun) {
      await backup(personaPath);
      await fs.promises.writeFile(personaPath, JSON.stringify(personaUpgraded, null, 2) + '\n');
    }
    console.log(`  ✓ persona.json: ${persona.$schema || '(無 $schema)'} → v2 (+ preferences, behavioral_settings, linked_states)`);
  } else {
    console.log(`  • persona.json: 已是 v2，略過`);
  }

  // ── Step 2: dialogues.json 加 _meta ──────────────────
  let dialogues;
  try {
    dialogues = JSON.parse(await fs.promises.readFile(dialoguesPath, 'utf-8'));
  } catch (err) {
    console.warn(`  [skip] 讀 dialogues.json 失敗：${err.message}`);
    return;
  }

  const { upgraded: dialoguesUpgraded, addedCount } = upgradeDialoguesMeta(dialogues, migrationTimestamp);

  if (addedCount > 0) {
    if (!opts.dryRun) {
      await backup(dialoguesPath);
      await fs.promises.writeFile(dialoguesPath, JSON.stringify(dialoguesUpgraded, null, 2) + '\n');
    }
    console.log(`  ✓ dialogues.json: ${addedCount} sequences 加 _meta (source_batch="initial")`);
  } else {
    console.log(`  • dialogues.json: 全部 sequences 已有 _meta，略過`);
  }

  // ── Step 3: 生成 dialogues-initial.json ──────────────
  let initialAction;
  try {
    await fs.promises.access(initialPath);
    initialAction = 'exists';
  } catch (_e) {
    initialAction = 'create';
  }

  if (initialAction === 'create') {
    if (!opts.dryRun) {
      await fs.promises.writeFile(initialPath, JSON.stringify(dialoguesUpgraded, null, 2) + '\n');
    }
    console.log(`  ✓ dialogues-initial.json: 從 dialogues.json 複製生成（不可變範本）`);
  } else {
    console.log(`  • dialogues-initial.json: 已存在，略過（保留你的範本）`);
  }

  // ── Step 4: 建 voices/ 資料夾 ────────────────────────
  await ensureVoicesDirs(dir);
}

function upgradePersonaSchema(persona) {
  const upgraded = JSON.parse(JSON.stringify(persona)); // deep clone

  upgraded.$schema = 'v2';

  // preferences（給 LLM context 用，不影響程式邏輯）
  if (!upgraded.preferences) {
    upgraded.preferences = {
      _comment: 'M4.5 預留：給 LLM prompt 用，不影響程式邏輯。請依角色實際個性編輯。',
      interaction_style: inferInteractionStyle(upgraded),
      affection_mode: 'expressive',
      topic_preferences: [],
      topic_aversions: [],
      emotional_volatility: inferEmotionalVolatility(upgraded),
    };
  }

  // behavioral_settings（影響 TriggerEngine，M5+ 啟用，M4.5 用預設值）
  if (!upgraded.behavioral_settings) {
    upgraded.behavioral_settings = {
      _comment: 'M4.5 預留：M5+ 啟用後 TriggerEngine 會看這些值。M4.5 預設值不影響行為。',
      trigger_aggressiveness: 'normal',
      default_cooldown_multiplier: 1.0,
      preferred_categories: [],
      avoided_categories: [],
    };
  }

  // linked_states（啟用條件，M5+ 啟用）
  if (!upgraded.linked_states) {
    upgraded.linked_states = [];
  }

  return upgraded;
}

function inferInteractionStyle(persona) {
  const traits = (persona.personality?.core_traits || []).map((t) => String(t).toLowerCase());
  if (traits.some((t) => t.includes('病嬌') || t.includes('依戀') || t.includes('佔有'))) return 'clingy';
  if (traits.some((t) => t.includes('毒舌') || t.includes('吐槽'))) return 'sarcastic';
  if (traits.some((t) => t.includes('溫柔') || t.includes('體貼') || t.includes('善良'))) return 'gentle';
  return 'gentle';
}

function inferEmotionalVolatility(persona) {
  const traits = (persona.personality?.core_traits || []).map((t) => String(t).toLowerCase());
  if (traits.some((t) => t.includes('情緒波動') || t.includes('病嬌') || t.includes('崩潰'))) return 'high';
  if (traits.some((t) => t.includes('樂觀') || t.includes('溫和'))) return 'low';
  return 'normal';
}

function upgradeDialoguesMeta(dialogues, migrationTimestamp) {
  const upgraded = JSON.parse(JSON.stringify(dialogues));
  let addedCount = 0;

  const cats = upgraded.categories || {};
  for (const cat of Object.values(cats)) {
    const seqs = cat?.sequences;
    if (!Array.isArray(seqs)) continue;
    for (const seq of seqs) {
      if (!seq._meta) {
        seq._meta = {
          created_at: migrationTimestamp,    // 工具第一次跑時間
          source_batch: 'initial',
          weight: 1.0,
          edited_at: null,
          fire_count_lifetime: 0,
        };
        addedCount++;
      }
    }
  }

  return { upgraded, addedCount };
}

async function ensureVoicesDirs(personaDir) {
  for (const lang of ['zh', 'ja']) {
    const langDir = path.join(personaDir, 'voices', lang);
    const gitkeep = path.join(langDir, '.gitkeep');

    let existed = false;
    try { await fs.promises.access(gitkeep); existed = true; } catch (_e) {}

    if (!existed) {
      if (!opts.dryRun) {
        await fs.promises.mkdir(langDir, { recursive: true });
        await fs.promises.writeFile(gitkeep, '');
      }
      console.log(`  ✓ voices/${lang}/.gitkeep: 建立`);
    } else {
      // 不報已存在（reduce noise）
    }
  }
}

async function backup(filePath) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bakPath = `${filePath}.bak.${ts}`;
  await fs.promises.copyFile(filePath, bakPath);
}

function showHelp() {
  console.log(`migrate-persona-schema-v2.js — 一次性 persona package backfill

用法：
  node scripts/migrate-persona-schema-v2.js                # 跑全部 personas/ 子資料夾
  node scripts/migrate-persona-schema-v2.js --persona haiyin
  node scripts/migrate-persona-schema-v2.js --dry-run

行為：
  1. persona.json schema v1 → v2（加 preferences / behavioral_settings / linked_states）
  2. dialogues.json 每個 sequence 加 _meta（source_batch="initial", created_at, fire_count_lifetime=0）
  3. 從 dialogues.json 複製生成 dialogues-initial.json（不可變範本）
  4. 建 voices/zh/.gitkeep + voices/ja/.gitkeep

  寫前自動 backup（.bak.<timestamp>）

  Idempotent：可重複跑，已升級過的會略過
`);
}
