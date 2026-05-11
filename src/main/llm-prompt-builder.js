// llm-prompt-builder — 共用 prompt 組裝邏輯（CLI: llm-fallback-builder / UI: 對話庫管理 Tab 4）
//
// 對外 API：
//   buildPrompt({ persona, category, count, dialoguesInitial })
//                                  返回完整 LLM prompt 字串
//
// 設計：
//   - 純函式，不碰 IO（呼叫端自己讀 persona.json / dialogues-initial.json）
//   - persona / category 條件分支保留在這裡（CLI 跟 UI 共用同一份邏輯）
//   - LLM prompt 樣本來源：dialogues-initial.json[category]，缺時 fallback voice_samples

const DEFAULT_COUNT = 30;

function buildPrompt({ persona, category, count, dialoguesInitial, classMix, streakLevel, bilingual = true }) {
  const n = Number.isFinite(count) && count > 0 ? count : DEFAULT_COUNT;
  const isHaiyin = persona.id === 'haiyin';
  const guide = persona.trigger_voice_guide?.[category] || '';
  const samples = formatInitialSamples(dialoguesInitial, category, persona);

  const expressionList = Object.keys(persona.expressions || {}).join(', ');
  const particles = (persona.speech_style?.common_particles || []).join(' / ');
  const kaomojis = (persona.speech_style?.common_kaomoji || []).join(' / ');

  const personaBlock = isHaiyin
    ? buildHaiyinPersonaBlock(persona, particles)
    : buildLissPersonaBlock(persona, particles, kaomojis);

  const taskBlock = buildTaskBlock(persona.id, category, guide, n);
  const formatBlock = buildFormatBlock(persona.id, expressionList, category, { bilingual });
  const glossaryBlock = bilingual ? buildBilingualGlossaryBlock(persona.id) : '';
  const negativeBlock = buildNegativeBlock(persona.id, category);
  // P5 補：classMix 未填用 category 預設
  const effectiveClassMix = (classMix && Object.keys(classMix).length > 0)
    ? classMix
    : (DEFAULT_CLASS_MIX[category] || null);
  const classMixBlock = buildClassMixBlock(effectiveClassMix, n, streakLevel, { isDefault: !classMix });
  const situationalBlock = SITUATIONAL_HINTS[category] || '';

  return [
    `# 角色設定`,
    '',
    personaBlock,
    '',
    `# 本次任務（${category}）`,
    '',
    taskBlock,
    '',
    classMixBlock ? `# 內容類配比（§6.4 9 類）\n\n${classMixBlock}\n` : '',
    situationalBlock ? `# 情境差異化提示\n\n${situationalBlock}\n` : '',
    `# 風格樣本（對照參考，不要照抄主題或用詞）`,
    '',
    samples,
    '',
    `# 輸出格式`,
    '',
    formatBlock,
    '',
    glossaryBlock ? `# 雙語對照\n\n${glossaryBlock}\n` : '',
    `# 變數可選用（嵌入率 < ${category === 'drag' ? '10' : '30'}%）`,
    '',
    '{time} {hour} {weekday} {usage_hours} {window_title}',
    '',
    `# 風格負面表列`,
    '',
    negativeBlock,
    '',
    `# 開始輸出 ${n} 句 ${category} 觸發台詞`,
  ].filter((s) => s !== '').join('\n');
}

const CLASS_LABELS = {
  '1': '思考 / 模擬思考過程（thought 氣泡，display）',
  '2': '自言自語 / 評論（speech 或 whisper，display）',
  '3': '主動互動 / 閒聊（speech，期待開放回應；P1 後可加 choice）',
  '4': '回應使用者（speech，display；多用於 choice/binary 的 response）',
  'A': '指令 / 提醒（speech，期待使用者照做；常用 binary）',
  'B': '詢問（speech，期待封閉答案；天然對應 binary / choice）',
  'C': '撒嬌 / 求關注（speech 或 whisper，情緒勾子但不一定要回答）',
  'D': '情緒反應（speech，即時感嘆，無分析）',
  'E': '情境旁白（narration 第三人稱描述）',
};

