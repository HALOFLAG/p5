// migrate-to-persona-pack-v3.js
//
// 把 v2 persona.json + config/voice-config.json + 角色素材/ 整合成 v3 self-contained pack。
//
// 動作：
//   1. 每個 persona 的 persona.json 升 v3，加 voice / appearance.static / appearance.live2d / time_voice_overrides 區塊
//   2. config/voice-config.json 的 per-persona voice 設定 → 搬進 persona.json
//   3. ref_audio 檔案 → 搬到 personas/<id>/voice-refs/
//   4. 角色素材/*.png → 搬到 personas/<id>/appearance/static/main.png + expressions/
//   5. config/voice-config.json 簡化（只留 engine_command + 全域 sampling）
//
// 備份：所有改動先 cp 到 _migrate-v3-<timestamp>/ 下
//
// 用法：node scripts/migrate-to-persona-pack-v3.js [--dry-run]

'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const PERSONAS_DIR = path.join(PROJECT_ROOT, 'personas');
const VOICE_CONFIG = path.join(PROJECT_ROOT, 'config', 'voice-config.json');
const CHAR_ASSETS = path.join(PROJECT_ROOT, '角色素材');

const PERSONAS = ['haiyin', 'liss'];
const STANDARD_EXPRESSIONS = ['idle', 'happy', 'shy', 'pout', 'annoyed', 'worried', 'embarrassed', 'sleepy', 'yandere'];

const dryRun = process.argv.includes('--dry-run');
const log = (...args) => console.log(...args);

