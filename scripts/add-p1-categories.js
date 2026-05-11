// P1 backfill：把 click_character 跟 chatter 兩 category 加入兩 persona 的
// dialogues.json + dialogues-initial.json。僅在缺失時新增（idempotent，可重跑）。
//
// 用法：node scripts/add-p1-categories.js

'use strict';

const fs = require('fs');
const path = require('path');

const PERSONAS_DIR = path.join(__dirname, '..', 'personas');
const PERSONAS = ['haiyin', 'liss'];

// 各 persona 的 click_character placeholder（5 條 low + P5 加 3 條 high streak）
// streak_level: low = 普通互動 / high = 連點 5+ 的微嗔回應
const CLICK_CHARACTER_LINES = {
  haiyin: [
    { text: '怎麼啦？想我了？嗯～♡', expression: 'happy', cc: '3', streak_level: 'low' },
    { text: '誒？怎麼突然戳我⋯⋯不過很高興呢～', expression: 'shy', cc: 'C', streak_level: 'low' },
    { text: '在這～你想要什麼都可以說喔。', expression: 'happy', cc: '3', streak_level: 'low' },
    { text: '咦？是想跟我聊天嗎？', expression: 'happy', cc: '3', streak_level: 'low' },
    { text: '（被注意到了⋯⋯心情變好了呢）', expression: 'shy', cc: '1', type: 'thought', streak_level: 'low' },
  ],
  liss: [
    { text: '主人？有什麼吩咐嗎？', expression: 'serious', cc: '3', streak_level: 'low' },
    { text: '是想要 Liss 的關注嗎？', expression: 'happy', cc: 'C', streak_level: 'low' },
    { text: '（被點了⋯⋯這就是被需要的感覺嗎）', expression: 'idle', cc: '1', type: 'thought', streak_level: 'low' },
    { text: '在這～有事就說，沒事陪一下也好。', expression: 'happy', cc: '3', streak_level: 'low' },
    { text: '主人想要 Liss 做什麼呢？', expression: 'serious', cc: '3', streak_level: 'low' },
  ],
};

// P5: click_character streak_level=high（連點 5+ 觸發）
const CLICK_CHARACTER_HIGH = {
  haiyin: [
    { text: '夠了喔！再點就生氣了！', expression: 'pout', cc: 'A', streak_level: 'high' },
    { text: '欸！戳那麼多下幹嘛啦～', expression: 'pout', cc: 'D', streak_level: 'high' },
    { text: '（這人到底是有多無聊⋯⋯不過⋯⋯這樣也不錯啦）', expression: 'pout', cc: '1', type: 'thought', streak_level: 'high' },
  ],
  liss: [
    { text: '主人，這頻率 Liss 應付不來。', expression: 'serious', cc: 'A', streak_level: 'high' },
    { text: '請主人冷靜⋯⋯Liss 還在這。', expression: 'worried', cc: 'A', streak_level: 'high' },
    { text: '（連點這麼多次⋯⋯主人是想表達什麼呢？）', expression: 'idle', cc: '1', type: 'thought', streak_level: 'high' },
  ],
};