// 每 category 預設 9 類配比（用戶沒主動填配比就自動套）
// 來源：spec §7.2 + LLM 實際輸出觀察微調
// 配比邏輯：每個 category 涵蓋 4-5 種類別，避免單一類別 dominant
const DEFAULT_CLASS_MIX = {
  click_character: { '3': 45, 'C': 25, '1': 15, '4': 10, 'D': 5 },        // 主動互動為主
  chatter:         { '2': 40, '3': 25, 'C': 15, '1': 10, 'D': 5, 'E': 5 }, // 廣涵蓋
  boot_greet:      { '3': 40, '2': 30, 'C': 20, '1': 10 },                  // 主動互動歡迎
  time_greet:      { 'A': 35, 'B': 30, 'C': 20, '2': 15 },                  // 詢問+提醒
  app_switch:      { '2': 30, 'C': 20, 'B': 20, 'A': 15, '1': 10, 'D': 5 }, // 觀察+好奇+詢問
  deep_night:      { 'C': 30, 'A': 25, '2': 20, '1': 15, 'E': 10 },         // 催睡+撒嬌+催睡
  long_idle:       { '4': 35, 'C': 30, '3': 25, '1': 5, 'E': 5 },           // 歡迎+撒嬌
  continuous_use:  { 'A': 40, 'C': 25, '2': 20, '1': 10, 'B': 5 },          // 提醒主導
  click_too_much:  { 'D': 30, '2': 30, '1': 25, 'A': 10, 'C': 5 },          // 情緒反應+觀察
  typing_burst:    { '1': 50, 'D': 25, '2': 15, 'C': 10 },                  // thought 主導
  click_burst:     { 'D': 50, '2': 25, 'A': 15, '1': 10 },                  // 即時情緒
  drag:            { '4': 50, 'D': 25, 'C': 15, '1': 10 },                  // 被拉的反應
  game_enter:      { 'B': 50, '3': 25, 'A': 15, 'C': 5, 'D': 5 },           // binary 詢問
};

// Category 完整資訊（給 UI 顯示說明 + 預設配比 + 觸發說明）
const CATEGORY_INFO = {
  drag: {
    description: '使用者拖角色立繪',
    triggered_by: '事件：character:drag-start',
    expected_count: 30,
    bubble_recommended: 'speech / display（短句 5-15 字）',
    notes: '頻繁觸發，台詞要短，auto_close 短',
  },
  click_too_much: {
    description: '使用者累計 ≥500 click（不確定在做什麼）',
    triggered_by: '計數：clicks_since_last_trigger ≥ 500',
    expected_count: 30,
    bubble_recommended: 'speech / thought',
    notes: '提醒慢一點 + 體貼擔心',
  },
  long_idle: {
    description: '使用者離開 ≥30 分後回來',
    triggered_by: '閒置：idle_sec ≥ 1800',
    expected_count: 30,
    bubble_recommended: 'speech',
    notes: '歡迎回來 / 撒嬌「等好久了」',
  },
  continuous_use: {
    description: '使用者連續用 ≥4 小時',
    triggered_by: 'session ≥ 4 小時',
    expected_count: 30,
    bubble_recommended: 'speech / whisper（後段疲勞用 whisper）',
    notes: '提醒休息 / 心疼勞累',
  },
  deep_night: {
    description: '深夜 23:00–05:00 使用',
    triggered_by: '時段：23:00–05:00',
    expected_count: 30,
    bubble_recommended: 'speech / whisper / thought 混合',
    notes: '催睡 / 黏膩感 / 部分 binary「還不睡？」',
  },
  click_character: {
    description: '使用者點擊角色立繪（主動互動入口）',
    triggered_by: '事件：character:click（含 click_streak 5 連點）',
    expected_count: 20,
    bubble_recommended: 'speech + choice / display',
    notes: '建議 3-5 條 choice 互動樹；streak_level=high 給連點用',
  },
  chatter: {
    description: '隨機閒談 + 整點報時共用',
    triggered_by: 'random_chatter（cd 後機率）+ hourly_active（整點+活躍）',
    expected_count: 30,
    bubble_recommended: 'speech',
    notes: 'hourly_active 會自動串接時間音；不要在 chatter 寫含時間變數的句',
  },
  boot_greet: {
    description: '應用程式啟動時觸發（每次重啟才再 fire）',
    triggered_by: '事件：app:ready',
    expected_count: 5,
    bubble_recommended: 'speech persistent（釘 5 秒）',
    notes: '開機問候，可加顏文字',
  },
  time_greet: {
    description: '早午晚夜時段問候（7:00 / 12:00 / 18:00 / 22:00）',
    triggered_by: '時刻 + voice_prefix=morning/lunch/evening/night',
    expected_count: 20,
    bubble_recommended: 'speech / whisper（night）+ binary 詢問',
    notes: '4 個 trigger rules 共用此 category；建議 2-4 條 binary',
  },
  typing_burst: {
    description: '使用者 60 秒內多次打字爆發',
    triggered_by: '事件爆發：60s 內 ≥ 3 次 typing-burst',
    expected_count: 10,
    bubble_recommended: 'thought 為主',
    notes: '內心戲觀察打字節奏 / 加油打氣',
  },
  click_burst: {
    description: '使用者 30 秒內 ≥50 次 click（急著操作）',
    triggered_by: '事件爆發：30s 內 ≥ 50 次 click',
    expected_count: 10,
    bubble_recommended: 'speech',
    notes: '即時情緒反應「太急了」+ 提醒',
  },
  app_switch: {
    description: '切到 browser / chat / video（30% 機率）',
    triggered_by: 'app_focus_browser / chat / video（classifications）',
    expected_count: 15,
    bubble_recommended: 'speech / thought（chat 暗黑）',
    notes: '依切到不同 app 應有不同反應；不要全嫉妒',
  },
  game_enter: {
    description: '使用者進遊戲（state edge）',
    triggered_by: '狀態邊緣：in_game false → true',
    expected_count: 8,
    bubble_recommended: 'speech persistent + binary',
    notes: 'binary 詢問為主（要陪嗎？要不要觀戰？）',
  },
};

