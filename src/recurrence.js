const units = new Set(['day', 'week', 'month', 'year', 'weekdays']);
export function todayJst() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export function normalizeRepeat(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || !units.has(value.unit) || !Number.isInteger(value.interval) || value.interval < 1 || value.interval > 999) throw new Error('繰り返しは1〜999の日・週・月・年で指定してください');
  const days = value.daysOfWeek ?? [];
  if (!Array.isArray(days) || days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('繰り返す曜日が不正です');
  return { unit: value.unit, interval: value.unit === 'weekdays' ? 1 : value.interval, daysOfWeek: value.unit === 'week' ? [...new Set(days)].sort() : [] };
}
const date = s => new Date(s + 'T00:00:00Z');
const iso = d => d.toISOString().slice(0, 10);
// Calendar arithmetic in UTC avoids DST; task dates themselves are JST date-only values.
export function nextDueDate(rule, anchor, due, today) {
  const r = normalizeRepeat(rule), start = date(anchor), cutoff = date(due > today ? due : today);
  const dayMs = 86400000;
  if (r.unit === 'day') {
    const n = Math.max(1, Math.floor((cutoff - start) / dayMs / r.interval) + 1);
    return iso(new Date(+start + n * r.interval * dayMs));
  }
  if (r.unit === 'month' || r.unit === 'year') {
    const months = r.interval * (r.unit === 'year' ? 12 : 1);
    let n = Math.max(1, Math.floor(((cutoff.getUTCFullYear() - start.getUTCFullYear()) * 12 + cutoff.getUTCMonth() - start.getUTCMonth()) / months));
    while (true) {
      const candidate = date(anchor);
      candidate.setUTCDate(1); candidate.setUTCMonth(start.getUTCMonth() + n * months);
      const end = new Date(+candidate); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0);
      candidate.setUTCDate(Math.min(start.getUTCDate(), end.getUTCDate()));
      if (candidate > cutoff) return iso(candidate);
      n++;
    }
  }
  const days = r.unit === 'weekdays' ? [1,2,3,4,5] : r.daysOfWeek.length ? r.daysOfWeek : [start.getUTCDay()];
  const weekStart = +start - ((start.getUTCDay() + 6) % 7) * dayMs;
  const candidate = new Date(+cutoff);
  // A valid weekly rule always finds a date within interval * 7 days.
  for (let i = 0; i <= r.interval * 7; i++) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
    const week = Math.floor((+candidate - weekStart) / dayMs / 7);
    if (days.includes(candidate.getUTCDay()) && (r.unit === 'weekdays' || week % r.interval === 0)) return iso(candidate);
  }
  throw new Error('次回の期限を計算できません');
}
