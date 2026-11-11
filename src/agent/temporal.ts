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
export function buildCalendar(now: Date, tz: string, back = 14, forward = 7): string {
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
  /** First day referred to. */
  date: Civil;
  /** Last day (inclusive) when the phrase names a span such as "last week". */
  end?: Civil;
  /** For "this morning" and friends: which part of the day. */
  part?: "morning" | "afternoon" | "evening";
}

const MONTH_RE = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const WEEKDAY_RE = "sunday|monday|tuesday|wednesday|thursday|friday|saturday";
const COUNT_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const monthIndex = (s: string) => MONTHS.findIndex((m) => s.toLowerCase().startsWith(m.toLowerCase())) + 1;
const weekdayIndex = (s: string) => WEEKDAYS_LONG.findIndex((w) => w.toLowerCase() === s.toLowerCase());
const count = (s: string) => COUNT_WORDS[s.toLowerCase()] ?? Number(s);

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

const monthSpan = (y: number, m: number): { date: Civil; end: Civil } => ({ date: { y, m, d: 1 }, end: fromUtc(Date.UTC(y, m, 0)) });
/** Monday of the week containing `c`. */
const mondayOf = (c: Civil): Civil => addDays(c, -((weekdayOf(c) + 6) % 7));
/** The calendar month `n` months before `c`'s month, as a span. */
function monthsBack(c: Civil, n: number) {
  const idx = c.y * 12 + (c.m - 1) - n;
  return monthSpan(Math.floor(idx / 12), (idx % 12) + 1);
}

/**
 * Finds the past days and spans a user message refers to: "last Tuesday", "3 November", "5 days ago", "yesterday",
 * "last week", "in October", "2 weeks ago", "this morning". Done in code so a weak model is handed the answer
 * instead of being trusted to do calendar maths.
 */