function exists(p) { return fs.existsSync(p); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
function writeJson(p, obj) {
  if (dryRun) { log(`  [dry] write ${path.relative(PROJECT_ROOT, p)}`); return; }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}
function copyFile(from, to) {
  if (dryRun) { log(`  [dry] copy ${path.relative(PROJECT_ROOT, from)} → ${path.relative(PROJECT_ROOT, to)}`); return; }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
function ensureDir(p) {
  if (dryRun) return;
  fs.mkdirSync(p, { recursive: true });
}
function writeFile(p, content) {
  if (dryRun) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const ts = new Date().toISOString().replace(/[:.]/g, '-');
log(`=== Migrate to persona-pack v3 ===${dryRun ? ' [DRY RUN]' : ''}\n`);

// 讀 voice-config（給 per-persona voice 用）
let voiceConfig = null;
try {
  voiceConfig = readJson(VOICE_CONFIG);
  log(`[voice-config] loaded — voices: ${Object.keys(voiceConfig.voices || {}).join(', ') || '(none)'}\n`);
} catch (_e) {
  log('[voice-config] 不存在或讀取失敗\n');
}

for (const personaId of PERSONAS) {
  const personaDir = path.join(PERSONAS_DIR, personaId);
  const personaFile = path.join(personaDir, 'persona.json');

  if (!exists(personaFile)) {
    log(`[${personaId}] persona.json 不存在，跳過\n`);
    continue;
  }

  log(`[${personaId}]`);
  const backupDir = path.join(personaDir, `_migrate-v3-${ts}`);

  // ─── 1. persona.json schema 升級 ───
  const persona = readJson(personaFile);
  if (!dryRun) copyFile(personaFile, path.join(backupDir, 'persona.json.bak'));
  const oldSchema = persona.$schema;
  persona.$schema = 'v3';

  // ─── 2. 加 voice 區塊（從 voice-config 拉）───
  const cfgVoice = voiceConfig?.voices?.[personaId] || {};
  // ref_audio 從絕對路徑轉成相對 persona dir
  let refAudioRel = null;
  if (cfgVoice.ref_audio) {
    const origRef = cfgVoice.ref_audio;
    // 若是絕對路徑且檔案存在 → 複製到 personas/<id>/voice-refs/
    const refAbs = path.isAbsolute(origRef) ? origRef : path.join(PROJECT_ROOT, origRef);
    if (exists(refAbs)) {
      const baseName = path.basename(refAbs);
      const destRel = `voice-refs/${baseName}`;
      const destAbs = path.join(personaDir, destRel);
      if (!exists(destAbs)) copyFile(refAbs, destAbs);
      refAudioRel = destRel;
      log(`  [voice] ref_audio → ${destRel}`);
    } else {
      log(`  [voice] ⚠ ref_audio 檔案不存在：${origRef}（保留原值）`);
      refAudioRel = origRef;
    }
  }
  // additional_refs 同樣處理
  const additionalRefsRel = [];
  for (const ar of (cfgVoice.additional_refs || [])) {
    const arAbs = path.isAbsolute(ar) ? ar : path.join(PROJECT_ROOT, ar);
    if (exists(arAbs)) {
      const baseName = path.basename(arAbs);
      const destRel = `voice-refs/${baseName}`;
      const destAbs = path.join(personaDir, destRel);
      if (!exists(destAbs)) copyFile(arAbs, destAbs);
      additionalRefsRel.push(destRel);
    } else {
      additionalRefsRel.push(ar);
    }
  }

  persona.voice = {
    ref_audio: refAudioRel,
    ref_text: cfgVoice.ref_text || '',
    ref_lang: cfgVoice.lang || cfgVoice.ref_lang || 'ja',
    voice_lang: cfgVoice.voice_lang || cfgVoice.lang || 'ja',
    additional_refs: additionalRefsRel,
    sampling: cfgVoice.sampling || {},
  };
  log(`  [voice] block 寫入 (ref_lang=${persona.voice.ref_lang}, voice_lang=${persona.voice.voice_lang})`);

  // ─── 3. appearance.static + live2d 區塊 ───
  const appearance = persona.appearance || {};

  // 處理舊 appearance.image（可能是 ../../角色素材/海音立繪1.png）
  let mainImageRel = 'appearance/static/main.png';
  const oldImage = appearance.image;
  if (oldImage) {
    const oldImageAbs = path.isAbsolute(oldImage) ? oldImage : path.resolve(personaDir, oldImage);
    if (exists(oldImageAbs)) {
      const destAbs = path.join(personaDir, mainImageRel);
      if (!exists(destAbs)) copyFile(oldImageAbs, destAbs);
      log(`  [appearance] main: ${path.relative(PROJECT_ROOT, oldImageAbs)} → ${mainImageRel}`);
    } else {
      log(`  [appearance] ⚠ 舊 image 檔不存在：${oldImage}`);
    }
  } else {
    log(`  [appearance] 沒有 main 圖（之後手動放到 ${mainImageRel}）`);
  }

  // 建 expressions 結構（路徑預留 — 對應實際檔不一定存在）
  const expressionsPaths = {};
  for (const expr of STANDARD_EXPRESSIONS) {
    expressionsPaths[expr] = `appearance/static/expressions/${expr}.png`;
  }
  appearance.static = {
    main: mainImageRel,
    expressions: expressionsPaths,
  };

  appearance.live2d = appearance.live2d || {
    enabled: false,
    model_file: 'appearance/live2d/model3.json',
    motion_groups: { idle: [], happy: [], pout: [] },
    _note: 'M8+ 啟用。把 Cubism 模型放 appearance/live2d/ 目錄',
  };

  // 移除舊欄位 image（已被 static.main 取代）
  delete appearance.image;
  persona.appearance = appearance;

  // 建 live2d 預留資料夾 + README
  const live2dDir = path.join(personaDir, 'appearance', 'live2d');
  if (!exists(live2dDir)) {
    ensureDir(live2dDir);
    writeFile(path.join(live2dDir, 'README.md'), [
      `# Live2D 模型資料夾`,
      ``,
      `M8+ 預留位置。把 Cubism Editor 匯出的整個 model 資料夾放這裡：`,
      ``,
      `  appearance/live2d/`,
      `  ├── model3.json`,
      `  ├── *.moc3`,
      `  ├── physics3.json`,
      `  ├── textures/`,
      `  ├── motions/`,
      `  └── expressions/`,
      ``,
      `然後在 persona.json 的 appearance.live2d 區塊把 enabled 改 true。`,
    ].join('\n'));
    log(`  [live2d] 建 appearance/live2d/README.md`);
  }

  // ─── 4. time_voice_overrides 搬進 persona.json ───
  const tvo = voiceConfig?.time_voice_overrides?.[personaId];
  if (tvo) {
    persona.time_voice_overrides = tvo;
    log(`  [time_overrides] 搬入 ${Object.keys(tvo).map(l => `${l}(${Object.keys(tvo[l]).length})`).join(', ')}`);
  } else {
    persona.time_voice_overrides = persona.time_voice_overrides || {};
  }

  // ─── 5. 寫回 persona.json ───
  writeJson(personaFile, persona);
  log(`  [persona.json] ${oldSchema || '無'} → v3 已升級\n`);
}

// ─── 6. 簡化 voice-config.json，只留 engine_command + 全域 sampling ───
if (voiceConfig) {
  if (!dryRun) {
    fs.mkdirSync(path.join(PERSONAS_DIR, '..', 'config'), { recursive: true });
    fs.copyFileSync(VOICE_CONFIG, VOICE_CONFIG + `.bak.migrate-v3-${ts}`);
  }
  const slim = {
    engine: voiceConfig.engine,
    base_url: voiceConfig.base_url,
    sampling: voiceConfig.sampling,
    engine_command: voiceConfig.engine_command,
  };
  for (const k of Object.keys(slim)) if (slim[k] == null) delete slim[k];
  writeJson(VOICE_CONFIG, slim);
  log(`[voice-config.json] 簡化（voices / time_voice_overrides 已移到 persona.json）`);
}

log(`\n=== Done ===`);
if (dryRun) log('預演完成，移除 --dry-run 後執行真正 migration。');
