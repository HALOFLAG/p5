// variable-interpolator — 對話台詞變數插值
//
// 白名單變數（plan §15 邊界）：
//   {time}        14:32
//   {hour}        14
//   {weekday}     星期三
//   {usage_hours} 由 ctx.input.session_sec 粗略換算
//   {window_title} 由 ctx.fg_app_title 取得（caller 應傳已 redact 的字串）

const VAR_RE = /\{(time|hour|weekday|usage_hours|window_title)\}/g;
const ALLOWED_VARS = ['time', 'hour', 'weekday', 'usage_hours', 'window_title'];
const WEEKDAY_ZH = ['日', '一', '二', '三', '四', '五', '六'];

function interpolate(text, ctx = {}) {
  if (typeof text !== 'string' || !text.includes('{')) return text;
  const now = ctx.now || Date.now();
  const d = new Date(now);

  return text.replace(VAR_RE, (_, name) => {
    switch (name) {
      case 'time':
        return formatHm(d);
      case 'hour':
        return String(d.getHours());
      case 'weekday':
        return `星期${WEEKDAY_ZH[d.getDay()]}`;
      case 'usage_hours':
        return formatUsageHours(ctx?.input?.session_sec);
      case 'window_title': {
        const t = ctx?.fg_app_title;
        return typeof t === 'string' ? t : '';
      }
      default:
        return '';
    }
  });
}

function formatHm(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatUsageHours(seconds) {
  if (!seconds || seconds <= 0) return '0';
  const h = seconds / 3600;
  return h < 10 ? h.toFixed(1) : String(Math.floor(h));
}

module.exports = { interpolate, ALLOWED_VARS };
