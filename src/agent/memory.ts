import type { ModelMessage } from "ai";
import { hostOf } from "./sources.js";
import { civilOf, dayDistance, daysAgo, formatDay, formatStamp, isoDate, refBounds, relativeLabel, resolveDateRefs, sameDay, type DateRef } from "./temporal.js";
import type { SourceRef, StoredMessage } from "../store/db.js";

/** Last N messages of the current chat go in as real turns; anything older folds into the ledger. */
export const MAX_LIVE_MESSAGES = 20;
export const LEDGER_BUDGET_CHARS = 14_000; // ~3.5k tokens
const LEDGER_ANSWER_CHARS = 1_200; // older answers
const RECENT_ANSWERS_KEPT_WHOLE = 6; // newest answers are the likeliest to be re-verified, so never clip them
const LEDGER_QUESTION_CHARS = 500;
const LIVE_MESSAGE_CHARS = 4_000;

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max).trimEnd()} …[truncated]`);

/**
 * Old answers cite [1], [2]. Those numbers mean nothing in a later turn and would collide
 * with the new turn's numbering, so we replace them with the source's domain. That also
 * tells the model *where* an old claim came from, which is exactly what it needs to re-verify it.
 */
export function humanizeCitations(text: string, sources: SourceRef[]): string {
  const byId = new Map(sources.map((s) => [s.id, hostOf(s.url)]));
  return text.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (whole, list: string) => {
    const hosts = list.split(",").map((n) => byId.get(Number(n.trim())));
    return hosts.every(Boolean) ? `(src: ${[...new Set(hosts)].join(", ")})` : whole;
  });
}

const speaker = (m: StoredMessage) => (m.role === "user" ? "USER" : "YOU");

/** Chronological, dated record of earlier conversations, trimmed to a budget (newest kept first). */
export function buildLedger(earlierNewestFirst: StoredMessage[], now: Date, tz: string): string {
  const lines: string[] = [];
  let used = 0;
  let omitted = false;
  let answersSeen = 0;
  const seen = new Set<string>();
  for (const m of earlierNewestFirst) {
    const key = `${m.role}|${m.createdAt.getTime()}|${m.content}`;
    if (seen.has(key)) continue; // same history seeded into several chats must not repeat
    seen.add(key);
    const answerLimit = answersSeen++ < RECENT_ANSWERS_KEPT_WHOLE ? LIVE_MESSAGE_CHARS : LEDGER_ANSWER_CHARS;
    const text = m.role === "user"
      ? clip(m.content, LEDGER_QUESTION_CHARS)
      : clip(humanizeCitations(m.content, m.sources), answerLimit);
    const when = `${formatStamp(m.createdAt, tz)}, ${relativeLabel(daysAgo(m.createdAt, now, tz))}`;
    const line = `[${when}] ${speaker(m)}: ${text.replace(/\n+/g, " ⏎ ")}`;
    if (used + line.length > LEDGER_BUDGET_CHARS) {
      omitted = true;
      break;
    }
    used += line.length;
    lines.push(line);
  }
  lines.reverse();
  if (omitted) lines.unshift("(older conversations omitted for length)");
  return lines.join("\n");
}

/**
 * Splits the current chat into live turns and overflow, then merges the overflow with
 * other chats into the ledger input. Also repairs role order (Anthropic needs user first).
 */
export function splitMemory(session: StoredMessage[], otherChatsNewestFirst: StoredMessage[]) {
  let live = session.slice(-MAX_LIVE_MESSAGES);
  const overflow = session.slice(0, session.length - live.length);
  while (live[0]?.role === "assistant") overflow.push(live.shift()!);
  const earlier = [...otherChatsNewestFirst, ...overflow].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
  return { live, earlier };
}

export function toModelMessages(live: StoredMessage[], newUserText: string, now: Date, tz: string): ModelMessage[] {
  const turns: { role: "user" | "assistant"; text: string }[] = [];
  const push = (role: "user" | "assistant", text: string) => {
    const last = turns.at(-1);
    if (last?.role === role) last.text += `\n\n${text}`; // consecutive same-role turns (seeded data) are merged
    else turns.push({ role, text });
  };
  for (const m of live) {
    push(
      m.role,
      m.role === "user"
        ? `[${formatStamp(m.createdAt, tz)}] ${clip(m.content, LIVE_MESSAGE_CHARS)}`
        : clip(humanizeCitations(m.content, m.sources), LIVE_MESSAGE_CHARS),
    );
  }
  push("user", `[${formatStamp(now, tz)}] ${newUserText}`);
  return turns.map((t) => ({ role: t.role, content: t.text }));
}

export interface LookupSource {
  between(from: Date, to: Date): StoredMessage[];
  /** Timestamps of the user's questions, to name the nearest days that do have records. */
  activeDays(): Date[];
}

export interface Lookup {
  /** Prompt block: what is stored for each day or span the user mentioned. */
  text: string;
  /** The stored messages behind it (used to recover the claims made on those days). */
  messages: StoredMessage[];
}

const spanLabel = (ref: DateRef) => (ref.end && !sameDay(ref.end, ref.date) ? `${formatDay(ref.date)} to ${formatDay(ref.end)}` : formatDay(ref.date));

/**
 * Resolves the dates in the user's message in code, then looks up what is actually stored for each.
 * The model receives "on that day: 2 messages (...)" or "nothing stored, nearest days are ...",
 * so it never has to guess, and "I have no record" is a fact handed to it, not something it must infer.
 * Handles single days ("last Tuesday") and spans ("last week", "in October", "2 weeks ago").
 */
export function resolveLookup(userText: string, source: StoredMessage[] | LookupSource, now: Date, tz: string): Lookup {
  const refs = resolveDateRefs(userText, now, tz);
  if (!refs.length) return { text: "", messages: [] };
  const src: LookupSource = Array.isArray(source)
    ? {
        between: (from, to) => source.filter((m) => m.createdAt >= from && m.createdAt < to).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
        activeDays: () => source.filter((m) => m.role === "user").map((m) => m.createdAt),
      }
    : source;

  const today = civilOf(now, tz);
  const collected: StoredMessage[] = [];
  const lines = refs.map((ref) => {
    const { from, to } = refBounds(ref, tz);
    const isSpan = Boolean(ref.end && !sameDay(ref.end, ref.date));
    const span = isSpan ? `${isoDate(ref.date)} to ${isoDate(ref.end!)}` : `${isoDate(ref.date)}, ${relativeLabel(dayDistance(ref.date, today))}`;
    const head = `"${ref.phrase}" = ${spanLabel(ref)}${ref.part ? ` (${ref.part})` : ""} (${span})`;
    const inRange = src.between(from, to);
    collected.push(...inRange);
    if (inRange.length) {
      const stamp = (m: StoredMessage) => (isSpan ? formatStamp(m.createdAt, tz) : formatStamp(m.createdAt, tz).split(", ")[1]);
      const asked = inRange.filter((m) => m.role === "user").slice(0, 8).map((m) => `[${stamp(m)}] "${clip(m.content.replace(/\s+/g, " "), 150)}"`);
      const more = inRange.filter((m) => m.role === "user").length - asked.length;
      return `${head}: ${inRange.length} stored message(s). The user asked: ${asked.join("; ") || "(no user messages)"}${more > 0 ? `; and ${more} more` : ""}`;
    }
    const days = [...new Map(src.activeDays().map((t) => { const c = civilOf(t, tz); return [isoDate(c), c] as const; })).values()]
      .sort((a, b) => Math.abs(dayDistance(a, ref.date)) - Math.abs(dayDistance(b, ref.date)))
      .slice(0, 2);
    const near = days.map((d) => `${formatDay(d)} (${relativeLabel(dayDistance(d, today))})`).join(", ");
    return `${head}: NO stored messages ${isSpan ? "in that span" : "on that day"}.${near ? ` Nearest days with records: ${near}.` : " No conversations are stored at all."}`;
  });
  return { text: lines.join("\n"), messages: collected };
}

export const buildDateLookup = (userText: string, source: StoredMessage[] | LookupSource, now: Date, tz: string): string =>
  resolveLookup(userText, source, now, tz).text;