function getCategoryInfo(category) {
  const info = CATEGORY_INFO[category];
  const mix = DEFAULT_CLASS_MIX[category];
  if (!info && !mix) return null;
  return {
    category,
    ...(info || {}),
    default_class_mix: mix || null,
  };
}

function listAllCategoryInfo() {
  const out = {};
  for (const cat of Object.keys(CATEGORY_INFO)) {
    out[cat] = getCategoryInfo(cat);
  }
  return out;
}

// 每 category 詞彙多樣性提示 — 避免重複用同一個動詞/名詞
const VOCAB_DIVERSITY_HINTS = {
  app_switch: '同一動詞重複 ≤ 3 次（例「切」字不要 30 句都用，改用「跳到」「換」「移」「跑去」「轉到」等）',
  chatter: '同一情緒詞重複 ≤ 3 次；不要每句都「呢」「啦」結尾，交替使用',
  click_character: '回應方式要分散（驚訝、害羞、欣慰、嗔怪都有）',
  drag: '反應動詞分散：「拉」「拖」「帶」「移」交替',
  click_too_much: '「點」「敲」「按」交替；情緒描述分散（急、忙、緊張、衝動）',
  typing_burst: '「敲」「打」「寫」交替；句尾形容變化（緊張、認真、急、努力）',
};

// 雙語自稱 / 稱呼對照表 — 確保 zh 字幕跟 ja 語音的 self-reference / 對方稱呼一致
// 避免「莉絲在這呢，主人」zh → 「ここにいますよ」ja（自稱+稱呼都被省）
//
// 重要：ja voice_text 一律走 GPT-SoVITS TTS 合成。漢字多讀音時可能念錯，所以
// 「易讀錯的詞」必須用全平假名拼讀（如「主人」→「ごしゅじんさま」不寫漢字）。
const BILINGUAL_GLOSSARY = {
  haiyin: {
    self: { zh: '我', ja: 'わたし（全平假名）' },
    addressing_user: { zh: '你', ja: 'あなた / きみ（全平假名，不寫「君」）' },
    extra: [
      '海音很少自報名字（主要用「我 / わたし」自稱）',
      'zh 結尾的「呐 / 啦」對應 ja 的「ねえ / よ / の」',
      '「不准 / 不要」→「ダメ / しないで」',
      '常見專有名詞用平假名：おふろ / おちゃ / だいすき / すてき / かわいい',
    ],
  },
  liss: {
    self: { zh: '莉絲 / 我', ja: 'リス（片假名，專有名詞）/ わたし' },
    addressing_user: { zh: '主人 / 您', ja: 'ごしゅじんさま（**強制全平假名，不寫漢字「ご主人さま」**）' },
    extra: [
      '**Liss 第三人稱自稱「莉絲」→ ja「リス」（片假名固定），不要省**',
      '**「主人」→ ja「ごしゅじんさま」（**全平假名！**不寫「ご主人さま」漢字版，TTS 會念錯）**',
      '**「最愛的主人♡」→「だいすきなごしゅじんさま♡」(60-80% 結尾，**完整平假名**)**',
      'zh 結尾「呢 / 喔」→ ja「ですよ / ですね / の」',
      '其他易讀錯詞用平假名：',
      '  - お風呂 → おふろ / お茶 → おちゃ / お湯 → おゆ',
      '  - 大好き → だいすき / 美味しい → おいしい / 可愛い → かわいい',
      '  - 素敵 → すてき / 大丈夫 → だいじょうぶ / 一緒 → いっしょ',
      '  - 時間（4時/7時/9時）特殊讀音 → よじ/しちじ/くじ',
    ],
  },
};

