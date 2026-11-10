/**
 * Deterministic time handling. LLMs are unreliable at "what date was last Tuesday",
 * so every date the model sees is computed here and placed in the prompt as a table.
 *
 * All arithmetic is done on civil dates (year/month/day in the user's timezone),
 * never on raw millisecond offsets, so DST and midnight crossings can't skew results.
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const DAY_MS = 86_400_000;

export interface Civil {
  y: number;
  m: number;
  d: number;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string, key: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = `${tz}|${key}`;
  let f = formatterCache.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts });
    formatterCache.set(k, f);
  }
  return f;
}

function clock(instant: Date, tz: string): Civil & { hh: number; mm: number } {
  const parts = formatter(tz, "clock", {
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", hourCycle: "h23",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day"), hh: get("hour"), mm: get("minute") };
}

export function civilOf(instant: Date, tz: string): Civil {
  const { y, m, d } = clock(instant, tz);
  return { y, m, d };
}

const toUtc = (c: Civil) => Date.UTC(c.y, c.m - 1, c.d);
const fromUtc = (ms: number): Civil => {
  const dt = new Date(ms);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
};
const addDays = (c: Civil, n: number): Civil => fromUtc(toUtc(c) + n * DAY_MS);
const weekdayOf = (c: Civil) => new Date(toUtc(c)).getUTCDay();
const pad = (n: number) => String(n).padStart(2, "0");

export const isoDate = (c: Civil) => `${c.y}-${pad(c.m)}-${pad(c.d)}`;
export const formatDay = (c: Civil) => `${WEEKDAYS[weekdayOf(c)]} ${c.d} ${MONTHS[c.m - 1]} ${c.y}`;

/** Whole calendar days from `then` to `now` in `tz` (positive = past). */
export function daysAgo(then: Date, now: Date, tz: string): number {
  return Math.round((toUtc(civilOf(now, tz)) - toUtc(civilOf(then, tz))) / DAY_MS);
}

export function relativeLabel(n: number): string {
  if (n === 0) return "today";
  if (n === 1) return "yesterday";
  if (n === -1) return "tomorrow";
  return n > 0 ? `${n} days ago` : `in ${-n} days`;
}

/** "Tue 3 Nov 2026, 14:02" in the user's timezone. */
export function formatStamp(instant: Date, tz: string): string {
  const { hh, mm, ...c } = clock(instant, tz);
  return `${formatDay(c)}, ${pad(hh)}:${pad(mm)}`;
}

function offsetName(instant: Date, tz: string): string {
  const part = formatter(tz, "offset", { timeZoneName: "shortOffset" })
    .formatToParts(instant)
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? tz;
}

export function nowContext(now: Date, tz: string): string {
  return `Now: ${formatStamp(now, tz)} (${tz}, ${offsetName(now, tz)}). ISO date today: ${isoDate(civilOf(now, tz))}.`;
}

/**
 * Calendar of the past `back` days and the next `forward` days, each row labelled.
 * Any day 1-7 days back is the "last <weekday>" for its weekday: the most recent
 * such weekday strictly before today.
 */
export function buildCalendar(now: Date, tz: string, back = 28, forward = 7): string {
  const today = civilOf(now, tz);
  const rows: string[] = [];
  for (let i = -forward; i <= back; i++) {
    const day = addDays(today, -i);
    const tags = [relativeLabel(i)];
    if (i >= 1 && i <= 7) tags.push(`last ${WEEKDAYS_LONG[weekdayOf(day)]}`);
    if (i <= -1 && i >= -7) tags.push(`next ${WEEKDAYS_LONG[weekdayOf(day)]}`);
    rows.push(`${formatDay(day)} (${isoDate(day)}): ${tags.join(", ")}`);
  }
  return rows.reverse().join("\n");
}
