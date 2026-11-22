// Model: Automation.trigger "schedule" — a five-field cron expression
// (minute hour day-of-month month day-of-week), in the server's local time.
// Fields take *, numbers, lists (1,15), ranges (1-5), steps (*/15, 0-30/10)
// and day / month names (mon, jan). Also @hourly, @daily, @weekly,
// @monthly, @yearly. As in cron, when both day fields are restricted a day
// matching either one runs.

export type Cron = { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domAny: boolean; dowAny: boolean };

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *',
};
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function field(text: string, min: number, max: number, names: string[] | null, nameBase: number, label: string): Set<number> {
  const out = new Set<number>();
  const num = (s: string): number => {
    const i = names ? names.indexOf(s.toLowerCase()) : -1;
    if (i >= 0) return i + nameBase;
    if (!/^\d+$/.test(s)) throw new Error(`${label}: "${s}" is not a number`);
    return Number(s);
  };
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`${label}: bad step "${stepText}"`);
    let lo: number; let hi: number;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) { const [a, b] = range.split('-'); lo = num(a); hi = num(b); }
    else { lo = num(range); hi = stepText === undefined ? lo : max; }
    if (lo < min || hi > max || lo > hi) throw new Error(`${label}: ${range} is outside ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const e = (ALIASES[expr.trim().toLowerCase()] ?? expr).trim();
  const parts = e.split(/\s+/);
  if (parts.length !== 5) throw new Error('A schedule needs five fields: minute hour day-of-month month day-of-week');
  const dow = field(parts[4], 0, 7, DAYS, 0, 'day of week');
  if (dow.has(7)) { dow.delete(7); dow.add(0); }
  return {
    minute: field(parts[0], 0, 59, null, 0, 'minute'),
    hour: field(parts[1], 0, 23, null, 0, 'hour'),
    dom: field(parts[2], 1, 31, null, 1, 'day of month'),
    month: field(parts[3], 1, 12, MONTHS, 1, 'month'),
    dow,
    domAny: parts[2] === '*',
    dowAny: parts[4] === '*',
  };
}

export function cronMatches(c: Cron, d: Date): boolean {
  if (!c.minute.has(d.getMinutes()) || !c.hour.has(d.getHours()) || !c.month.has(d.getMonth() + 1)) return false;
  const dom = c.dom.has(d.getDate());
  const dow = c.dow.has(d.getDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dow;
  if (c.dowAny) return dom;
  return dom || dow;
}

// The first minute after `from` the schedule runs (null: none within ~2 years).
export function nextRun(c: Cron, from: Date): Date | null {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 2 * 366 * 24 * 60; i++) {
    if (!c.month.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
    if (cronMatches(c, d)) return d;
    if (!c.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

// Pure: the expression in words, for the list ("Every day at 09:00").
export function describeCron(expr: string): string {
  let c: Cron;
  try { c = parseCron(expr); } catch (e) { return (e as Error).message; }
  const one = (s: Set<number>) => (s.size === 1 ? [...s][0] : null);
  const m = one(c.minute); const h = one(c.hour);
  const time = m !== null && h !== null ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` : null;
  const everyDay = c.domAny && c.dowAny && c.month.size === 12;
  if (c.minute.size === 60 && c.hour.size === 24 && everyDay) return 'Every minute';
  if (m !== null && c.hour.size === 24 && everyDay) return m === 0 ? 'Every hour' : `Every hour at :${String(m).padStart(2, '0')}`;
  if (time && everyDay) return `Every day at ${time}`;
  if (time && c.domAny && !c.dowAny && c.month.size === 12) {
    const days = [...c.dow].sort().map((d) => DAYS[d][0].toUpperCase() + DAYS[d].slice(1));
    const weekdays = c.dow.size === 5 && [1, 2, 3, 4, 5].every((d) => c.dow.has(d));
    return `${weekdays ? 'Weekdays' : days.join(', ')} at ${time}`;
  }
  return expr.trim();
}