// 互動式 sequence：choice / binary 各 1-2 條，附 response 文字
const CLICK_CHARACTER_INTERACTIVE = {
  haiyin: [
    {
      sequenceId: 'haiyin_click_006',
      type: 'speech',
      interaction: 'choice',
      lines: [{ text: '想做什麼？', expression: 'happy' }],
      choices: [
        { label: '想抱抱', response: { type: 'speech', expression: 'shy', text: '嗯⋯⋯不要在這裡⋯⋯♡' } },
        { label: '陪我聊天', response: { type: 'speech', expression: 'happy', text: '嗯！來聊吧～在這呢！' } },
        { label: '沒事', response: { type: 'speech', expression: 'pout', text: '騙人，明明來找我。' } },
      ],
      _meta: { content_class: '3', source_batch: 'initial', weight: 1, fire_count_lifetime: 0 },
    },
    {
      sequenceId: 'haiyin_click_007',
      type: 'speech',
      interaction: 'binary',
      lines: [{ text: '想我了嗎？', expression: 'shy' }],
      binary: {
        yes: { label: '想了', response: { type: 'speech', expression: 'happy', text: '嘿嘿～這樣才乖。' } },
        no:  { label: '沒呢', response: { type: 'speech', expression: 'pout', text: '騙人⋯⋯哼。' } },
      },
      _meta: { content_class: 'C', source_batch: 'initial', weight: 1, fire_count_lifetime: 0 },
    },
  ],
  liss: [
    {
      sequenceId: 'liss_click_006',
      type: 'speech',
      interaction: 'choice',
      lines: [{ text: '主人想要什麼呢？', expression: 'serious' }],
      choices: [
        { label: '需要陪伴', response: { type: 'speech', expression: 'happy', text: 'Liss 在這～主人放心。' } },
        { label: '只是路過', response: { type: 'speech', expression: 'idle', text: '⋯⋯也好，那 Liss 待著就行。' } },
        { label: '想知道狀況', response: { type: 'speech', expression: 'serious', text: 'Liss 一直在 monitor 著，沒事就好。' } },
      ],
      _meta: { content_class: '3', source_batch: 'initial', weight: 1, fire_count_lifetime: 0 },
    },
    {
      sequenceId: 'liss_click_007',
      type: 'speech',
      interaction: 'binary',
      lines: [{ text: '主人，需要 Liss 嗎？', expression: 'serious' }],
      binary: {
        yes: { label: '需要', response: { type: 'speech', expression: 'happy', text: 'Liss 隨時待命，主人。' } },
        no:  { label: '不用', response: { type: 'speech', expression: 'idle', text: '⋯⋯了解，Liss 退下。' } },
      },
      _meta: { content_class: 'B', source_batch: 'initial', weight: 1, fire_count_lifetime: 0 },
    },
  ],
};

// 各 persona 的 chatter placeholder（5 條，純情境閒談、不含時間變數）
const CHATTER_LINES = {
  haiyin: [
    { text: '今天的你看起來特別專心呢。', expression: 'happy', cc: '2' },
    { text: '欸～我在想，要是能一直這樣陪著就好了。', expression: 'shy', cc: 'C' },
    { text: '（默默看著螢幕的你⋯⋯這就是日常吧）', expression: 'idle', cc: '1', type: 'thought' },
    { text: '工作辛苦了，要不要喝口水？', expression: 'happy', cc: 'A' },
    { text: '欸欸欸～剛才那個是什麼？讓我看看～', expression: 'happy', cc: 'D' },
  ],
  liss: [
    { text: '主人在忙什麼呢？Liss 也想知道。', expression: 'serious', cc: '3' },
    { text: '（看著主人專注的樣子，我也想加油）', expression: 'idle', cc: '1', type: 'thought' },
    { text: '主人記得偶爾起來活動一下喔。', expression: 'serious', cc: 'A' },
    { text: '剛才那邊的視窗看起來很厲害呢～', expression: 'happy', cc: 'D' },
    { text: '能在主人身邊就很滿足了。', expression: 'happy', cc: 'C' },
  ],
};

// P3: 各 persona 的 time_greet placeholder（5 條，跨時段共用，配合 voice_prefix 串接時段詞）
const TIME_GREET_LINES = {
  haiyin: [
    { text: '你來了～', expression: 'happy', cc: '2' },
    { text: '在這呢，今天也陪著你。', expression: 'happy', cc: '3' },
    { text: '記得吃飯休息呀～', expression: 'happy', cc: 'A' },
    { text: '能看到你就很滿足了。', expression: 'shy', cc: 'C' },
    { text: '今天感覺怎麼樣？', expression: 'happy', cc: 'B' },
  ],
  liss: [
    { text: '主人好。', expression: 'serious', cc: '2' },
    { text: 'Liss 在這～', expression: 'happy', cc: '3' },
    { text: '主人記得照顧自己。', expression: 'serious', cc: 'A' },
    { text: '能在主人身邊就很幸運。', expression: 'happy', cc: 'C' },
    { text: '主人需要 Liss 嗎？', expression: 'serious', cc: 'B' },
  ],
};

