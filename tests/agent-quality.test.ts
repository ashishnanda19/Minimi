import { beforeEach, describe, expect, it } from "vitest";
import { ModelPool } from "../src/agent/models.js";
import { runAgent, type AgentEvent } from "../src/agent/run.js";
import type { VerificationReport } from "../src/agent/verify.js";
import { TtlCache } from "../src/lib/cache.js";
import { Store } from "../src/store/db.js";
import { collect, fakeProvider, scriptedModel, type Step } from "./helpers.js";

const NOW = new Date("2026-11-10T13:15:00Z"); // Tue 10 Nov 2026
const TZ = "UTC";
let store: Store;
beforeEach(() => { store = new Store(":memory:"); });

const results = {
  "neon pricing": [{ title: "Neon Pricing", url: "https://neon.tech/pricing", content: "Launch plan: typical spend $19 per month, usage based" }],
  "supabase pricing": [{ title: "Supabase Pricing", url: "https://supabase.com/pricing", content: "Pro plan is $25 per month per organization" }],
};

function run(steps: Step[], message: string, opts: { sessionId?: string; userId?: string; history?: { role: "user" | "assistant"; content: string; timestamp: Date }[]; provider?: ReturnType<typeof fakeProvider> } = {}) {
  const model = scriptedModel(steps);
  const events = collect(runAgent(
    { models: ModelPool.single(model), provider: opts.provider ?? fakeProvider(results), store, cache: new TtlCache<any>(20, 1000), sleep: async () => {} },
    { sessionId: opts.sessionId ?? "now", message, tz: TZ, now: NOW, userId: opts.userId, history: opts.history },
  ));
  return { model, events };
}
const systemOf = (model: ReturnType<typeof scriptedModel>, call = 0) => model.doStreamCalls[call]!.prompt.filter((m) => m.role === "system").map((m) => m.content).join("\n");
const textOf = (events: AgentEvent[]) => { let t = ""; for (const e of events) { if (e.type === "reset") t = ""; else if (e.type === "token") t += e.text; } return t; };
const done = (events: AgentEvent[]) => (events.find((e) => e.type === "done") as Extract<AgentEvent, { type: "done" }>).metrics;
const report = (events: AgentEvent[]) => (events.find((e) => e.type === "verification") as Extract<AgentEvent, { type: "verification" }>).report;

const seed = (id: string, q: string, a: string, iso: string, user = "default", sources: { id: number; title: string; url: string }[] = []) => {
  store.ensureSession(id, TZ, NOW, user);
  store.addMessages(id, [{ role: "user", content: q, createdAt: new Date(iso) }, { role: "assistant", content: a, sources, createdAt: new Date(new Date(iso).getTime() + 5000) }]);
};
const HISTORY = [
  { role: "user" as const, content: "Shortlist Neon and Supabase for a small SaaS", timestamp: new Date("2026-11-03T08:30:00Z") },
  { role: "assistant" as const, content: "Neon Launch is about $19/mo [1]. Supabase Pro is $25/mo [2].", timestamp: new Date("2026-11-03T08:31:00Z") },
];