function buildBilingualGlossaryBlock(personaId) {
  const g = BILINGUAL_GLOSSARY[personaId];
  if (!g) return '';
  const lines = [
    '**zh 字幕 ↔ ja 語音對應規則（重要）**',
    '',
    '雙語生成時：',
    '1. **字幕跟語音語意對齊** — 自稱 / 稱呼對方的關鍵詞兩語都要明確帶出（日語省略主語的習慣 → 不適用）',
    '2. **TTS 漢字風險** — ja voice_text 是 GPT-SoVITS 合成，漢字多讀音 / 特殊讀音時會念錯。**易讀錯的詞改用全平假名拼讀**',
    '   - 專有名詞（人名 / 地名）保留：リス、海音、東京⋯⋯',
    '   - 普通名詞 / 動詞 / 形容詞 / 數字小時 → 平假名',
    '',
    `| 概念 | zh 字幕 | ja 語音 |`,
    `|---|---|---|`,
    `| 自稱 | ${g.self.zh} | ${g.self.ja} |`,
    `| 稱呼使用者 | ${g.addressing_user.zh} | ${g.addressing_user.ja} |`,
    '',
    '範例：',
    `- ❌ zh: 「莉絲在這呢，主人」 / ja: 「ここにいますよ」（兩個關鍵詞都丟了）`,
    `- ❌ zh: 「莉絲在這呢，主人」 / ja: 「リスはここですよ、ご主人さま」（漢字「ご主人さま」TTS 可能念錯）`,
    `- ✅ zh: 「莉絲在這呢，主人」 / ja: 「リスはここですよ、ごしゅじんさま」（全平假名）`,
    `- ✅ zh: 「最愛的主人♡」 / ja: 「だいすきなごしゅじんさま♡」（全平假名）`,
    '',
  ];
  for (const note of (g.extra || [])) lines.push(`- ${note}`);
  return lines.join('\n');
}

// 每 category 情境差異化提示 — 讓 LLM 寫不同切入點
const SITUATIONAL_HINTS = {
  app_switch: [
    '**重要：app_switch 不是只有「切走 = 嫉妒」**，要依切到不同 app 寫多樣反應：',
    '- 切到 browser（占 25-30%）：好奇評論「在查什麼？」「資料看不完吧」',
    '- 切到 chat（占 25-30%）：黏膩猜疑「跟誰⋯」「不會比我有趣吧」（thought 多）',
    '- 切到 video（占 20-25%）：輕鬆陪伴「也想一起看～」「推薦給我！」',
    '- 通用切換感（20-25%）：嫉妒、提醒、評論',
  ].join('\n'),
  deep_night: '不要全寫嫉妒類；要混 30% 撒嬌催睡 + 20% 自己睏倦感 + 10% 旁白「（夜深了，海音的眼半閉）」',
  long_idle: '不要全寫「歡迎回來」；要混 35% 撒嬌「等好久」+ 25% 詢問「去哪了」+ 15% 旁白「（角色靜靜等候）」',
  continuous_use: '不要全寫「該休息了」；要混 50% 不同提醒（喝水/伸懶腰/眨眼/起身）+ 25% 撒嬌 + 15% 評論',
  click_character: 'response 變化要大：害羞、欣慰、嗔怪、撒嬌都有；不要每條都「想我了嗎」',
};