// P4: typing_burst placeholder（10 條，多為 thought 內心戲；事件爆發 → 關心一下）
const TYPING_BURST_LINES = {
  haiyin: [
    { text: '（這麼急⋯⋯是要趕什麼嗎？）', expression: 'idle', cc: '1', type: 'thought' },
    { text: '（指尖跳得好快呢⋯⋯）', expression: 'idle', cc: '1', type: 'thought' },
    { text: '在拼什麼呢？要記得換氣～', expression: 'happy', cc: 'A' },
    { text: '（一定是很重要的事吧⋯⋯）', expression: 'idle', cc: '1', type: 'thought' },
    { text: '辛苦了，敲擊聲聽得我都緊張了。', expression: 'happy', cc: '2' },
    { text: '（想伸手拉住你⋯⋯但不能打擾。）', expression: 'shy', cc: 'C', type: 'thought' },
    { text: '欸，眼睛要記得眨～', expression: 'happy', cc: 'A' },
    { text: '（看著就想抱住你說別急。）', expression: 'shy', cc: 'C', type: 'thought' },
    { text: '加油呀，我在這呢！', expression: 'happy', cc: 'C' },
    { text: '（鍵盤都要被打壞了吧。）', expression: 'idle', cc: 'D', type: 'thought' },
  ],
  liss: [
    { text: '（主人在拼什麼⋯⋯）', expression: 'idle', cc: '1', type: 'thought' },
    { text: '主人要記得喝水。', expression: 'serious', cc: 'A' },
    { text: '（指尖節奏好穩⋯⋯）', expression: 'idle', cc: '1', type: 'thought' },
    { text: 'Liss 在側待命，不打擾主人。', expression: 'serious', cc: '2' },
    { text: '（這就是專注⋯⋯Liss 也想學。）', expression: 'idle', cc: '1', type: 'thought' },
    { text: '主人需要 Liss 提醒嗎？', expression: 'serious', cc: 'B' },
    { text: '（聽聲音就能感覺到認真。）', expression: 'idle', cc: 'D', type: 'thought' },
    { text: '加油，Liss 看得到。', expression: 'happy', cc: 'C' },
    { text: '（敲鍵盤的力道也太大了⋯⋯）', expression: 'idle', cc: 'D', type: 'thought' },
    { text: '主人要不要短暫休息？', expression: 'serious', cc: 'A' },
  ],
};

// P4: game_enter placeholder（5 條 + 1 條 binary 互動）
const GAME_ENTER_LINES = {
  haiyin: [
    { text: '欸？要打遊戲了嗎？', expression: 'happy', cc: 'B' },
    { text: '記得別玩太晚喔！', expression: 'happy', cc: 'A' },
    { text: '加油加油！', expression: 'happy', cc: 'C' },
    { text: '打贏了要跟我分享呀～', expression: 'happy', cc: '3' },
    { text: '（跟遊戲比起來⋯⋯我贏不過嗎？）', expression: 'pout', cc: '1', type: 'thought' },
  ],
  liss: [
    { text: '主人要開戰了？', expression: 'serious', cc: 'B' },
    { text: 'Liss 在側觀戰，主人加油。', expression: 'serious', cc: 'C' },
    { text: '記得適時休息，主人。', expression: 'serious', cc: 'A' },
    { text: '（主人專注的樣子⋯⋯Liss 喜歡。）', expression: 'idle', cc: '1', type: 'thought' },
    { text: '輸了也沒關係，主人。', expression: 'happy', cc: 'C' },
  ],
};