describe("search policy is decided in code", () => {
  it("pure recall: search is switched off, so it cannot waste a call", async () => {
    seed("old", "Cheapest Postgres host?", "Neon.", "2026-11-03T08:30:00Z");
    const { model, events } = run([{ text: "On Tue 3 Nov you asked: Cheapest Postgres host?" }], "What did I ask you on 3 November?");
    await events;
    expect(model.doStreamCalls[0]!.toolChoice).toEqual({ type: "none" });
    expect(systemOf(model)).toContain("Do not search");
  });
  it("small talk: search is switched off", async () => {
    const { model, events } = run([{ text: "You're welcome." }], "thanks, that helped");
    await events;
    expect(model.doStreamCalls[0]!.toolChoice).toEqual({ type: "none" });
  });
  it("re-verification with earlier claims: the FIRST step must search, and the checklist is in the prompt", async () => {
    const { model, events } = run([
      { tools: [{ input: { query: "neon pricing" } }, { input: { query: "supabase pricing" } }] },
      { text: "Neon: $19 -> $19, unchanged [1]. Supabase: $25 -> $25, unchanged [2]." },
    ], "Is that still correct?", { sessionId: "chat", history: HISTORY });
    const evs = await events;
    expect(model.doStreamCalls[0]!.toolChoice).toEqual({ type: "required" });
    expect(systemOf(model)).toContain("Claims from your earlier answers");
    expect(systemOf(model)).toMatch(/\[said Tue 3 Nov 2026\] Neon Launch: "Neon Launch is about \$19\/mo\./);
    expect(systemOf(model)).toContain("you must search before answering");
    expect(done(evs)).toMatchObject({ intent: "reverify", priorClaims: 2, repaired: false });
  });
  it("'has any of THEM changed?' with nothing remembered: search is off and the agent is told to ask which", async () => {
    const { model, events } = run([{ text: "Which tools do you mean?" }], "Has any of them changed pricing since Monday?");
    const evs = await events;
    expect(model.doStreamCalls[0]!.toolChoice).toEqual({ type: "none" });
    expect(systemOf(model)).toContain("ask ONE short question");
    expect(systemOf(model)).toContain('"since Monday" = Mon 9 Nov 2026');
    expect(systemOf(model)).toContain("NO stored messages on that day");
    expect(done(evs).intent).toBe("reverify");
  });
  it("...but the same words with a shortlist in memory re-verify it instead", async () => {
    const { model, events } = run([{ tools: [{ input: { query: "neon pricing" } }] }, { text: "Neon: $19 -> $19, unchanged [1]. Supabase: $25 [1]." }], "Has any of them changed pricing since Monday?", { sessionId: "chat", history: HISTORY });
    await events;
    expect(model.doStreamCalls[0]!.toolChoice).toEqual({ type: "required" });
    expect(systemOf(model)).not.toContain("ask ONE short question");
  });
  it("naming the product removes the ambiguity: no need to ask", async () => {
    const { model, events } = run([{ text: "ok" }], "Has HubSpot changed pricing since Monday?");
    await events;
    expect(model.doStreamCalls[0]!.toolChoice).not.toEqual({ type: "none" });
  });
  it("a lookup keeps search available", async () => {
    const { model, events } = run([{ text: "ok" }], "Who is the current CEO of Microsoft?");
    await events;
    expect(model.doStreamCalls[0]!.toolChoice).not.toEqual({ type: "none" });
  });
});

describe("memory reaches the prompt", () => {
  it("retrieves a months-old conversation by topic, even when the recency ledger is full of newer chats", async () => {
    seed("pg", "What's the cheapest managed Postgres hosting?", "Neon free tier; Supabase Pro $25/mo [1].", "2026-08-12T09:00:00Z", "default", [{ id: 1, title: "Supabase", url: "https://supabase.com/pricing" }]);
    for (let i = 0; i < 60; i++) seed(`n${i}`, `Gardening question ${i} ${"x".repeat(180)}`, "Water.", `2026-11-0${(i % 9) + 1}T0${i % 9}:00:00Z`);
    const { model, events } = run([{ text: "ok" }], "Remind me, which Postgres host did you recommend?");
    await events;
    const system = systemOf(model);
    expect(system).toContain("# Relevant earlier conversations");
    expect(system).toContain('You asked: "What\'s the cheapest managed Postgres hosting?"');
    expect(system).toContain("Supabase Pro $25/mo (src: supabase.com)");
    expect(system).toContain("older conversations omitted"); // the ledger really had dropped it
    expect(done(await events)).toMatchObject({ retrieved: 1 });
  });
  it("answers 'last week' from the stored record for exactly that span", async () => {
    seed("w1", "Compare Vercel and Netlify", "Both $20.", "2026-11-04T10:00:00Z");
    seed("w2", "What is Bun?", "A runtime.", "2026-11-06T10:00:00Z");
    seed("w3", "Out of range question", "x", "2026-11-09T10:00:00Z"); // Monday of THIS week
    const { model, events } = run([{ text: "ok" }], "What did I ask you last week?");
    await events;
    const system = systemOf(model);
    expect(system).toContain('"last week" = Mon 2 Nov 2026 to Sun 8 Nov 2026');
    expect(system).toContain("4 stored message(s)");
    expect(system).toContain('"Compare Vercel and Netlify"');
    expect(system).toContain('"What is Bun?"');
    expect(system).not.toContain('"Out of range question"');
  });
  it("says so when a span has nothing stored", async () => {
    seed("x", "Something in September", "y", "2026-09-15T10:00:00Z");
    const { model, events } = run([{ text: "ok" }], "What did we discuss in October?");
    await events;
    expect(systemOf(model)).toContain("NO stored messages in that span");
    expect(systemOf(model)).toContain("Nearest days with records: Tue 15 Sep 2026");
  });
  it("never leaks another user's conversations into the prompt, ledger, retrieval or lookup", async () => {
    seed("theirs", "Our secret acquisition of Initech", "Confidential plan [1].", "2026-11-03T09:00:00Z", "bob");
    const { model, events } = run([{ text: "ok" }], "What did I ask about Initech on 3 November?", { userId: "alice" });
    await events;
    expect(systemOf(model)).not.toContain("Initech acquisition");
    expect(systemOf(model)).not.toContain("secret acquisition");
    expect(systemOf(model)).toContain("NO stored messages on that day");
  });
  it("MEMORY_SCOPE=session confines retrieval and lookup to the current chat", async () => {
    seed("elsewhere", "Cheapest Postgres hosting?", "Neon.", "2026-11-03T09:00:00Z");
    const model = scriptedModel([{ text: "ok" }]);
    await collect(runAgent({ models: ModelPool.single(model), provider: fakeProvider(), store, memoryScope: "session" }, { sessionId: "isolated", message: "What did I ask on 3 November about Postgres?", tz: TZ, now: NOW }));
    expect(systemOf(model)).not.toContain("Cheapest Postgres hosting?");
  });
});

describe("verification and repair", () => {
  const bad = { text: "Neon Launch costs $37 per month [1]." };

  it("a clean, cited answer passes untouched and is saved with its verification report", async () => {
    const { model, events } = run([{ tools: [{ input: { query: "neon pricing" } }] }, { text: "Neon Launch has a typical spend of $19 per month [1]." }], "How much is Neon?");
    const evs = await events;
    expect(model.doStreamCalls).toHaveLength(2);
    expect(report(evs)).toMatchObject({ ok: true, checked: 1, verified: 1 });
    expect(done(evs).repaired).toBe(false);
    expect(evs.some((e) => e.type === "status" && /Double-checking/.test(e.text))).toBe(false);
    expect((store.sessionMessages("now")[1]!.verification as VerificationReport).ok).toBe(true);
  });

  it("an invented price triggers one repair, the user watches the correction, and the corrected answer is what is saved", async () => {
    const { model, events } = run([
      { tools: [{ input: { query: "neon pricing" } }] }, bad,
      { text: "Neon Launch has a typical spend of $19 per month [1]." },
    ], "How much is Neon?");
    const evs = await events;
    expect(model.doStreamCalls).toHaveLength(3);
    expect(evs.some((e) => e.type === "status" && /Double-checking/.test(e.text))).toBe(true);
    expect(textOf(evs)).toBe("Neon Launch has a typical spend of $19 per month [1].");
    expect(report(evs)).toMatchObject({ ok: true });
    expect(done(evs).repaired).toBe(true);
    expect(store.sessionMessages("now")[1]!.content).toBe("Neon Launch has a typical spend of $19 per month [1].");
    // the repair prompt carries the evidence and the exact problem, and no tools
    const repairPrompt = JSON.stringify(model.doStreamCalls[2]!.prompt);
    expect(repairPrompt).toContain("typical spend $19 per month");
    expect(repairPrompt).toContain('The figure \\"$37\\" appears in no source');
    expect(model.doStreamCalls[2]!.tools ?? []).toHaveLength(0);
  });

  it("if the rewrite is no better, the original answer is put back and the problem stays flagged", async () => {
    const { events } = run([{ tools: [{ input: { query: "neon pricing" } }] }, bad, { text: "Neon Launch costs $41 per month [1]." }], "How much is Neon?");
    const evs = await events;
    expect(textOf(evs)).toBe("Neon Launch costs $37 per month [1].");
    expect(done(evs).repaired).toBe(false);
    expect(report(evs).ok).toBe(false);
    expect(report(evs).figures.map((f) => f.status)).toEqual(["unsupported"]);
    expect((store.sessionMessages("now")[1]!.verification as VerificationReport).ok).toBe(false);
  });

  it("a wrongly numbered citation is corrected in code: no repair call, no extra latency", async () => {
    const { model, events } = run([
      { tools: [{ input: { query: "neon pricing" } }, { input: { query: "supabase pricing" } }] },
      { text: "Neon Launch has a typical spend of $19 per month [2]. Supabase Pro is $25 per month [1]." }, // numbers swapped
    ], "Compare Neon and Supabase pricing");
    const evs = await events;
    expect(model.doStreamCalls).toHaveLength(2);                        // the tool round and the answer: nothing else
    expect(textOf(evs)).toBe("Neon Launch has a typical spend of $19 per month [1]. Supabase Pro is $25 per month [2].");
    expect(report(evs)).toMatchObject({ ok: true });
    expect(done(evs)).toMatchObject({ citationsFixed: 2, repaired: false });
    expect(store.sessionMessages("now")[1]!.content).toBe(textOf(evs));
  });

  it("a failing repair call never loses the answer", async () => {
    const { events } = run([{ tools: [{ input: { query: "neon pricing" } }] }, bad, { error: Object.assign(new Error("down"), { statusCode: 500 }) }], "How much is Neon?");
    const evs = await events;
    expect(textOf(evs)).toBe("Neon Launch costs $37 per month [1].");
    expect(evs.at(-1)?.type).toBe("done");
    expect(store.sessionMessages("now")).toHaveLength(2);
  });

  it("a re-verification that skips an entity is repaired to cover it", async () => {
    const { model, events } = run([
      { tools: [{ input: { query: "neon pricing" } }, { input: { query: "supabase pricing" } }] },
      { text: "Neon: $19 -> $19, unchanged [1]." },                                     // forgot Supabase
      { text: "Neon: $19 -> $19, unchanged [1]. Supabase: $25 -> $25, unchanged [2]." },
    ], "Is that still correct?", { sessionId: "chat", history: HISTORY });
    const evs = await events;
    expect(model.doStreamCalls).toHaveLength(3);
    expect(JSON.stringify(model.doStreamCalls[2]!.prompt)).toContain('\\"Supabase Pro\\" was in your earlier answer but this answer never addresses it');
    expect(textOf(evs)).toContain("Supabase");
    expect(report(evs).uncovered).toEqual([]);
    expect(done(evs).repaired).toBe(true);
  });

  it("a dangling citation is repaired", async () => {
    const { events } = run([
      { tools: [{ input: { query: "neon pricing" } }] }, { text: "Neon Launch is about $19 per month [1][4]." },
      { text: "Neon Launch is about $19 per month [1]." },
    ], "How much is Neon?");
    const evs = await events;
    expect(textOf(evs)).toBe("Neon Launch is about $19 per month [1].");
    expect(report(evs).dangling).toEqual([]);
  });

  it("recall turns are not 'repaired' for quoting old figures from memory", async () => {
    seed("old", "How much is Neon?", "Neon Launch is about $19/mo.", "2026-11-03T08:30:00Z");
    const { model, events } = run([{ text: "On Tue 3 Nov you asked how much Neon is, and I said about $19/mo." }], "What did I ask you on 3 November?");
    const evs = await events;
    expect(model.doStreamCalls).toHaveLength(1);
    expect(report(evs).ok).toBe(true);
  });

  it("recalling an old recommendation keeps the remembered prices instead of 'repairing' them away (regression from a live run)", async () => {
    seed("aug", "What's the cheapest managed Postgres hosting?", "Neon Launch is about $19/mo [1]. Supabase Pro is $25/mo [2].", "2026-08-12T09:00:00Z", "default",
      [{ id: 1, title: "Neon", url: "https://neon.com/pricing" }, { id: 2, title: "Supabase", url: "https://supabase.com/pricing" }]);
    const { model, events } = run([{ text: "On Wed 12 Aug I recommended Neon (Launch about $19/mo) and Supabase (Pro $25/mo)." }], "Remind me, which Postgres host did you recommend a while back?");
    const evs = await events;
    expect(model.doStreamCalls).toHaveLength(1);                       // no search, no repair call
    expect(model.doStreamCalls[0]!.toolChoice).toEqual({ type: "none" });
    expect(report(evs)).toMatchObject({ ok: true });
    expect(textOf(evs)).toContain("$19");
    expect(done(evs)).toMatchObject({ intent: "recall", repaired: false, retrieved: 1 });
  });

  it("when a figure from an earlier answer is stated as if current, the repair prompt carries the earlier conversation and says to attribute it", async () => {
    seed("aug", "What's the cheapest managed Postgres hosting?", "Neon Launch is about $19/mo [1].", "2026-08-12T09:00:00Z", "default", [{ id: 1, title: "Neon", url: "https://neon.com/pricing" }]);
    const { model, events } = run([
      { tools: [{ input: { query: "supabase pricing" } }] },
      { text: "Neon Launch costs $19 per month, and Supabase Pro is $25 per month [1]." },   // $19 stated as current, no source
      { text: "On 12 Aug I said Neon Launch was about $19/mo. Supabase Pro is $25 per month [1]." },
    ], "Compare Postgres hosting pricing: Neon and Supabase");
    const evs = await events;
    const repair = JSON.stringify(model.doStreamCalls[2]!.prompt);
    expect(repair).toContain("EARLIER CONVERSATION");
    expect(repair).toContain("Neon Launch is about $19/mo");
    expect(repair).toContain("say so explicitly");
    expect(textOf(evs)).toContain("On 12 Aug I said Neon Launch was about $19/mo");
    expect(report(evs).ok).toBe(true);
  });

  it("the report is returned with the history, so the UI can show it after a reload", async () => {
    const { events } = run([{ tools: [{ input: { query: "neon pricing" } }] }, { text: "Neon Launch has a typical spend of $19 per month [1]." }], "How much is Neon?");
    await events;
    const saved = store.sessionMessages("now");
    expect(saved[0]!.verification).toBeUndefined();
    expect(saved[1]!.verification).toMatchObject({ ok: true, checked: 1 });
  });
});
