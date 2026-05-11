// dialogues-merger — 共用合併邏輯（CLI: csv-to-dialogues / UI: 對話庫管理視窗）
//
// 對外 API：
//   parseTxtLines(text, persona, category)   解析 LLM 原始 txt 格式
//   parseCSV(text)                            解析結構化 CSV
//   mergeIntoDialogues({ data, entries, replace, batchTag, now })
//                                             純函式：把 entries 合進 data，返回變動摘要
//   loadDialogues(personaPath)                讀整份 dialogues.json（檔不存在則回 null）
//   saveDialogues(dialoguesPath, data, opts)  寫整份 dialogues.json + 自動 backup
//
// 設計：
//   mergeIntoDialogues 不碰 IO，只動傳入的 data 物件。CLI 跟 UI 各自處理 IO。
//   每個新加 sequence 帶 _meta（schema v2）：created_at / source_batch / weight / edited_at / fire_count_lifetime

const fs = require('node:fs');
const path = require('node:path');

const CAT_SHORT = {
  click_too_much: 'ctm',
  long_idle: 'idle',
  continuous_use: 'cont',
  deep_night: 'night',
  drag: 'drag',
  hourly_chime: 'hour',
};

// LLM 原始格式（單行）：[type] text | k1: v1 | k2: v2 ...
//   支援 key：expression / ja（雙語 voice_text）/ c（content_class）/ streak（streak_level）
//   舊格式 `[speech] text | expression: happy` 仍兼容
const TXT_LINE_HEAD_RE = /^\[(\w+)\]\s+(.+)$/;

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseTxtLines(textInput, persona, category, opts = {}) {
  const onWarn = opts.onWarn || (() => {});
  const entries = [];
  const lines = textInput.split('\n');
  let valid = 0;
  let skipped = 0;
  let warned = 0;
  let lastEntry = null;

  // 互動式 @interactive {...} JSON 區塊累積
  let inBlock = false;
  let blockBraceDepth = 0;
  let blockChunks = [];
  let blockStartLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // ── @interactive JSON 區塊（多行）───
    if (inBlock) {
      blockChunks.push(raw);
      for (const c of raw) {
        if (c === '{') blockBraceDepth++;
        else if (c === '}') {
          blockBraceDepth--;
          if (blockBraceDepth === 0) {
            // 結束 — parse JSON 並附加到 lastEntry
            inBlock = false;
            const jsonText = blockChunks.join('\n').replace(/^\s*@interactive\s*/m, '');
            try {
              const parsed = JSON.parse(jsonText);
              if (lastEntry) {
                if (parsed.interaction) lastEntry.interaction = parsed.interaction;
                if (Array.isArray(parsed.choices)) lastEntry.choices = parsed.choices;
                if (parsed.binary && typeof parsed.binary === 'object') lastEntry.binary = parsed.binary;
              } else {
                onWarn(`line ${blockStartLine + 1}: @interactive 區塊找不到對應的 [type] 句`);
              }
            } catch (err) {
              if (warned < 5) {
                onWarn(`line ${blockStartLine + 1}: @interactive JSON 解析失敗 — ${err.message}`);
                warned++;
              }
              skipped++;
            }
            blockChunks = [];
            break;
          }
        }
      }
      continue;
    }

    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

    // 偵測 @interactive 開頭（同行可能含 `{` 或 `{` 在下一行）
    if (trimmed.startsWith('@interactive')) {
      inBlock = true;
      blockBraceDepth = 0;
      blockChunks = [raw];
      blockStartLine = i;
      for (const c of raw) {
        if (c === '{') blockBraceDepth++;
        else if (c === '}') blockBraceDepth--;
      }
      if (blockBraceDepth === 0 && raw.includes('{')) {
        // 單行內已 self-closed（rare）
        const jsonText = raw.replace(/^\s*@interactive\s*/, '');
        try {
          const parsed = JSON.parse(jsonText);
          if (lastEntry) {
            if (parsed.interaction) lastEntry.interaction = parsed.interaction;
            if (Array.isArray(parsed.choices)) lastEntry.choices = parsed.choices;
            if (parsed.binary && typeof parsed.binary === 'object') lastEntry.binary = parsed.binary;
          }
        } catch (_e) {}
        inBlock = false;
        blockChunks = [];
      }
      continue;
    }

    if (!trimmed.startsWith('[')) {
      skipped++;
      continue;
    }
    const m = trimmed.match(TXT_LINE_HEAD_RE);
    if (!m) {
      if (warned < 5) {
        onWarn(`line ${i + 1}: "${trimmed.slice(0, 60)}..." (找不到 [type] 開頭)`);
        warned++;
      }
      skipped++;
      continue;
    }
    const parts = m[2].split('|').map((s) => s.trim());
    const text = parts[0];
    if (!text) { skipped++; continue; }
    const entry = {
      persona,
      category,
      type: m[1].toLowerCase(),
      text,
      _line: i + 1,
    };
    // 其餘 pipe 段是 key:value
    for (let j = 1; j < parts.length; j++) {
      const kv = parts[j].match(/^(\w+)\s*:\s*(.+)$/);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      const val = kv[2].trim();
      if (key === 'expression') entry.expression = val;
      else if (key === 'ja') { entry.voice_text = val; entry.voice_lang = 'ja'; }
      else if (key === 'voice_text') entry.voice_text = val;
      else if (key === 'voice_lang') entry.voice_lang = val;
      else if (key === 'c' || key === 'cc' || key === 'content_class') entry.content_class = val;
      else if (key === 'streak' || key === 'streak_level') entry.streak_level = val;
      else if (key === 'auto_close_ms') entry.auto_close_ms = val;
      else if (key === 'interaction') entry.interaction = val;
      else if (key === 'persistence') entry.persistence = val;
    }
    entries.push(entry);
    lastEntry = entry;
    valid++;
  }
  if (inBlock) {
    onWarn(`@interactive 區塊未閉合（從 line ${blockStartLine + 1} 開始）`);
    skipped++;
  }
  return { entries, valid, skipped };
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return { entries: [], valid: 0, skipped: 0 };

  const header = parseCsvRow(lines[0]).map((s) => s.toLowerCase());
  const required = ['persona', 'category', 'text'];
  for (const col of required) {
    if (!header.includes(col)) throw new Error(`CSV 缺必要欄位: ${col}`);
  }

  const entries = [];
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvRow(lines[i]);
    if (row.length === 0 || (row.length === 1 && !row[0])) continue;

    const e = {};
    for (let j = 0; j < header.length; j++) {
      const v = (row[j] || '').trim();
      if (v) e[header[j]] = v;
    }
    if (!e.persona || !e.category || !e.text) {
      skipped++;
      continue;
    }
    entries.push(e);
  }
  return { entries, valid: entries.length, skipped };
}

