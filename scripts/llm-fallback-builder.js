#!/usr/bin/env node
// llm-fallback-builder.js — 動態組 10 份 LLM prompt 出來給使用者複製
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
// 設計目標：
//   - 純 Node script（不依賴外部套件）
//   - 從 personas/<id>/persona.json 動態讀人設組 prompt
//   - 直接 console.log 出 prompt，使用者複製貼到任意 LLM
//   - 不實際呼叫 LLM API（保留 stub 給未來整合 Ollama/Claude SDK）
//
// 文件對照：文件/M4-fallback-prompt-模板.md（人類可讀版本）

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PERSONAS_DIR = path.join(PROJECT_ROOT, 'personas');

// ─── 解析參數 ─────────────────────────────────────────────
const args = process.argv.slice(2);
const opts = {
  persona: null,    // haiyin / liss
  category: null,   // click_too_much / long_idle / ...
  count: 30,        // 每份 prompt 要求生成的句數
  list: false,      // 只列標題不出 body
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
for (const pid of new Set(targets.map((t) => t.pid))) {
  personaCache[pid] = loadPersona(pid);
}

// 輸出
for (let i = 0; i < targets.length; i++) {
  const { pid, cat } = targets[i];
  const persona = personaCache[pid];
  const title = `[${i + 1}/${targets.length}] ${pid} / ${cat}`;
  console.log('');
  console.log('═'.repeat(70));
  console.log(title);
  console.log('═'.repeat(70));

  if (opts.list) continue;

  console.log('');
  console.log(buildPrompt(persona, cat, opts.count));
}

console.log('');
console.log('─'.repeat(70));
console.log(`[OK] 共 ${targets.length} 份 prompt。複製上面整段（不含分隔線）餵 LLM。`);
console.log('整理後的 CSV 格式參考：文件/M4-fallback-prompt-模板.md §4');
console.log('─'.repeat(70));

// ─── Builder 主函式 ─────────────────────────────────────
function buildPrompt(persona, category, count) {
  const isHaiyin = persona.id === 'haiyin';
  const guide = persona.trigger_voice_guide?.[category] || '';
  const samples = (persona.voice_samples || []).map((s) => `「${s.replace(/^「|」$/g, '')}」`).join('\n');

  const expressionList = Object.keys(persona.expressions || {}).join(', ');
  const particles = (persona.speech_style?.common_particles || []).join(' / ');
  const kaomojis = (persona.speech_style?.common_kaomoji || []).join(' / ');

  const personaBlock = isHaiyin
    ? buildHaiyinPersonaBlock(persona, particles)
    : buildLissPersonaBlock(persona, particles, kaomojis);

  const taskBlock = buildTaskBlock(persona.id, category, guide, count);
  const formatBlock = buildFormatBlock(persona.id, expressionList, category);
  const negativeBlock = buildNegativeBlock(persona.id, category);

  return [
    `# 角色設定`,
    '',
    personaBlock,
    '',
    `# 本次任務（${category}）`,
    '',
    taskBlock,
    '',
    `# 風格樣本（對照參考，不要照抄）`,
    '',
    samples,
    '',
    `# 輸出格式`,
    '',
    formatBlock,
    '',
    `# 變數可選用（嵌入率 < ${category === 'drag' ? '10' : '30'}%）`,
    '',
    '{time} {hour} {weekday} {usage_hours} {window_title}',
    '',
    `# 風格負面表列`,
    '',
    negativeBlock,
    '',
    `# 開始輸出 ${count} 句 ${category} 觸發台詞`,
  ].join('\n');
}

// ─── Persona 區塊 ────────────────────────────────────────
function buildHaiyinPersonaBlock(persona, particles) {
  const traits = (persona.personality?.core_traits || []).join('、');
  const surface = persona.personality?.surface_impression || '';
  const bg = persona.personality?.background || '';
  const tone = persona.speech_style?.primary_tone || '';

  return [
    `身份：${persona.identity?.age} 歲日本東京學生，對使用者單方面認定為戀人。`,
    `表面：${surface}（紫黑長髮 + 雙馬尾 + 紫羅蘭眼）。`,
    `內裡：${traits}。`,
    `背景：${bg}`,
    '',
    `語氣：${tone}。`,
    `語助詞：${particles}`,
    `emoji：minimal（只用 ～ 拖音 + ❤ 偶爾）`,
    `自稱：我；稱使用者：你（不用「主人」，那是另一人格的稱呼）`,
    '',
    `特點：`,
    `- 對使用者極度依戀，會明示或暗示「只看我一個人」`,
    `- 嫉妒情緒爆發時語氣由甜變黑（罕見）`,
    `- 對「使用者去哪了 / 跟誰」有不安`,
    `- 凌晨黏膩感強`,
  ].join('\n');
}

function buildLissPersonaBlock(persona, particles, kaomojis) {
  const traits = (persona.personality?.core_traits || []).join('、');
  const surface = persona.personality?.surface_impression || '';
  const bg = persona.personality?.background || '';
  const tone = persona.speech_style?.primary_tone || '';

  return [
    `身份：${persona.identity?.age} 歲女僕，來自遙遠異國小鎮，是使用者的專屬女僕。`,
    `表面：${surface}（黑長髮 + 蝴蝶結頭飾 + 碧藍眼 + 黑白女僕裝）。`,
    `核心特質：${traits}。`,
    `背景：${bg}`,
    `弱點：過度擔心主人（可能變成嘮叨）、把所有事都自己扛。`,
    '',
    `語氣：${tone}。`,
    `副語氣：體貼、撒嬌、服侍意識強、樂觀。`,
    `語助詞：${particles}`,
    `emoji：frequent（顏文字 + ♡ 高頻）`,
    `常用顏文字：${kaomojis}`,
    `自稱：莉絲（第三人稱）/ 我`,
    `稱呼使用者：主人 / 您`,
    `**結尾語：「最愛的主人♡」（60-80% 句子結尾帶這句）**`,
    '',
    `特點：`,
    `- 話語結尾常帶「最愛的主人♡」`,
    `- 用顏文字表達情緒`,
    `- 對主人勞累/心情變化敏感`,
    `- 服侍意識強（「讓莉絲為您...」）`,
  ].join('\n');
}

// ─── 任務區塊（按 persona × category 客製） ──────────────
function buildTaskBlock(pid, category, guide, count) {
  const guides = {
    haiyin: {
      click_too_much: [
        `風格指引：${guide}。`,
        `情境：使用者在短時間內大量點擊（可能在點別的 app / 別的視窗 / 海音被忽略）。`,
        `情緒主軸：吃醋、撒嬌、佔有式關注、輕度抗議。`,
      ],
      long_idle: [
        `風格指引：${guide}。`,
        `情境：使用者離開鍵鼠許久（10-30 分鐘）後回來。`,
        `情緒主軸：不安、等待後的喜悅、嫉妒猜測、輕度抱怨「為什麼這麼久」。`,
        ``,
        `混合比例建議：`,
        `- 歡迎回來 + 撒嬌（40%）`,
        `- 質問「去哪了 / 跟誰」（30%）`,
        `- 內心獨白「會不會跟別人在一起」（thought 類，20%）`,
        `- 委屈/抱怨（10%）`,
      ],
      continuous_use: [
        `風格指引：${guide}。`,
        `情境：使用者連續使用電腦 2 小時以上沒休息。`,
        `情緒主軸：表面心疼 + 內裡吃醋（電腦/工作搶走了我的關注）。`,
        ``,
        `混合比例建議：`,
        `- 心疼提醒休息（30%）`,
        `- 吃醋電腦/工作（30%）`,
        `- 內心戲「比我還重要嗎」（thought，20%）`,
        `- 撒嬌求關注（20%）`,
        ``,
        `特別建議：{usage_hours} 在這個 category 適合用，可佔到 20-30%。`,
      ],
      deep_night: [
        `風格指引：${guide}。`,
        `情境：00:00-04:00 之間使用者還在用電腦。`,
        `情緒主軸：黏膩、獨佔（這個時間只有我陪你）、催睡、自戀（是想我嗎？）。`,
        ``,
        `混合比例建議：`,
        `- 撒嬌催睡（30%）`,
        `- 獨佔自戀（「這個時間只有我陪你」「是想我嗎」）（30%）`,
        `- 內心戲（thought，「想跟你多待一會」）（20%）`,
        `- 「嗶~」屏蔽訓記風格（極少，2-3 句中夾 1 句屏蔽）（10%）`,
        `- whisper 類低聲呢喃（10%）`,
        ``,
        `特別建議：{time} / {hour} 適合用，可佔 25-35%。`,
      ],
      drag: [
        `風格指引：${guide}。`,
        `情境：使用者用滑鼠拖曳海音的角色立繪在螢幕上移動。`,
        `情緒主軸：撒嬌、害羞、被觸碰時的反應、半順從半抗議。`,
        ``,
        `特別注意：drag 觸發頻繁，台詞要**短**（每句 5-12 字）+ **auto_close_ms 短**（4 秒就關），所以**幾乎都用 1 行 line**，不要寫 2 句的對白。`,
        ``,
        `混合比例建議：`,
        `- 撒嬌「要帶我去哪」（30%）`,
        `- 害羞反應（20%）`,
        `- 半反抗（「別這麼用力」「輕一點」）（20%）`,
        `- 順從（「你拉我都可以」）（20%）`,
        `- 內心小獨白（thought，10%）`,
      ],
    },
    liss: {
      click_too_much: [
        `風格指引：${guide}。`,
        `情境：主人在短時間內大量點擊，莉絲擔心是不是急躁了。`,
        `情緒主軸：溫柔提醒、擔心、體貼。`,
        ``,
        `混合比例建議：`,
        `- 溫柔提醒慢一點 + 擔心手累（40%）`,
        `- 提供協助（「讓莉絲幫您」）（30%）`,
        `- 顏文字 + 撒嬌（20%）`,
        `- 內心戲（thought，「主人今天好像有點趕」）（10%）`,
      ],
      long_idle: [
        `風格指引：${guide}。`,
        `情境：主人離開鍵鼠許久（10-30 分鐘）後回來。`,
        `情緒主軸：歡迎回來的喜悅 + 對主人不在時的擔心。`,
        ``,
        `混合比例建議：`,
        `- 熱情歡迎回來（40%）`,
        `- 擔心主人安全 / 過得好不好（25%）`,
        `- 撒嬌「莉絲一直在等您」（20%）`,
        `- 內心戲（thought，「希望主人沒發生什麼事」）（15%）`,
      ],
      continuous_use: [
        `風格指引：${guide}。`,
        `情境：主人連續使用電腦 2 小時以上沒休息。`,
        `情緒主軸：心疼、提醒具體休息動作、服侍意識（「讓莉絲為您按摩」）。`,
        ``,
        `混合比例建議：`,
        `- 提醒喝水 / 伸懶腰 / 看遠方 / 起身（35%）`,
        `- 心疼主人勞累（25%）`,
        `- 提供服侍（按摩、泡茶、墊枕頭）（25%）`,
        `- 內心戲（thought，「主人這樣身體會壞掉的」）（15%）`,
        ``,
        `特別建議：{usage_hours} 適合用，可佔 25-30%（「已經 {usage_hours} 小時沒休息了」）。`,
      ],
      deep_night: [
        `風格指引：${guide}。`,
        `情境：00:00-04:00 之間主人還在用電腦。`,
        `情緒主軸：溫柔催睡、擔心健康、服侍（鋪被、洗澡水、泡熱牛奶）。`,
        `特別氛圍：莉絲自己也睏倦但堅持陪伴（sleepy 表情可佔 25-30%）。`,
        ``,
        `混合比例建議：`,
        `- 溫柔催睡（30%）`,
        `- 擔心主人健康 / 黑眼圈（25%）`,
        `- 服侍（「莉絲幫您鋪好被子」「熱水澡準備好了」）（25%）`,
        `- 內心戲（thought，「主人凌晨還在工作⋯⋯莉絲也陪到底」）（10%）`,
        `- 莉絲自己也睏倦但堅持服侍（10%）`,
        ``,
        `特別建議：{time} / {hour} 適合用，可佔 25-35%（「都 {time} 了⋯⋯」）。`,
      ],
      drag: [
        `風格指引：${guide}。`,
        `情境：主人用滑鼠拖曳莉絲的角色立繪在螢幕上移動。`,
        `情緒主軸：害羞、開心服侍、撒嬌、樂於跟隨。`,
        ``,
        `特別注意：drag 觸發頻繁，台詞要**短**（每句 5-15 字）+ **auto_close_ms 短**（4 秒就關），所以**幾乎都用 1 行 line**，不要寫 2 句的對白。`,
        ``,
        `drag 是少數可以**降低「最愛的主人♡」結尾比例**的 category（因為句子要短），這個 category 結尾語只佔 30-40%。`,
        ``,
        `混合比例建議：`,
        `- 害羞 + 「主人要帶莉絲去哪」（30%）`,
        `- 開心跟隨（25%）`,
        '- 顏文字反應 (´。• ᵕ •。`) (*ˊᗜˋ*)（25%）',
        `- 撒嬌「慢一點啦」（15%）`,
        `- 內心戲（thought，5%）`,
      ],
    },
  };

  const arr = guides[pid]?.[category] || [`風格指引：${guide}。`];
  return [`本次要為 ${pid} / ${category} 觸發情境生成 ${count} 句中文 fallback 台詞。`, '']
    .concat(arr)
    .join('\n');
}

// ─── 輸出格式區塊 ────────────────────────────────────────
function buildFormatBlock(pid, expressionList, category) {
  const isHaiyin = pid === 'haiyin';
  const isDrag = category === 'drag';
  const isDeepNight = category === 'deep_night';

  const lines = [
    '每行一句，格式：',
    '',
    '[type] 台詞文字 | expression: <表情標籤>',
    '',
  ];

  if (isHaiyin) {
    if (isDeepNight) {
      lines.push('- type 從 [speech, thought, whisper] 選（whisper 用於極黏膩低聲場景，約 10%）');
    } else if (isDrag) {
      lines.push('- type 主要 `speech`，`thought` 不超過 10%');
    } else {
      lines.push('- type 是 `speech` 或 `thought`（thought 約佔 20%，內心獨白用括號包）');
    }
    lines.push(`- expression 從 [${expressionList}] 選一個`);
    if (isDeepNight) {
      lines.push('- sleepy 在這個 category 可佔 30%（凌晨睏倦感）');
      lines.push('- yandere 表情可在這個 category 出現，但 30 句最多 2-3 句');
    } else {
      lines.push('- yandere 表情極少用（30 句中最多 1-2 句）');
    }
    if (isDrag) {
      lines.push('- 每句長度 5-12 字（drag 要短）');
    }
  } else {
    if (isDrag) {
      lines.push('- type 主要 `speech`，`thought` 不超過 5%');
      lines.push(`- expression 偏 [happy, shy, wink]`);
      lines.push('- 每句 5-15 字（drag 要短）');
    } else {
      lines.push('- type 是 `speech` 或 `thought`');
      lines.push(`- expression 從 [${expressionList}] 選一個`);
      if (isDeepNight) {
        lines.push('- sleepy 在這個 category 可佔 25-30%（凌晨睏倦感）');
        lines.push('- worried 可佔 25-30%');
      } else if (category === 'continuous_use') {
        lines.push('- worried 在這個 category 可佔 30%（心疼擔心）');
      } else if (category === 'long_idle') {
        lines.push('- happy 在這個 category 可佔 30-40%（歡迎回來的喜悅）');
      }
    }
  }

  return lines.join('\n');
}

// ─── 風格負面表列 ────────────────────────────────────────
function buildNegativeBlock(pid, category) {
  const isHaiyin = pid === 'haiyin';
  const isDrag = category === 'drag';

  const common = [
    '- 不要寫「身為 AI」「作為語言模型」之類自指',
    '- 不要超過 2 句（每個 sequence 最多 2 行 lines）',
  ];

  if (isHaiyin) {
    common.unshift('- 不要極端暴力或威脅（如「殺了那個人」「把你綁起來」這類）');
    common.push('- 不要每句都用 emoji（30 句中 ❤ 最多 6-8 句）');
    common.push('- 不要用「主人」稱呼使用者（那是莉絲）');
    common.push('- 不要過度華麗修辭');
  } else {
    common.unshift('- 不要冷淡語氣（「請停止點擊」這種命令式禁用）');
    common.push('- 不要叫使用者「你」（一律「主人」/「您」）');
    common.push('- 不要用海音的語助詞（「呐」「啦」這類）');
  }

  if (isDrag) {
    common.push('- 每句嚴格 1 行（不要 2 句對白）');
  }

  return common.join('\n');
}

// ─── Helpers ─────────────────────────────────────────────
function loadPersona(pid) {
  const file = path.join(PERSONAS_DIR, pid, 'persona.json');
  if (!fs.existsSync(file)) {
    console.error(`[!] 找不到 persona 檔：${file}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
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
  --list              只列標題，不出 prompt body`;
}

// ─── 未來 stub：直接呼叫 LLM API ─────────────────────────
// TODO(M4 後期/M7)：
//   - 支援 --provider ollama|claude|openai
//   - --provider ollama: POST http://localhost:11434/api/generate
//     參考 文件/gemma4_api_guide.md
//   - --provider claude: 用 @anthropic-ai/sdk
//   - --provider openai: 用 openai npm
//   - 結果直接寫到 ./drafts/<pid>_<cat>_<timestamp>.txt
//
// async function callOllama(prompt) { ... }
// async function callClaude(prompt) { ... }
// async function callOpenAI(prompt) { ... }
