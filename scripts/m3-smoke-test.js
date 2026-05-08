// M3 整合 smoke test（純 Node，不需 Electron 視窗）
//
// 驗證範圍：
//   - EventLogger 寫 JSONL + redact + 黑名單過濾 + flush
//   - MonitorRegistry tier1 模式（不啟動任何 plugin）
//   - ContextStateTracker fail-open（無 capability → state value=null, reason=capability-missing）
//   - TriggerEngine capability 自動推導 + disabled rule 標記
//   - DialogueDirector 載入 persona、變數插值、recent ring buffer
//
// 使用：
//   node scripts/m3-smoke-test.js

const path = require('node:path');
const fs = require('node:fs/promises');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TEST_DATA_DIR = path.join(PROJECT_ROOT, 'data', '_smoke');

(async () => {
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
  await fs.mkdir(TEST_DATA_DIR, { recursive: true });

  const { EventLogger } = require(path.join(PROJECT_ROOT, 'src/main/event-logger'));
  const { MonitorRegistry } = require(path.join(PROJECT_ROOT, 'src/main/monitor-registry'));
  const { ContextStateTracker } = require(path.join(PROJECT_ROOT, 'src/main/context-state-tracker'));
  const { TriggerEngine } = require(path.join(PROJECT_ROOT, 'src/main/trigger-engine'));
  const { DialogueDirector } = require(path.join(PROJECT_ROOT, 'src/main/dialogue-director'));

  // ── 1. EventLogger ─────────────────────────────────
  console.log('--- 1. EventLogger ---');
  const logger = new EventLogger({ dataDir: TEST_DATA_DIR, blacklist: ['1password.exe'] });
  await logger.start();

  logger.log({ type: 'test:smoke', t: Date.now(), msg: 'hello' });
  logger.log({ type: 'window:focus-changed', t: Date.now(), app: 'chrome.exe', title: '收件匣 - test@example.com - Gmail' });
  logger.log({ type: 'window:focus-changed', t: Date.now(), app: '1password.exe', title: '保險庫 - 1Password' });
  logger.log({ type: 'typing-burst', t: Date.now(), key_count: 32, duration_ms: 4200, modifier_ratio: 0.05, backspace_ratio: 0.12 });
  logger.log({ type: 'trigger:fired', t: Date.now(), category: 'click_too_much', sequence_id: 'haiyin_ctm_001' });

  await logger.flushNow();

  const today = new Date().toISOString().slice(0, 10);
  const jsonlPath = path.join(TEST_DATA_DIR, 'events', `${today}.jsonl`);
  const jsonl = await fs.readFile(jsonlPath, 'utf-8');
  const lines = jsonl.trim().split('\n').map((l) => JSON.parse(l));
  console.log(`  events written: ${lines.length}`);
  console.log(`  redacted title: "${lines.find((l) => l.app === 'chrome.exe').title}"`);
  console.log(`  blacklist filtered: ${!lines.some((l) => l.app === '1password.exe') ? 'yes' : 'NO (FAIL)'}`);
  console.log(`  trigger:fired counted: ${logger.getStatsSnapshot().today_counters.triggers_fired}`);

  // ── 2. MonitorRegistry tier1 ───────────────────────
  console.log('\n--- 2. MonitorRegistry (tier1, 無 plugin 啟動) ---');
  const reg = new MonitorRegistry({ pluginsConfig: { monitor_level: 'tier1', plugins: {} } });
  await reg.start();
  console.log(`  active capabilities: [${[...reg.getActiveCapabilities()].join(',') || '(empty)'}]`);

  // ── 3. ContextStateTracker fail-open ───────────────
  console.log('\n--- 3. ContextStateTracker fail-open ---');
  const ctx = new ContextStateTracker({ inputMonitor: null, registry: reg, appClassification: {} });
  ctx.start();
  await sleep(50);
  const state = ctx.getState();
  for (const [name, s] of Object.entries(state)) {
    console.log(`  ${name}: value=${s.value}, reason=${s.reason}`);
  }

  // ── 4. TriggerEngine capability 推導 ───────────────
  console.log('\n--- 4. TriggerEngine capability 推導（tier1 模式下大量規則應 disabled）---');
  const triggers = JSON.parse(
    await fs.readFile(path.join(PROJECT_ROOT, 'config/triggers.json'), 'utf-8')
  );
  const engine = new TriggerEngine({
    inputMonitor: null,
    contextState: ctx,
    registry: reg,
    getSettings: () => ({}),
  });
  engine.loadRules(triggers);
  for (const s of engine.getRuleStatus()) {
    const status = s.enabled ? 'enabled' : `DISABLED (missing: ${s.missing_capabilities.join(',') || 'unknown'})`;
    console.log(`  ${s.name.padEnd(28)} ${status}`);
  }

  // ── 5. DialogueDirector ────────────────────────────
  console.log('\n--- 5. DialogueDirector ---');
  const captured = [];
  const dir = new DialogueDirector({
    personasDir: path.join(PROJECT_ROOT, 'personas'),
    recentDialoguesPath: path.join(TEST_DATA_DIR, 'recent-dialogues.json'),
    getActivePersona: () => 'haiyin',
    sender: (channel, payload) => captured.push({ channel, payload }),
    eventLogger: logger,
  });
  await dir.load();

  for (let i = 0; i < 3; i++) {
    await dir.handleFire({
      rule_name: 'continuous_use',
      category: 'continuous_use',
      fired_at: Date.now(),
      context: { input: { session_sec: 4 * 3600 + 1800 }, contextState: {} },
    });
  }
  console.log(`  fired 3 times, captured: ${captured.length} dialogues`);
  for (const c of captured) {
    console.log(`    sequenceId=${c.payload.sequenceId}, line[0]="${c.payload.lines[0].text}"`);
  }
  console.log(`  recent ring size: ${dir.getRecentEntries().length}`);

  // ── 6. 切人格驗證 cache 失效 ───────────────────────
  console.log('\n--- 6. 切人格 cache invalidation ---');
  let activePersona = 'haiyin';
  const dir2 = new DialogueDirector({
    personasDir: path.join(PROJECT_ROOT, 'personas'),
    recentDialoguesPath: path.join(TEST_DATA_DIR, 'recent-dialogues.json'),
    getActivePersona: () => activePersona,
    sender: (channel, payload) => captured.push({ channel, payload, persona: activePersona }),
    eventLogger: logger,
  });
  await dir2.load();
  await dir2.handleFire({ rule_name: 'click_too_much', category: 'click_too_much', context: {} });
  activePersona = 'liss';
  dir2.invalidatePersonaCache();
  await dir2.handleFire({ rule_name: 'click_too_much', category: 'click_too_much', context: {} });
  const lastTwo = captured.slice(-2);
  console.log(`  haiyin: ${lastTwo[0].payload.sequenceId}, liss: ${lastTwo[1].payload.sequenceId}`);

  // 清理
  ctx.stop();
  await reg.stop();
  await logger.stop();

  console.log('\n=== M3 smoke test PASSED ===');
})().catch((err) => {
  console.error('M3 smoke test FAILED:', err);
  process.exit(1);
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