function parseCsvRow(line) {
  const cols = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      cols.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  cols.push(cur);
  return cols;
}

/**
 * 把 entries 合進 data（dialogues.json 結構），返回變動摘要。
 * 不寫檔；呼叫端拿 data 出去自己 saveDialogues。
 *
 * @param {object} params
 * @param {object} params.data           當前 dialogues.json 物件（會被修改）
 * @param {string} params.persona        人格 id
 * @param {Array}  params.entries        merge 候選 (見 parseTxtLines/parseCSV 結果)
 * @param {boolean} [params.replace]     true 清空 category 既有 sequences
 * @param {string} [params.batchTag]     寫進 _meta.source_batch（預設 "manual-edit"）
 * @param {string} [params.now]          ISO timestamp（測試可注入）
 * @returns {{ added: Array<{category, sequenceId}>, replaced: Object }}
 */
function mergeIntoDialogues({ data, persona, entries, replace = false, batchTag = 'manual-edit', now = null }) {
  if (!data.categories) data.categories = {};
  const ts = now || new Date().toISOString();
  const summary = { added: [], byCategory: {} };

  // 按 category 分組（容許 entries 跨多 category 一次合併）
  const byCat = new Map();
  for (const e of entries) {
    if (e.persona && e.persona !== persona) continue; // 防呆：跨 persona 一律跳過
    if (!byCat.has(e.category)) byCat.set(e.category, []);
    byCat.get(e.category).push(e);
  }

  for (const [catName, catList] of byCat) {
    if (!data.categories[catName]) {
      data.categories[catName] = { sequences: [] };
    }
    if (!Array.isArray(data.categories[catName].sequences)) {
      data.categories[catName].sequences = [];
    }
    const existing = data.categories[catName].sequences;

    let removed = 0;
    if (replace) {
      // 只清非 initial 的（保留 source_batch="initial" 的鎖定句）
      const kept = existing.filter((s) => s._meta?.source_batch === 'initial');
      removed = existing.length - kept.length;
      data.categories[catName].sequences = kept;
    }

    const catShort = CAT_SHORT[catName] || catName.slice(0, 4);
    const idPattern = new RegExp(`^${escapeRe(persona)}_${escapeRe(catShort)}_(\\d+)$`);
    let maxNum = 0;
    for (const seq of data.categories[catName].sequences) {
      const m = seq.sequenceId?.match(idPattern);
      if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    }

    const added = [];
    for (const e of catList) {
      maxNum++;
      const sequenceId = `${persona}_${catShort}_${String(maxNum).padStart(3, '0')}`;

      const sequence = {
        sequenceId,
        type: e.type || 'speech',
      };
      if (e.interaction) sequence.interaction = e.interaction;
      if (e.persistence) sequence.persistence = e.persistence;
      if (e.auto_close_ms) {
        const ms = parseInt(e.auto_close_ms, 10);
        if (Number.isFinite(ms)) sequence.auto_close_ms = ms;
      }
      const line = {
        text: e.text,
        ...(e.expression ? { expression: e.expression } : {}),
      };
      // 雙語架構：voice_text / voice_lang 寫進 line（缺則 fallback line.text + persona default）
      if (e.voice_text) line.voice_text = e.voice_text;
      if (e.voice_lang) line.voice_lang = e.voice_lang;
      sequence.lines = [line];

      // 互動式 sequence：choices / binary 從 entry 寫進 sequence
      if (Array.isArray(e.choices) && e.choices.length > 0) sequence.choices = e.choices;
      if (e.binary && typeof e.binary === 'object' && Object.keys(e.binary).length > 0) sequence.binary = e.binary;

      sequence._meta = {
        created_at: ts,
        source_batch: batchTag,
        weight: 1,
        edited_at: null,
        fire_count_lifetime: 0,
      };
      if (e.content_class) sequence._meta.content_class = e.content_class;
      if (e.streak_level) sequence._meta.streak_level = e.streak_level;

      data.categories[catName].sequences.push(sequence);
      added.push(sequenceId);
    }

    summary.added.push(...added.map((id) => ({ category: catName, sequenceId: id })));
    summary.byCategory[catName] = {
      added: added.length,
      replaced: removed,
      first: added[0] || null,
      last: added[added.length - 1] || null,
      total: data.categories[catName].sequences.length,
    };
  }

  return summary;
}

async function loadDialogues(dialoguesPath) {
  try {
    const text = await fs.promises.readFile(dialoguesPath, 'utf-8');
    return JSON.parse(text);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function saveDialogues(dialoguesPath, data, opts = {}) {
  const { backup = true } = opts;
  await fs.promises.mkdir(path.dirname(dialoguesPath), { recursive: true });

  if (backup) {
    try {
      await fs.promises.access(dialoguesPath);
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const bakPath = `${dialoguesPath}.bak.${ts}`;
      await fs.promises.copyFile(dialoguesPath, bakPath);
    } catch (_e) {
      // 原檔不存在，不需 backup
    }
  }

  const tmp = `${dialoguesPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await fs.promises.rename(tmp, dialoguesPath);
}

module.exports = {
  parseTxtLines,
  parseCSV,
  mergeIntoDialogues,
  loadDialogues,
  saveDialogues,
  CAT_SHORT,
};
