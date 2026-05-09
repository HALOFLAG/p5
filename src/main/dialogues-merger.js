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
};

// LLM 原始格式：[type] text | expression: xxx
const TXT_LINE_RE = /^\[(\w+)\]\s+(.+?)\s*\|\s*expression:\s*(\w+)\s*$/;

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseTxtLines(text, persona, category, opts = {}) {
  const onWarn = opts.onWarn || (() => {});
  const entries = [];
  const lines = text.split('\n');
  let valid = 0;
  let skipped = 0;
  let warned = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    if (raw.startsWith('#') || raw.startsWith('//')) continue;
    if (!raw.startsWith('[') || !raw.includes('|')) {
      skipped++;
      continue;
    }
    const m = raw.match(TXT_LINE_RE);
    if (!m) {
      if (warned < 5) {
        onWarn(`line ${i + 1}: "${raw.slice(0, 60)}..."`);
        warned++;
      }
      skipped++;
      continue;
    }
    entries.push({
      persona,
      category,
      type: m[1].toLowerCase(),
      text: m[2].trim(),
      expression: m[3].trim(),
      _line: i + 1,
    });
    valid++;
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
      if (e.auto_close_ms) {
        const ms = parseInt(e.auto_close_ms, 10);
        if (Number.isFinite(ms)) sequence.auto_close_ms = ms;
      }
      sequence.lines = [{
        text: e.text,
        ...(e.expression ? { expression: e.expression } : {}),
      }];
      sequence._meta = {
        created_at: ts,
        source_batch: batchTag,
        weight: 1,
        edited_at: null,
        fire_count_lifetime: 0,
      };

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
