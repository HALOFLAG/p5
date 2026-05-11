// 時間語音內容字典（P3）
//
// 預設文字 — 提供「自然中文聽起來像話」的版本。使用者之後可在
// voices-time/<lang>/manifest.json.entries[key].text 客製覆寫。
//
// 24 小時 + 4 時段詞 = 28 條 wav per persona per lang。

'use strict';

// 中文自然發音版（重點：兩 vs 二、時段前綴）
const ZH_HOURS = [
  '凌晨零點',   '凌晨一點',   '凌晨兩點',   '凌晨三點',
  '凌晨四點',   '清晨五點',   '清晨六點',   '早上七點',
  '早上八點',   '早上九點',   '早上十點',   '早上十一點',
  '中午十二點', '下午一點',   '下午兩點',   '下午三點',
  '下午四點',   '下午五點',   '晚上六點',   '晚上七點',
  '晚上八點',   '晚上九點',   '晚上十點',   '深夜十一點',
];

const ZH_PERIODS = {
  morning: '早安',
  lunch: '中午了',
  evening: '晚上好',
  night: '晚安',
};

// 日文版（給 ja 語音用）— 全平假名 + 「[時段][數字]じです」完整句子格式
// 原則：避免 GPT-SoVITS TTS 對漢字多讀音念錯（特別 4時=よじ / 7時=しちじ / 9時=くじ）
// 完整句子（"...です"結尾）給 TTS 足夠 context，發音穩定不會吃字
const JA_HOURS = [
  'しんやれいじです',         'しんやいちじです',         'しんやにじです',           'しんやさんじです',
  'そうちょうよじです',       'そうちょうごじです',       'あさろくじです',           'あさしちじです',
  'あさはちじです',           'あさくじです',             'あさじゅうじです',         'あさじゅういちじです',
  'しょうごです',             'ごごいちじです',           'ごごにじです',             'ごごさんじです',
  'ごごよじです',             'ゆうがたごじです',         'ゆうがたろくじです',       'よるしちじです',
  'よるはちじです',           'よるくじです',             'よるじゅうじです',         'しんやじゅういちじです',
];

const JA_PERIODS = {
  morning: 'おはようございます',
  lunch:   'おひるごはんのじかんです',
  evening: 'こんばんは',
  night:   'おやすみなさい',
};

// 英文版（很簡單）
const EN_HOURS = Array.from({ length: 24 }, (_, h) => `${h} o'clock`);
const EN_PERIODS = {
  morning: 'Good morning',
  lunch: 'Lunch time',
  evening: 'Good evening',
  night: 'Good night',
};

const DICT = {
  zh: { hours: ZH_HOURS, periods: ZH_PERIODS },
  ja: { hours: JA_HOURS, periods: JA_PERIODS },
  en: { hours: EN_HOURS, periods: EN_PERIODS },
};

/**
 * 取出該語言的所有時間語音 candidate（給 batch runner 用）
 * @param {string} lang 'zh' | 'ja' | 'en'
 * @returns {Array<{key: string, text: string, category: 'hour' | 'period'}>}
 */
function listTimeVoiceCandidates(lang = 'zh') {
  const dict = DICT[lang] || DICT.zh;
  const out = [];
  // 24 小時
  for (let h = 0; h < 24; h++) {
    out.push({
      key: `hour_${String(h).padStart(2, '0')}`,
      text: dict.hours[h],
      category: 'hour',
    });
  }
  // 4 時段詞
  for (const [pk, text] of Object.entries(dict.periods)) {
    out.push({ key: pk, text, category: 'period' });
  }
  return out;
}

/**
 * 取單一 key 的預設文字（給 UI 顯示用）
 */
function getTimeVoiceDefaultText(timeKey, lang = 'zh') {
  const dict = DICT[lang] || DICT.zh;
  if (timeKey?.startsWith('hour_')) {
    const h = parseInt(timeKey.slice(5), 10);
    if (Number.isFinite(h) && h >= 0 && h < 24) return dict.hours[h];
  }
  return dict.periods[timeKey] || null;
}

module.exports = {
  listTimeVoiceCandidates,
  getTimeVoiceDefaultText,
  DICT,
};