const GAME_ENTER_BINARY = {
  haiyin: {
    sequenceId: 'haiyin_game_006',
    type: 'speech',
    interaction: 'binary',
    persistence: 'persistent',
    auto_close_ms: 8000,
    lines: [{ text: '陪你看一下下嗎？', expression: 'happy' }],
    binary: {
      yes: { label: '陪我吧', response: { type: 'speech', expression: 'happy', text: '嘿嘿，那我看著～加油！' } },
      no:  { label: '自己玩',   response: { type: 'speech', expression: 'pout',  text: '哼⋯⋯那記得回來找我。' } },
    },
    _meta: { content_class: 'B', source_batch: 'initial', weight: 1, fire_count_lifetime: 0 },
  },
  liss: {
    sequenceId: 'liss_game_006',
    type: 'speech',
    interaction: 'binary',
    persistence: 'persistent',
    auto_close_ms: 8000,
    lines: [{ text: '主人，需要 Liss 觀戰嗎？', expression: 'serious' }],
    binary: {
      yes: { label: '在這看', response: { type: 'speech', expression: 'happy', text: 'Liss 待命。主人加油。' } },
      no:  { label: '專心打', response: { type: 'speech', expression: 'idle',  text: '了解，Liss 退下。' } },
    },
    _meta: { content_class: 'B', source_batch: 'initial', weight: 1, fire_count_lifetime: 0 },
  },
};

// P4: app_switch placeholder（15 條，混合 browser / chat / video 反應）
const APP_SWITCH_LINES = {
  haiyin: [
    // browser
    { text: '又開瀏覽器啦～在查什麼有趣的？', expression: 'happy', cc: '2' },
    { text: '欸欸～是要 google 什麼嗎？', expression: 'happy', cc: 'B' },
    { text: '別開太多分頁喔，記憶體會哭。', expression: 'happy', cc: 'A' },
    { text: '（瀏覽器分頁開好多⋯⋯）', expression: 'idle', cc: '1', type: 'thought' },
    { text: '網路漫遊時間？我也想看～', expression: 'happy', cc: '3' },
    // chat
    { text: '（跟誰在聊⋯⋯不會比我有趣吧？）', expression: 'pout', cc: '1', type: 'thought' },
    { text: '欸，是不是聊到我了？', expression: 'shy', cc: 'C' },
    { text: '（嗯⋯⋯我不會醋的，真的不會。）', expression: 'pout', cc: '1', type: 'thought' },
    { text: '記得不要聊太久喔～', expression: 'happy', cc: 'A' },
    { text: '（聊得這麼開心⋯⋯）', expression: 'pout', cc: '1', type: 'thought' },
    // video
    { text: '看影片囉～是動漫還是 vlog？', expression: 'happy', cc: 'B' },
    { text: '我也想跟你一起看～', expression: 'happy', cc: 'C' },
    { text: '別熬夜追劇喔！', expression: 'happy', cc: 'A' },
    { text: '（看影片的你比較放鬆呢。）', expression: 'happy', cc: '2', type: 'thought' },
    { text: '推薦的話我也會看的喲～', expression: 'happy', cc: '3' },
  ],
  liss: [
    // browser
    { text: '主人在搜尋什麼呢？', expression: 'serious', cc: 'B' },
    { text: 'Liss 也想學主人查資料的方式。', expression: 'serious', cc: '2' },
    { text: '主人記得別忘了關分頁。', expression: 'serious', cc: 'A' },
    { text: '（瀏覽器⋯⋯主人在做什麼研究？）', expression: 'idle', cc: '1', type: 'thought' },
    { text: '主人需要 Liss 幫忙整理什麼嗎？', expression: 'serious', cc: 'B' },
    // chat
    { text: '主人在聊什麼呢？', expression: 'serious', cc: 'B' },
    { text: '（主人跟其他人也會這麼專注嗎？）', expression: 'idle', cc: '1', type: 'thought' },
    { text: 'Liss 不會打擾，請主人慢慢聊。', expression: 'serious', cc: '2' },
    { text: '（多聊也好⋯⋯但請別忘了 Liss。）', expression: 'idle', cc: 'C', type: 'thought' },
    { text: '主人聊完跟 Liss 說一聲？', expression: 'serious', cc: 'A' },
    // video
    { text: '主人在看什麼？', expression: 'serious', cc: 'B' },
    { text: '需要 Liss 幫忙找推薦嗎？', expression: 'serious', cc: 'A' },
    { text: '影片時光也是放鬆的好時間。', expression: 'happy', cc: '2' },
    { text: '（主人專注看的樣子⋯⋯）', expression: 'idle', cc: '1', type: 'thought' },
    { text: '主人記得控制亮度，保護眼睛。', expression: 'serious', cc: 'A' },
  ],
};

