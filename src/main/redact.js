// redact.js — 隱私敏感字串遮罩
//
// 純函式、無副作用，由 EventLogger 在寫檔前呼叫。
// 規則來源：技術規格.md §6.2 + 隱私分析.md §八建議補強。
//
// 自用情境下視窗標題仍記錄完整字串，但這份 redact 處理 email / URL /
// 卡號 / IBAN / 護照 / 身分證等高敏類別，避免 events JSONL 不慎外流時直接洩漏。

const REDACTED = '[REDACTED]';

const PATTERNS = [
  { name: 'email',      re: /\b[\w.-]+@[\w.-]+\.\w{2,}\b/g },
  { name: 'url',        re: /\bhttps?:\/\/\S+/gi },
  { name: 'creditCard', re: /\b(?:\d{4}[\s-]?){3}\d{4}\b/g },
  { name: 'iban',       re: /\b[A-Z]{2}\d{2}[A-Z0-9]{4,30}\b/g },
  { name: 'passport',   re: /\b[A-Z]\d{9}\b/g },
  { name: 'twId',       re: /\b[A-Z]\d{8}\b/g },
];

function redactSensitive(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const p of PATTERNS) {
    out = out.replace(p.re, REDACTED);
  }
  return out;
}

function inspectMatches(text) {
  const matches = [];
  if (typeof text !== 'string' || text.length === 0) return matches;
  for (const p of PATTERNS) {
    const m = text.match(p.re);
    if (m && m.length > 0) matches.push({ name: p.name, count: m.length });
  }
  return matches;
}

function redactObjectStrings(obj, fieldNames) {
  if (!obj || typeof obj !== 'object') return obj;
  const result = Array.isArray(obj) ? [...obj] : { ...obj };
  for (const f of fieldNames) {
    if (typeof result[f] === 'string') {
      result[f] = redactSensitive(result[f]);
    }
  }
  return result;
}

module.exports = { redactSensitive, inspectMatches, redactObjectStrings, REDACTED };
