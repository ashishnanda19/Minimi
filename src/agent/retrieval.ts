import { humanizeCitations } from "./memory.js";
import { hostOf } from "./sources.js";
import { daysAgo, formatStamp, relativeLabel } from "./temporal.js";
import type { Store, StoredMessage } from "../store/db.js";

/**
 * Topic retrieval over everything a user has ever discussed. The prompt's ledger is recency-budgeted, so an old
 * conversation falls out of it; this finds it again by *what it was about* ("my Postgres question",
 * "that CRM shortlist") rather than by when it happened.
 */

const STOP = new Set(`a an the and or but if then than so of to in on at by for from with without about into over under again further
  is are was were be been being am do does did done doing have has had having i me my mine we our you your yours he she it its they them their this that these those
  what which who whom whose when where why how can could should would will shall may might must not no nor only own same too very just also
  please tell told ask asked asking say said remind reminded show give gave want need like know think mean yes okay ok thanks thank
  still correct answer answers question questions earlier before previous previously last ago since changed change changes anything something
  today tomorrow yesterday tonight morning afternoon evening week weeks month months year years day days time times thing things one two three
  new now current currently latest more some any all each every both few many much most other another such there here out up down off
  monday tuesday wednesday thursday friday saturday sunday january february march april june july august september october november december
  jan feb mar apr jun jul aug sep sept oct nov dec`.split(/\s+/));

export function keywordsOf(text: string): string[] {
  const seen = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) ?? []) {
    const word = w.replace(/[.-]+$/, "");
    if (word.length >= 3 && !STOP.has(word)) seen.add(word);
  }
  return [...seen].sort((a, b) => b.length - a.length).slice(0, 8); // longer words are more specific
}

/** A safe FTS5 expression: every token quoted (so operators in user text cannot break the query), OR-ed together. */
export function ftsMatch(tokens: string[]): string | undefined {
  const quoted = tokens.map((t) => `"${t.replace(/"/g, '""')}"`);
  return quoted.length ? quoted.join(" OR ") : undefined;
}

export interface Recalled {
  sessionId: string;
  when: Date;
  question: string;
  answer?: string;
  /** The full stored answer, for mining claims; not shown to the model as-is. */
  answerMessage?: StoredMessage;
  domains: string[];
  score: number;
  matched: string[];
}

const ANSWER_CHARS = 420;
const QUESTION_CHARS = 200;

export function retrieveRelevant(
  store: Store, userId: string, text: string, excludeSessionId: string, now: Date, opts: { limit?: number } = {},
): Recalled[] {
  const tokens = keywordsOf(text);
  const match = ftsMatch(tokens);
  if (!match) return [];

  const hits = store.searchMessages(userId, match, excludeSessionId, 40);
  const turns = new Map<string, { q: StoredMessage; a?: StoredMessage; rank: number }>();
  for (const { message, rank } of hits) {
    const other = store.pairedTurn(message);
    const q = message.role === "user" ? message : other;
    const a = message.role === "assistant" ? message : other;
    if (!q || q.role !== "user") continue;
    const key = `${q.sessionId}:${q.id}`;
    const prior = turns.get(key);
    if (!prior || rank < prior.rank) turns.set(key, { q, a: a?.role === "assistant" ? a : prior?.a, rank });
  }

  // A word found in only a handful of this user's messages ("postgres") is a topic; one found everywhere is not.
  const distinctive = new Set(tokens.filter((t) => {
    const f = store.tokenFrequency(userId, t);
    return t.length >= 5 && f.containing <= Math.max(3, f.total * 0.06);
  }));

  const recalled: Recalled[] = [];
  for (const { q, a, rank } of turns.values()) {
    const haystack = `${q.content} ${a?.content ?? ""}`.toLowerCase();
    const matched = tokens.filter((t) => haystack.includes(t.replace(/(ing|ed|es|s)$/, "")));
    // Two shared words, or one distinctive word, makes a topic match. One ordinary shared word is noise.
    if (matched.length < 2 && !matched.some((t) => distinctive.has(t))) continue;
    const ageDays = Math.max(0, (now.getTime() - q.createdAt.getTime()) / 86_400_000);
    const score = -rank * (1 + 0.2 * Math.exp(-ageDays / 21)) * (1 + 0.15 * matched.length);
    recalled.push({
      sessionId: q.sessionId,
      when: q.createdAt,
      question: q.content.replace(/\s+/g, " ").trim().slice(0, QUESTION_CHARS),
      answerMessage: a?.role === "assistant" ? a : undefined,
      answer: a && humanizeCitations(a.content, a.sources).replace(/\s+/g, " ").trim().slice(0, ANSWER_CHARS),
      domains: [...new Set((a?.sources ?? []).map((s) => hostOf(s.url)))].slice(0, 4),
      score,
      matched,
    });
  }
  recalled.sort((x, y) => y.score - x.score);
  const best = recalled[0]?.score ?? 0;
  return recalled.filter((r) => r.score >= best * 0.45).slice(0, opts.limit ?? 4); // weak matches do not ride along with a strong one
}

export function formatRecalled(items: Recalled[], now: Date, tz: string): string {
  return items
    .map((r) => {
      const when = `${formatStamp(r.when, tz)}, ${relativeLabel(daysAgo(r.when, now, tz))}`;
      return `[${when}] You asked: "${r.question}"${r.answer ? ` | I answered: "${r.answer}"` : ""}${r.domains.length ? ` (src: ${r.domains.join(", ")})` : ""}`;
    })
    .join("\n");
}