function buildClassMixBlock(classMix, n, streakLevel, opts = {}) {
  if (!classMix || typeof classMix !== 'object') return '';
  const entries = Object.entries(classMix).filter(([, v]) => Number.isFinite(v) && v > 0);
  if (entries.length === 0) return '';
  const header = opts.isDefault
    ? `本批 ${n} 句請按以下內容類比例分配（category 預設配比 — 建議遵守，最多 ±5% 偏差）：`
    : `本批 ${n} 句請按以下內容類比例分配：`;
  const lines = [header, ''];
  let total = 0;
  for (const [k, v] of entries) {
    const cnt = Math.round((n * v) / 100);
    total += v;
    const label = CLASS_LABELS[k] || `類別 ${k}`;
    lines.push(`- 類別 ${k}（${label}）：約 ${cnt} 句（${v}%）`);
  }
  if (Math.abs(total - 100) > 0.5) {
    lines.push('', `> 總和 ${total}%（不足 / 超過 100% 沒關係，視為相對權重）`);
  }
  lines.push(
    '',
    '**重要：請真的覆蓋所有列出的類別**。如果某類目前少寫，補進去；不要全部都用 c:2 或 c:1。',
  );
  if (streakLevel) {
    lines.push('', `streak_level：本批指定為 \`${streakLevel}\`（給 click_character 連點互動使用）`);
  }
  return lines.join('\n');
}

function formatInitialSamples(dialoguesInitial, category, persona) {
  const seqs = dialoguesInitial?.categories?.[category]?.sequences || [];
  if (seqs.length === 0) {
    return (persona.voice_samples || []).map((s) => `「${s.replace(/^「|」$/g, '')}」`).join('\n');
  }
  const lines = [];
  for (const seq of seqs) {
    const type = seq.type || 'speech';
    for (const line of seq.lines || []) {
      const expr = line.expression || 'idle';
      lines.push(`[${type}] ${line.text} | expression: ${expr}`);
    }
  }
  return lines.join('\n');
}

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

