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

export interface DateRef {
  phrase: string;
  date: Civil;
}

const MONTH_RE = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const WEEKDAY_RE = "sunday|monday|tuesday|wednesday|thursday|friday|saturday";
const monthIndex = (s: string) => MONTHS.findIndex((m) => s.toLowerCase().startsWith(m.toLowerCase())) + 1;
const weekdayIndex = (s: string) => WEEKDAYS_LONG.findIndex((w) => w.toLowerCase() === s.toLowerCase());

function validCivil(y: number, m: number, d: number): Civil | undefined {
  const c = fromUtc(Date.UTC(y, m - 1, d));
  return c.y === y && c.m === m && c.d === d ? c : undefined;
}

/** Day-and-month with no year means its most recent occurrence that is not in the future. */
function mostRecent(m: number, d: number, today: Civil): Civil | undefined {
  const thisYear = validCivil(today.y, m, d);
  if (thisYear && toUtc(thisYear) <= toUtc(today)) return thisYear;
  return validCivil(today.y - 1, m, d) ?? validCivil(today.y - 2, m, d); // 29 Feb falls back to the last leap year
}

/**
 * Finds the past dates a user message refers to ("last Tuesday", "3 November", "5 days ago", "yesterday").
 * Done in code so a weak model is handed the answer instead of being trusted to do calendar maths.
 */
export function resolveDateRefs(text: string, now: Date, tz: string): DateRef[] {
  const today = civilOf(now, tz);
  const found: (DateRef & { at: number })[] = [];
  const claimed: [number, number][] = [];
  const add = (match: RegExpMatchArray, date: Civil | undefined) => {
    const at = match.index ?? 0;
    const end = at + match[0].length;
    if (!date || claimed.some(([s, e]) => at < e && end > s)) return;
    claimed.push([at, end]);
    found.push({ phrase: match[0].trim(), date, at });
  };

  // Most specific patterns first so "last Monday" is not also read as a bare "Monday".
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(m, validCivil(+m[1]!, +m[2]!, +m[3]!));
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\b(?:,?\\s+(\\d{4}))?`, "gi"))) {
    add(m, m[3] ? validCivil(+m[3], monthIndex(m[2]!), +m[1]!) : mostRecent(monthIndex(m[2]!), +m[1]!, today));
  }
  for (const m of text.matchAll(new RegExp(`\\b(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "gi"))) {
    add(m, m[3] ? validCivil(+m[3], monthIndex(m[1]!), +m[2]!) : mostRecent(monthIndex(m[1]!), +m[2]!, today));
  }
  for (const m of text.matchAll(/\bday before yesterday\b/gi)) add(m, addDays(today, -2));
  for (const m of text.matchAll(/\byesterday\b/gi)) add(m, addDays(today, -1));
  for (const m of text.matchAll(/\b(\d{1,3}) days? ago\b/gi)) add(m, addDays(today, -Number(m[1])));
  for (const m of text.matchAll(new RegExp(`\\b(?:last|on|this|since)\\s+(${WEEKDAY_RE})\\b`, "gi"))) {
    const back = (weekdayOf(today) - weekdayIndex(m[1]!) + 7) % 7 || 7; // strictly before today: 1..7 days back
    add(m, addDays(today, -back));
  }
  for (const m of text.matchAll(new RegExp(`\\b(${WEEKDAY_RE})\\b`, "gi"))) {
    const back = (weekdayOf(today) - weekdayIndex(m[1]!) + 7) % 7 || 7;
    add(m, addDays(today, -back));
  }

  return found.sort((a, b) => a.at - b.at).map(({ phrase, date }) => ({ phrase, date }));
}

export const sameDay = (a: Civil, b: Civil) => a.y === b.y && a.m === b.m && a.d === b.d;
export const dayDistance = (from: Civil, to: Civil) => Math.round((toUtc(to) - toUtc(from)) / DAY_MS);
