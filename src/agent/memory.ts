import type { ModelMessage } from "ai";
import { hostOf } from "./sources.js";
import { daysAgo, formatStamp, relativeLabel } from "./temporal.js";
import type { SourceRef, StoredMessage } from "../store/db.js";

/** Last N messages of the current chat go in as real turns; anything older folds into the ledger. */
export const MAX_LIVE_MESSAGES = 30;
export const LEDGER_BUDGET_CHARS = 14_000; // ~3.5k tokens
const LEDGER_ANSWER_CHARS = 700;
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
  for (const m of earlierNewestFirst) {
    const text = m.role === "user"
      ? clip(m.content, LEDGER_QUESTION_CHARS)
      : clip(humanizeCitations(m.content, m.sources), LEDGER_ANSWER_CHARS);
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