export function resolveDateRefs(text: string, now: Date, tz: string): DateRef[] {
  const today = civilOf(now, tz);
  const found: (DateRef & { at: number })[] = [];
  const claimed: [number, number][] = [];
  const add = (match: RegExpMatchArray, span: { date: Civil; end?: Civil; part?: DateRef["part"] } | undefined) => {
    const at = match.index ?? 0;
    const end = at + match[0].length;
    if (!span || claimed.some(([s, e]) => at < e && end > s)) return;
    claimed.push([at, end]);
    found.push({ phrase: match[0].trim(), ...span, at });
  };
  const day = (date: Civil | undefined) => (date ? { date } : undefined);

  // Most specific patterns first so "last Monday" is not also read as a bare "Monday", and "October 3" is not read as "in October".
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(m, day(validCivil(+m[1]!, +m[2]!, +m[3]!)));
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\b(?:,?\\s+(\\d{4}))?`, "gi"))) {
    add(m, day(m[3] ? validCivil(+m[3], monthIndex(m[2]!), +m[1]!) : mostRecent(monthIndex(m[2]!), +m[1]!, today)));
  }
  for (const m of text.matchAll(new RegExp(`\\b(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "gi"))) {
    add(m, day(m[3] ? validCivil(+m[3], monthIndex(m[1]!), +m[2]!) : mostRecent(monthIndex(m[1]!), +m[2]!, today)));
  }
  for (const m of text.matchAll(/\blast week\b/gi)) { const mon = addDays(mondayOf(today), -7); add(m, { date: mon, end: addDays(mon, 6) }); }
  for (const m of text.matchAll(/\bthis week\b/gi)) add(m, { date: mondayOf(today), end: today });
  for (const m of text.matchAll(/\blast month\b/gi)) add(m, monthsBack(today, 1));
  for (const m of text.matchAll(/\bthis month\b/gi)) add(m, { date: { y: today.y, m: today.m, d: 1 }, end: today });
  for (const m of text.matchAll(/\blast weekend\b/gi)) {
    const sunday = addDays(today, -(weekdayOf(today) === 0 ? 7 : weekdayOf(today)));
    add(m, { date: addDays(sunday, -1), end: sunday });
  }
  for (const m of text.matchAll(/\b(\d{1,2}|an?|one|two|three|four|five|six) weeks? ago\b/gi)) {
    const mon = mondayOf(addDays(today, -7 * count(m[1]!)));
    add(m, { date: mon, end: addDays(mon, 6) });
  }
  for (const m of text.matchAll(/\b(\d{1,2}|an?|one|two|three|four|five|six) months? ago\b/gi)) add(m, monthsBack(today, count(m[1]!)));
  for (const m of text.matchAll(new RegExp(`\\bin (${MONTH_RE})\\b(?:,?\\s+(\\d{4}))?`, "gi"))) {
    const mi = monthIndex(m[1]!);
    const y = m[2] ? +m[2] : mi > today.m ? today.y - 1 : today.y;
    const span = monthSpan(y, mi);
    add(m, mi === today.m && y === today.y ? { date: span.date, end: today } : span);
  }
  for (const m of text.matchAll(/\b(earlier today|this (morning|afternoon|evening)|tonight|so far today)\b/gi)) {
    const w = (m[2] ?? (/tonight/i.test(m[1]!) ? "evening" : undefined)) as DateRef["part"] | undefined;
    add(m, { date: today, part: w });
  }
  for (const m of text.matchAll(/\bday before yesterday\b/gi)) add(m, day(addDays(today, -2)));
  for (const m of text.matchAll(/\byesterday\b/gi)) add(m, day(addDays(today, -1)));
  for (const m of text.matchAll(/\b(\d{1,3}) days? ago\b/gi)) add(m, day(addDays(today, -Number(m[1]))));
  for (const m of text.matchAll(new RegExp(`\\b(?:last|on|this|since)\\s+(${WEEKDAY_RE})\\b`, "gi"))) {
    const back = (weekdayOf(today) - weekdayIndex(m[1]!) + 7) % 7 || 7; // strictly before today: 1..7 days back
    add(m, day(addDays(today, -back)));
  }
  for (const m of text.matchAll(new RegExp(`\\b(${WEEKDAY_RE})\\b`, "gi"))) {
    const back = (weekdayOf(today) - weekdayIndex(m[1]!) + 7) % 7 || 7;
    add(m, day(addDays(today, -back)));
  }

  return found.sort((a, b) => a.at - b.at).map(({ at: _at, ...ref }) => ref);
}

/** Instant at which `c` begins in `tz` (handles DST days). */
export function zonedMidnight(c: Civil, tz: string): Date {
  const offset = (ms: number) => {
    const k = clock(new Date(ms), tz);
    return Date.UTC(k.y, k.m - 1, k.d, k.hh, k.mm) - Math.floor(ms / 60_000) * 60_000;
  };
  const guess = Date.UTC(c.y, c.m - 1, c.d);
  const first = guess - offset(guess);
  return new Date(guess - offset(first)); // second pass settles days on which the clock changes
}

/** [from, to) in absolute time for a reference, for querying stored messages. */
export function refBounds(ref: DateRef, tz: string): { from: Date; to: Date } {
  const from = zonedMidnight(ref.date, tz);
  const to = zonedMidnight(addDays(ref.end ?? ref.date, 1), tz);
  if (!ref.part) return { from, to };
  const h = ref.part === "morning" ? [0, 12] : ref.part === "afternoon" ? [12, 17] : [17, 24];
  return { from: new Date(from.getTime() + h[0]! * 3_600_000), to: new Date(from.getTime() + h[1]! * 3_600_000) };
}

export const sameDay = (a: Civil, b: Civil) => a.y === b.y && a.m === b.m && a.d === b.d;
export const dayDistance = (from: Civil, to: Civil) => Math.round((toUtc(to) - toUtc(from)) / DAY_MS);