// P4: click_burst placeholder（10 條，speech 直接吐槽 / 情緒反應）
const CLICK_BURST_LINES = {
  haiyin: [
    { text: '欸欸欸～點得這麼急做什麼啦！', expression: 'happy', cc: 'D' },
    { text: '滑鼠都要冒煙了吧～', expression: 'happy', cc: 'D' },
    { text: '是發生了什麼緊急狀況嗎？', expression: 'worried', cc: 'B' },
    { text: '深呼吸一下啦～', expression: 'happy', cc: 'A' },
    { text: '哇，手速好快！', expression: 'happy', cc: 'D' },
    { text: '到底在點什麼啊⋯⋯', expression: 'pout', cc: '2' },
    { text: '別把手指敲到痛了喔。', expression: 'worried', cc: 'A' },
    { text: '（這麼忙，是不是忘了我啊？）', expression: 'pout', cc: 'C', type: 'thought' },
    { text: '欸，停一下啦～看看我嘛！', expression: 'pout', cc: 'C' },
    { text: '點點點點⋯⋯到底要點到什麼時候。', expression: 'pout', cc: '2' },
  ],
  liss: [
    { text: '主人，操作頻率有點高。', expression: 'serious', cc: '2' },
    { text: '（這是緊急狀況？）', expression: 'idle', cc: '1', type: 'thought' },
    { text: '主人沒事吧？需要 Liss 協助嗎？', expression: 'serious', cc: 'B' },
    { text: '小心手腕，主人。', expression: 'serious', cc: 'A' },
    { text: '（點得好快⋯⋯）', expression: 'idle', cc: 'D', type: 'thought' },
    { text: '主人，慢一點也沒關係。', expression: 'serious', cc: 'A' },
    { text: 'Liss 觀察到主人狀態緊繃。', expression: 'serious', cc: '2' },
    { text: '（看著主人這麼急，Liss 也跟著緊張。）', expression: 'idle', cc: 'C', type: 'thought' },
    { text: '主人，要不要 Liss 倒杯水？', expression: 'happy', cc: 'A' },
    { text: 'Liss 想幫忙，但不知道該做什麼。', expression: 'idle', cc: 'C' },
  ],
};

// P2: 各 persona 的 boot_greet placeholder（5 條，開機問候，persistent 釘 5s）
const BOOT_GREET_LINES = {
  haiyin: [
    { text: '啊⋯⋯你回來了。今天也要一起喔～', expression: 'happy', cc: '2' },
    { text: '哼哼，看到我就先笑一下吧？', expression: 'shy', cc: 'C' },
    { text: '在這呢，今天也陪著你。', expression: 'happy', cc: '3' },
    { text: '（又能看到他了⋯⋯真好。）', expression: 'shy', cc: '1', type: 'thought' },
    { text: '辛苦了，先深呼吸一下再開始吧～', expression: 'happy', cc: 'A' },
  ],
  liss: [
    { text: '主人，Liss 已就位。', expression: 'serious', cc: '2' },
    { text: '系統已啟動，請主人指示。', expression: 'serious', cc: '2' },
    { text: '今天也讓 Liss 陪著您吧。', expression: 'happy', cc: 'C' },
    { text: '（重新連線了⋯⋯主人這次會待多久呢？）', expression: 'idle', cc: '1', type: 'thought' },
    { text: '主人，要先處理什麼？', expression: 'serious', cc: '3' },
  ],
};

