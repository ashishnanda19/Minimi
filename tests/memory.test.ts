import { describe, expect, it } from "vitest";
import {
  buildLedger, humanizeCitations, LEDGER_BUDGET_CHARS, MAX_LIVE_MESSAGES, splitMemory, toModelMessages,
} from "../src/agent/memory.js";
import type { StoredMessage } from "../src/store/db.js";

const NOW = new Date("2026-11-10T13:15:00Z");
const TZ = "UTC";
const msg = (role: "user" | "assistant", content: string, iso: string, sources: StoredMessage["sources"] = []): StoredMessage =>
  ({ sessionId: "s", role, content, sources, createdAt: new Date(iso) });

describe("humanizeCitations", () => {
  const sources = [{ id: 1, title: "A", url: "https://www.a.com/x" }, { id: 2, title: "B", url: "https://b.com" }];
  it("replaces [n] with provenance so old numbers cannot collide with new ones", () => {
    expect(humanizeCitations("Costs $5 [1][2] and [1, 2].", sources)).toBe("Costs $5 (src: a.com)(src: b.com) and (src: a.com, b.com).");
  });
  it("leaves unknown numbers untouched", () => {
    expect(humanizeCitations("See [9].", sources)).toBe("See [9].");
  });
});

describe("buildLedger", () => {
  it("is chronological, dated and relative", () => {
    const newestFirst = [
      msg("assistant", "Neon [1]", "2026-11-03T08:31:00Z", [{ id: 1, title: "Neon", url: "https://neon.tech" }]),
      msg("user", "Cheapest Postgres?", "2026-11-03T08:30:00Z"),
    ];
    const ledger = buildLedger(newestFirst, NOW, TZ).split("\n");
    expect(ledger[0]).toBe("[Tue 3 Nov 2026, 08:30, 7 days ago] USER: Cheapest Postgres?");
    expect(ledger[1]).toContain("YOU: Neon (src: neon.tech)");
  });

  it("keeps the NEWEST messages when over budget and says older ones were omitted", () => {
    const newestFirst = Array.from({ length: 200 }, (_, i) =>
      msg("user", `question ${i} ${"x".repeat(400)}`, new Date(NOW.getTime() - i * 3_600_000).toISOString()));
    const ledger = buildLedger(newestFirst, NOW, TZ);
    expect(ledger.length).toBeLessThanOrEqual(LEDGER_BUDGET_CHARS + 200);
    expect(ledger.startsWith("(older conversations omitted")).toBe(true);
    expect(ledger).toContain("question 0 ");
    expect(ledger).not.toContain("question 199 ");
  });

  it("keeps the newest answers whole (they get re-verified) but clips old ones so they can't eat the budget", () => {
    const answers = Array.from({ length: 8 }, (_, i) => msg("assistant", `A${i} ` + "y".repeat(1_500), new Date(NOW.getTime() - i * 3_600_000).toISOString()));
    const lines = buildLedger(answers, NOW, TZ).split("\n"); // oldest first: A7 ... A0
    expect(lines[0]).toContain("[truncated]");             // 8th-newest: clipped
    expect(lines[1]).toContain("[truncated]");             // 7th-newest: clipped
    expect(lines[2]).not.toContain("[truncated]");         // 6th-newest: whole
    expect(lines.at(-1)!.length).toBeGreaterThan(1_500);
  });

  it("drops duplicate lines when the same history was seeded into several chats", () => {
    const dup = msg("user", "Shortlist: A, B", "2026-11-09T05:00:00Z");
    expect(buildLedger([dup, { ...dup, sessionId: "other" }], NOW, TZ).split("\n")).toHaveLength(1);
  });
});

describe("splitMemory", () => {
  it("keeps the last N messages live and folds overflow into the ledger, never losing it", () => {
    const session = Array.from({ length: MAX_LIVE_MESSAGES + 6 }, (_, i) =>
      msg(i % 2 === 0 ? "user" : "assistant", `m${i}`, new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString()));
    const { live, earlier } = splitMemory(session, []);
    expect(live).toHaveLength(MAX_LIVE_MESSAGES);
    expect(earlier.map((m) => m.content)).toEqual(["m5", "m4", "m3", "m2", "m1", "m0"]); // newest first
  });

  it("never starts the live window with an assistant turn (Anthropic requires user first)", () => {
    const session = Array.from({ length: MAX_LIVE_MESSAGES + 1 }, (_, i) =>
      msg(i % 2 === 0 ? "user" : "assistant", `m${i}`, new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString()));
    const { live } = splitMemory(session, []);
    expect(live[0]!.role).toBe("user");
  });
});

describe("toModelMessages", () => {
  it("stamps every user turn, appends the new one, and merges same-role runs from seeded data", () => {
    const live = [
      msg("user", "a", "2026-11-09T05:00:00Z"),
      msg("user", "b", "2026-11-09T05:01:00Z"),
      msg("assistant", "ans [1]", "2026-11-09T05:02:00Z", [{ id: 1, title: "T", url: "https://t.com" }]),
    ];
    const out = toModelMessages(live, "now?", NOW, TZ);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(out[0]!.content).toBe("[Mon 9 Nov 2026, 05:00] a\n\n[Mon 9 Nov 2026, 05:01] b");
    expect(out[1]!.content).toBe("ans (src: t.com)");
    expect(out[2]!.content).toBe("[Tue 10 Nov 2026, 13:15] now?");
  });
});

import { buildDateLookup } from "../src/agent/memory.js";

describe("buildDateLookup", () => {
  const stored = [
    msg("user", "Cheapest Postgres hosting?", "2026-11-03T08:30:00Z"),
    msg("assistant", "Neon [1]", "2026-11-03T08:31:00Z"),
  ];
  it("tells the model what was actually asked on the referenced day", () => {
    const out = buildDateLookup("What did I ask on 3 November?", stored, NOW, TZ);
    expect(out).toContain('"3 November" = Tue 3 Nov 2026 (2026-11-03, 7 days ago): 2 stored message(s)');
    expect(out).toContain('The user asked: "Cheapest Postgres hosting?"');
  });
  it("states plainly that nothing is stored for a day, and names the nearest days that have records", () => {
    const out = buildDateLookup("What did I ask on 20 October?", stored, NOW, TZ);
    expect(out).toContain("NO stored messages on that day");
    expect(out).toContain("Nearest days with records: Tue 3 Nov 2026 (7 days ago)");
    expect(out).not.toContain("Cheapest Postgres");
  });
  it("says so when there is no history at all, and returns nothing when the message has no dates", () => {
    expect(buildDateLookup("on 3 November?", [], NOW, TZ)).toContain("No conversations are stored at all");
    expect(buildDateLookup("hello there", stored, NOW, TZ)).toBe("");
  });
});
