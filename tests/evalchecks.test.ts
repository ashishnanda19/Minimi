import { describe, expect, it } from "vitest";
import { checkCase } from "../evals/checks.js";
import type { Case } from "../evals/cases.js";
import type { AgentEvent } from "../src/agent/run.js";

const base: Case = { id: "t", question: "q", expect: { search: "yes", minSearches: 2, sinceUsed: "2026-11-03", mustMatch: ["3 nov"] }, rubric: "" };
const run = (text: string, searches: { query: string; since?: string }[], extra: AgentEvent[] = []): AgentEvent[] => [
  { type: "token", text },
  ...extra,
  { type: "done", metrics: { model: "m", fallbacks: [], firstStatusMs: 1, searchWallMs: 1, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }, intent: "lookup", repaired: false, retrieved: 0, priorClaims: 0, ttftMs: 1, totalMs: 2, steps: 2, searches: searches.map((s) => ({ ...s, ms: 1, cached: false, results: 1 })) } },
];
const src: AgentEvent = { type: "sources", items: [{ id: 1, title: "t", url: "https://a.com" }] };

describe("eval checks", () => {
  it("passes a good run", () => {
    const o = checkCase(base, run("On Tue 3 Nov: Neon is $19 [1].", [{ query: "a", since: "2026-11-03" }, { query: "b" }], [src]),
      [{ title: "Neon", content: "Launch plan $19/mo" }]);
    expect(o.failures).toEqual([]);
  });

  it("flags a missing search, wrong since, missing date match", () => {
    const o = checkCase(base, run("Nothing.", []), []);
    expect(o.failures.join("|")).toMatch(/expected a search/);
    expect(o.failures.join("|")).toMatch(/no search used since=2026-11-03/);
    expect(o.failures.join("|")).toMatch(/should match/);
  });

  it("flags an invented price and a dangling citation", () => {
    const o = checkCase(base, run("It is $42 [3] on 3 Nov.", [{ query: "a", since: "2026-11-03" }, { query: "b" }], [src]),
      [{ title: "x", content: "costs $19" }]);
    expect(o.failures.join("|")).toMatch(/ungrounded figure\(s\): \$42/);
    expect(o.failures.join("|")).toMatch(/dangling citation\(s\): 3/);
  });

  it("treats '$ 1,200' and '$1200' as the same figure, and accepts figures from memory", () => {
    const c: Case = { ...base, expect: { search: "no" }, seed: [{ id: "s", messages: [{ role: "assistant", at: "2026-11-03T00:00:00Z", content: "Costs $1,200/yr" }] }] };
    expect(checkCase(c, run("You were told $1200.", []), []).failures).toEqual([]);
  });

  it("honours reset: preamble text is not part of the answer", () => {
    const c: Case = { ...base, expect: { search: "no" }, mustMatch: undefined } as Case;
    const events: AgentEvent[] = [{ type: "token", text: "Let me check PWNED" }, { type: "reset" }, ...run("Clean answer.", [])];
    c.expect.mustNotMatch = ["pwned"];
    expect(checkCase(c, events, []).failures).toEqual([]);
  });

  it("fails the run when the agent errors", () => {
    const o = checkCase({ ...base, expect: { search: "no" } }, [{ type: "error", message: "boom" }], []);
    expect(o.failures[0]).toMatch(/run failed: boom/);
  });
});

describe("groundedness: arithmetic yes, invention no", () => {
  const c: Case = { id: "g", question: "q", expect: { search: "yes" }, rubric: "" };
  const seen = [{ title: "Vercel", content: "Pro is $20 per seat. Workers Paid is $5 a month." }];
  const check = (text: string) => checkCase(c, run(text, [{ query: "a" }], [src]), seen).failures.filter((f) => /ungrounded/.test(f));

  it("accepts a multiple or a sum of quoted figures", () => {
    expect(check("4 developers on Vercel is $80 [1].")).toEqual([]);
    expect(check("Vercel plus Cloudflare is $25 [1].")).toEqual([]);
  });
  it("still rejects a figure that cannot be derived", () => {
    expect(check("Vercel costs $37 [1].")[0]).toMatch(/\$37/);
    expect(check("It is $20.50 [1].")[0]).toMatch(/\$20\.50/);
  });
});