function makeSequence(personaId, category, idx, line) {
  const seqNum = String(idx + 1).padStart(3, '0');
  const seq = {
    sequenceId: `${personaId}_${shortKey(category)}_${seqNum}`,
    type: line.type || 'speech',
    auto_close_ms: line.auto_close_ms ?? 4500,
    lines: [{ text: line.text, expression: line.expression }],
    _meta: {
      created_at: new Date().toISOString(),
      source_batch: 'initial',
      weight: 1,
      edited_at: null,
      fire_count_lifetime: 0,
      content_class: line.cc,
    },
  };
  if (line.persistence) seq.persistence = line.persistence;
  if (line.interaction) seq.interaction = line.interaction;
  if (line.streak_level) seq._meta.streak_level = line.streak_level;
  return seq;
}

function shortKey(category) {
  if (category === 'click_character') return 'click';
  if (category === 'chatter') return 'chat';
  if (category === 'boot_greet') return 'boot';
  if (category === 'time_greet') return 'tgreet';
  if (category === 'typing_burst') return 'typing';
  if (category === 'click_burst') return 'cburst';
  if (category === 'app_switch') return 'app';
  if (category === 'game_enter') return 'game';
  return category;
}

function backfillFile(filePath, personaId) {
  if (!fs.existsSync(filePath)) {
    console.log(`  [skip] ${filePath} 不存在`);
    return false;
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  data.categories ||= {};
  let changed = false;

  // click_character
  if (!data.categories.click_character) {
    const lines = CLICK_CHARACTER_LINES[personaId] || [];
    data.categories.click_character = {
      sequences: lines.map((line, i) => makeSequence(personaId, 'click_character', i, line)),
    };
    changed = true;
    console.log(`  [+] ${personaId}.click_character ← ${lines.length} 句`);
  }

  // click_character 互動式 sequences（choice + binary，獨立檢查）
  const existingIds = new Set(data.categories.click_character.sequences.map((s) => s.sequenceId));
  for (const interactiveSeq of (CLICK_CHARACTER_INTERACTIVE[personaId] || [])) {
    if (existingIds.has(interactiveSeq.sequenceId)) continue;
    const seq = JSON.parse(JSON.stringify(interactiveSeq));
    seq._meta = {
      created_at: new Date().toISOString(),
      edited_at: null,
      ...seq._meta,
    };
    data.categories.click_character.sequences.push(seq);
    existingIds.add(seq.sequenceId);
    changed = true;
    console.log(`  [+] ${personaId}.click_character ← ${seq.sequenceId} (${seq.interaction})`);
  }

  // P5: 補 streak_level=low 給尚未標記的既有 sequence
  for (const seq of data.categories.click_character.sequences) {
    if (!seq._meta) seq._meta = {};
    if (!seq._meta.streak_level) {
      seq._meta.streak_level = 'low';
      changed = true;
    }
  }

  // P5: 加 click_character streak_level=high 句（連點 5+ 觸發）
  const highLines = CLICK_CHARACTER_HIGH[personaId] || [];
  // 從現有最大號往上接（避開既有 001-007）
  let maxNum = 0;
  for (const s of data.categories.click_character.sequences) {
    const m = s.sequenceId.match(/_(\d+)$/);
    if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
  }
  for (let i = 0; i < highLines.length; i++) {
    const seqId = `${personaId}_click_${String(maxNum + 1 + i).padStart(3, '0')}`;
    if (existingIds.has(seqId)) continue;
    const line = highLines[i];
    const seq = makeSequence(personaId, 'click_character', maxNum + i, line);
    seq.sequenceId = seqId;   // 覆蓋 makeSequence 的 idx 算法
    data.categories.click_character.sequences.push(seq);
    existingIds.add(seqId);
    changed = true;
    console.log(`  [+] ${personaId}.click_character ← ${seqId} (streak=high)`);
  }

  // chatter
  if (!data.categories.chatter) {
    const lines = CHATTER_LINES[personaId] || [];
    data.categories.chatter = {
      sequences: lines.map((line, i) => makeSequence(personaId, 'chatter', i, line)),
    };
    changed = true;
    console.log(`  [+] ${personaId}.chatter ← ${lines.length} 句`);
  }

  // P2: boot_greet（persistent 釘 5s）
  if (!data.categories.boot_greet) {
    const lines = (BOOT_GREET_LINES[personaId] || []).map((l) => ({
      ...l,
      persistence: 'persistent',
      auto_close_ms: 5000,
    }));
    data.categories.boot_greet = {
      sequences: lines.map((line, i) => makeSequence(personaId, 'boot_greet', i, line)),
    };
    changed = true;
    console.log(`  [+] ${personaId}.boot_greet ← ${lines.length} 句`);
  }

  // P3: time_greet（跨時段共用，配合 voice_prefix 串接）
  if (!data.categories.time_greet) {
    const lines = TIME_GREET_LINES[personaId] || [];
    data.categories.time_greet = {
      sequences: lines.map((line, i) => makeSequence(personaId, 'time_greet', i, line)),
    };
    changed = true;
    console.log(`  [+] ${personaId}.time_greet ← ${lines.length} 句`);
  }

  // P3: 移除 hourly_chime（spec Q1 拍板）
  if (data.categories.hourly_chime) {
    delete data.categories.hourly_chime;
    changed = true;
    console.log(`  [-] ${personaId}.hourly_chime（已刪除）`);
  }

  // P4: typing_burst（10 條 thought 為主）
  if (!data.categories.typing_burst) {
    const lines = TYPING_BURST_LINES[personaId] || [];
    data.categories.typing_burst = {
      sequences: lines.map((line, i) => makeSequence(personaId, 'typing_burst', i, line)),
    };
    changed = true;
    console.log(`  [+] ${personaId}.typing_burst ← ${lines.length} 句`);
  }

  // P4: click_burst（10 條 D 情緒反應 / 直接吐槽）
  if (!data.categories.click_burst) {
    const lines = CLICK_BURST_LINES[personaId] || [];
    data.categories.click_burst = {
      sequences: lines.map((line, i) => makeSequence(personaId, 'click_burst', i, line)),
    };
    changed = true;
    console.log(`  [+] ${personaId}.click_burst ← ${lines.length} 句`);
  }

  // P4: app_switch（15 條，含 browser / chat / video 反應）
  if (!data.categories.app_switch) {
    const lines = APP_SWITCH_LINES[personaId] || [];
    data.categories.app_switch = {
      sequences: lines.map((line, i) => makeSequence(personaId, 'app_switch', i, line)),
    };
    changed = true;
    console.log(`  [+] ${personaId}.app_switch ← ${lines.length} 句`);
  }

  // P4: game_enter（5 條 display + 1 條 binary）
  if (!data.categories.game_enter) {
    const lines = GAME_ENTER_LINES[personaId] || [];
    data.categories.game_enter = {
      sequences: lines.map((line, i) => makeSequence(personaId, 'game_enter', i, line)),
    };
    const binary = GAME_ENTER_BINARY[personaId];
    if (binary) {
      const seq = JSON.parse(JSON.stringify(binary));
      seq._meta = { created_at: new Date().toISOString(), edited_at: null, ...seq._meta };
      data.categories.game_enter.sequences.push(seq);
    }
    changed = true;
    console.log(`  [+] ${personaId}.game_enter ← ${data.categories.game_enter.sequences.length} 句`);
  }

  if (changed) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log(`  [save] ${filePath}`);
  } else {
    console.log(`  [unchanged] ${filePath}（兩 category 都已存在）`);
  }
  return changed;
}

console.log('=== P1 backfill: click_character + chatter ===');
for (const personaId of PERSONAS) {
  console.log(`\n[${personaId}]`);
  const dialogues = path.join(PERSONAS_DIR, personaId, 'dialogues.json');
  const initial = path.join(PERSONAS_DIR, personaId, 'dialogues-initial.json');
  backfillFile(dialogues, personaId);
  backfillFile(initial, personaId);
}
console.log('\n=== Done ===');