function buildTaskBlock(pid, category, guide, count) {
  const guides = {
    haiyin: {
      click_too_much: [
        `風格指引：${guide}。`,
        `情境：使用者在短時間內大量點擊（可能在點別的 app / 別的視窗 / 海音被忽略）。`,
        `情緒主軸：吃醋、撒嬌、佔有式關注、輕度抗議。`,
        ``,
        `混合比例建議：`,
        `- 撒嬌吃醋「在點什麼那麼急 / 不要不理我」（30%）`,
        `- 佔有式關注「看看我這邊嘛 / 別點別人」（25%）`,
        `- 內心 OS（thought，「手指又在亂動了⋯⋯」）（20%）`,
        `- 輕度抗議「點得這麼用力做什麼」（15%）`,
        `- 變數嵌入「{usage_hours} 都沒看我」之類（10%）`,
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

  // fallback：若該 category 沒有 hardcoded 配比指引，用 persona.json.trigger_voice_guide
  // guide 字串可能自帶句點，去掉再加固定句點避免「。。」
  const guideClean = (guide || '').replace(/[。．\s]+$/, '');
  const arr = guides[pid]?.[category] || (guideClean ? [`風格指引：${guideClean}。`] : []);
  return [`本次要為 ${pid} / ${category} 觸發情境生成 ${count} 句中文 fallback 台詞。`, '']
    .concat(arr)
    .join('\n');
}

function buildFormatBlock(pid, expressionList, category, opts = {}) {
  const isHaiyin = pid === 'haiyin';
  const isDrag = category === 'drag';
  const isDeepNight = category === 'deep_night';
  const bilingual = opts.bilingual !== false;

  const lines = [
    '每行一句，格式：',
    '',
  ];
  if (bilingual) {
    lines.push(
      '[type] 中文字幕 | expression: <表情標籤> | ja: 日本語の音声テキスト',
      '',
      '**重要：每行必須同時包含中文（給字幕用）跟日語（給語音 TTS 用）**。',
      '中文字數短一點（5-25 字），日語自然口語化（語感優先，不必逐字翻譯）。',
      '可選加 `| c: <類別>`（§6.4 9 類，例如 c:2 自言自語 / c:C 撒嬌）。',
      '',
      '範例（不要照抄）：',
      '```',
      '[speech] 今天的你看起來特別專心呢。 | expression: happy | ja: 今日のあなた、すごく集中してるね。 | c: 2',
      '[thought] （這人到底⋯⋯）| expression: pout | ja: （この人ってば⋯⋯）| c: 1',
      '```',
      '',
      '---',
      '',
      '**互動式 sequence（choice / binary）— 進階使用，視 category 需要才生成**：',
      '',
      '若這個 category 適合做互動（例如 click_character / time_greet / game_enter 的部分句），',
      '可以在生成的句子後緊接著用 JSON 區塊定義 choices / binary。範例：',
      '',
      '```',
      '[speech] 想做什麼？ | expression: happy | ja: 何をしようかな？ | c: 3',
      '@interactive {',
      '  "interaction": "choice",',
      '  "choices": [',
      '    {',
      '      "label": "想抱抱", "label_ja": "抱きしめて",',
      '      "response": { "type": "speech", "expression": "shy",',
      '        "text": "嗯⋯⋯不要在這裡⋯⋯♡", "voice_text": "んん⋯⋯ここではダメ⋯⋯♡" }',
      '    },',
      '    {',
      '      "label": "陪我聊天", "label_ja": "おしゃべりしよ",',
      '      "response": { "type": "speech", "expression": "happy",',
      '        "text": "嗯！來聊吧～", "voice_text": "うん！おしゃべりしよ～" }',
      '    }',
      '  ]',
      '}',
      '```',
      '',
      'binary 範例（兩選一）：',
      '```',
      '[speech] 想我了嗎？ | expression: shy | ja: 私のこと考えてた？ | c: B',
      '@interactive {',
      '  "interaction": "binary",',
      '  "binary": {',
      '    "yes": { "label": "想了", "label_ja": "うん",',
      '             "response": { "type": "speech", "expression": "happy",',
      '               "text": "嘿嘿～這樣才乖。", "voice_text": "えへへ⋯⋯偉い偉い。" } },',
      '    "no":  { "label": "沒呢", "label_ja": "ううん",',
      '             "response": { "type": "speech", "expression": "pout",',
      '               "text": "騙人⋯⋯哼。", "voice_text": "嘘つき⋯⋯ふん。" } }',
      '  }',
      '}',
      '```',
      '',
      '互動式 sequence 每個 category 建議 2-3 條即可（用於營造互動感），其他大多用普通單句。',
      '互動式 sequence 中文字幕 + 日語語音雙語都要有。',
      '',
      '**互動 sequence 主題要分散**：不要每條 binary 都是「嫉妒指控 → yes 清白 / no 有罪」。',
      '混合切入點（嫉妒、體貼、好奇、求關注、提醒）。choice 選項也要分散主題。',
      '',
    );
  } else {
    lines.push('[type] 台詞文字 | expression: <表情標籤>', '');
  }

  // 各 expression 的精準定義（避免 LLM 誤用）
  lines.push(
    '',
    '**Expression 精準定義（請依此選用，不要混淆）**：',
    '- `happy`：純粹開心、欣喜',
    '- `pout`：嘟嘴小抱怨、輕嗔（無敵意）',
    '- `annoyed`：明顯不滿、皺眉',
    '- `embarrassed`：害羞臉紅（不是「無奈接受」 — 那要用 pout）',
    '- `shy`：害羞但內心開心',
    '- `worried`：擔心、體貼',
    '- `idle`：平靜無表情（thought 內心戲多用）',
    '- `sleepy`：睏倦',
    '- `yandere`：黑化、獨佔慾爆發（極少用，30 句最多 1-2 條）',
    '',
  );

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
      lines.push(`- expression 偏 [happy, shy, pout]（被拉害羞 / 開心 / 撒嬌小抱怨）`);
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

function buildNegativeBlock(pid, category) {
  const isHaiyin = pid === 'haiyin';
  const isDrag = category === 'drag';

  const common = [
    '- 不要寫「身為 AI」「作為語言模型」之類自指',
    '- 不要超過 2 句（每個 sequence 最多 2 行 lines）',
  ];

  // P5 補：用詞多樣性 — 避免重複同動詞 / 同句尾
  common.push('- **同一動詞不要重複超過 3 次**（30 句裡同一動作要用不同詞彙描述）');
  common.push('- **同一句尾「呢/啦/呀/喔/欸」不要連續用超過 3 次**，交替使用');
  common.push('- **不要 30 句全圍繞同一主題或情緒**（即使 category 主軸明確，也要從不同切入點寫）');

  const vocabHint = VOCAB_DIVERSITY_HINTS[category];
  if (vocabHint) {
    common.push(`- **${category} 特別注意**：${vocabHint}`);
  }

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

module.exports = {
  buildPrompt,
  formatInitialSamples,
  getCategoryInfo,
  listAllCategoryInfo,
  DEFAULT_CLASS_MIX,
  CATEGORY_INFO,
  CLASS_LABELS,
};
