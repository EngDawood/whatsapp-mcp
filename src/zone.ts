/** Calendar days in the user's timezone, for tools that take a date. */

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Today's date, YYYY-MM-DD, in `tz`. */
export const zoneToday = (tz: string, now = Date.now()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));

/** `day` (YYYY-MM-DD) moved by `n` days. */
export function addDays(day: string, n: number): string {
  const m = DAY_RE.exec(day);
  if (!m) throw new Error(`Cannot parse date "${day}" - use YYYY-MM-DD, like 2026-03-01`);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n)).toISOString().slice(0, 10);
}

/** The start of `day` (YYYY-MM-DD) in `tz`, as epoch seconds. */
export function zoneMidnight(day: string, tz: string): number {
  const m = DAY_RE.exec(day);
  if (!m) throw new Error(`Cannot parse date "${day}" - use YYYY-MM-DD, like 2026-03-01`);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  // how far `tz` is ahead of UTC at instant t, in ms
  const offset = (t: number) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
  };
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  // twice, so a day that starts next to a DST change lands on the right side of it
  return Math.floor((wall - offset(wall - offset(wall))) / 1000);
}
