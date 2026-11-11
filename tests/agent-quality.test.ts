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
    expect(systemOf(model)).toContain('- Neon Launch, as you said on Tue 3 Nov 2026: "Neon Launch is about $19/mo.');
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

  it("regression from a real answer: no leaked notes, no junk claims, no irrelevant citations, and the vendor's own page is found", async () => {
    const earlier = [
      { role: "user" as const, content: "Compare managed Postgres hosting for a SaaS", timestamp: new Date("2026-11-09T09:00:00Z") },
      { role: "assistant" as const, timestamp: new Date("2026-11-09T09:01:00Z"), content: [
        "**Total Cost of Ownership**: managed services (starting at ~$15-$25/month) are often more cost-effective than DIY hosting.",
        "**DIY Hosting**: managed services give better value for production than DIY at about $15/month.",
        "Railway starts at $5/month.",
      ].join("\n") },
    ];
    const calls: { query: string; includeDomains?: string[] }[] = [];
    const provider = { async search(req: { query: string; includeDomains?: string[] }) {
      calls.push({ query: req.query, includeDomains: req.includeDomains });
      return req.includeDomains
        ? [{ title: "Railway Pricing", url: "https://railway.com/pricing", content: "Railway Hobby plan is $5 per month" }]
        : [{ title: "Rail programs", url: "https://www.michigan.gov/mdot/rail", content: "State railroad safety grants" }, { title: "News", url: "https://hoyle.house.gov/news", content: "Transport funding statement" }];
    } };
    const { model, events } = run([
      { tools: [{ input: { query: "Railway pricing" } }] },
      { text: "Railway: No pricing changes have been reported since Monday [2][3] [said Wed 11 Nov 2026]." },
      { text: "Railway: its pricing page lists the Hobby plan at $5 per month, the same as before [1]." },
    ], "Has any of them changed pricing since Monday?", { sessionId: "chat", history: earlier, provider });
    const evs = await events;

    // the checklist has the products, not the headings
    const checklist = systemOf(model).split("# Claims from your earlier answers")[1]!;
    expect(checklist).toContain("Railway, as you said on Mon 9 Nov 2026");
    expect(checklist).not.toMatch(/Total Cost of Ownership|DIY Hosting/);
    // the vendor's own site was hunted for, because the first results had none
    expect(calls).toHaveLength(2);
    expect(calls[1]!.includeDomains).toContain("railway.com");
    // the answer that cited government pages was caught, and the citation was swapped for the official page in code: no repair call
    expect(model.doStreamCalls).toHaveLength(2);
    expect(textOf(evs)).toBe("Railway: No pricing changes have been reported since Monday [1].");
    expect(textOf(evs)).not.toContain("[said");
    expect(report(evs)).toMatchObject({ ok: true, weakCitations: [] });
    expect(done(evs)).toMatchObject({ repaired: false, citationsFixed: 1 });
    expect(evs.flatMap((e) => (e.type === "sources" ? e.items : [])).map((x) => x.url)).toEqual(["https://railway.com/pricing"]);
  });

  it("notes from our own prompt that a model copies into its answer are removed before the user keeps them", async () => {
    const { events } = run([{ tools: [{ input: { query: "neon pricing" } }] }, { text: "Neon Launch has a typical spend of $19 per month [1] [said Tue 3 Nov 2026] (src: neon.tech)." }], "How much is Neon?");
    const evs = await events;
    expect(textOf(evs)).toBe("Neon Launch has a typical spend of $19 per month [1].");
    expect(store.sessionMessages("now")[1]!.content).toBe("Neon Launch has a typical spend of $19 per month [1].");
    // what streamed was replaced by the clean version, so the screen matches what is saved
    const resets = evs.filter((e) => e.type === "reset").length;
    expect(resets).toBeGreaterThanOrEqual(1);
  });

  it("a 'no change' answer is repaired when a source dated inside the window describes a change (from a live run)", async () => {
    const provider = fakeProvider({
      "neon pricing": [{ title: "Neon news", url: "https://neon.com/blog", content: "Neon increased the free tier limits on Nov 10; the Launch plan stays at $19 per month", publishedDate: "2026-11-10" }],
      "supabase pricing": [{ title: "Supabase", url: "https://supabase.com/pricing", content: "Supabase Pro is $25 per month", publishedDate: "2026-11-01" }],
    });
    const { model, events } = run([
      { tools: [{ input: { query: "neon pricing" } }, { input: { query: "supabase pricing" } }] },
      { text: "Neon: $19 -> $19, unchanged [1]. Supabase: $25 -> $25, unchanged [2]." },
      { text: "Neon: the Launch plan is still $19, but on 10 Nov Neon increased the free tier limits [1]. Supabase: $25 -> $25, unchanged [2]." },
    ], "Is that still correct?", { sessionId: "chat", history: HISTORY, provider });
    const evs = await events;
    expect(JSON.stringify(model.doStreamCalls[2]!.prompt)).toContain("You say nothing changed for Neon, but source [1] (published 2026-11-10)");
    expect(JSON.stringify(model.doStreamCalls[2]!.prompt)).not.toContain("nothing changed for Supabase"); // its source is older than the window
    expect(textOf(evs)).toContain("increased the free tier limits");
    expect(report(evs)).toMatchObject({ ok: true, overlooked: [] });
    expect(done(evs).repaired).toBe(true);
  });

  it("when every search fails, a 'no changes found' answer is refused and rewritten as an honest 'could not verify'", async () => {
    const dead = { async search() { throw new Error('Tavily 432: {"detail":{"error":"This request exceeds your plan\'s set usage limit."}}'); } };
    const { model, events } = run([
      { tools: [{ input: { query: "neon pricing" } }, { input: { query: "supabase pricing" } }] },
      { text: "No changes found as of today. The figures I provided on 3 Nov remain the latest available." },
      { text: "I could not verify whether pricing has changed: web search is unavailable right now. On 3 Nov I said Neon Launch was about $19/mo and Supabase Pro $25/mo; I can't confirm those still hold." },
    ], "Is that still correct?", { sessionId: "chat", history: HISTORY, provider: dead });
    const evs = await events;
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).toContain("SEARCH_UNAVAILABLE");
    expect(JSON.stringify(model.doStreamCalls[2]!.prompt)).toContain("No web evidence was retrieved this turn");
    expect(textOf(evs)).toContain("could not verify");
    expect(textOf(evs)).not.toContain("No changes found");
    expect(report(evs)).toMatchObject({ ok: true, unverifiedAbsence: false });
    expect(done(evs).repaired).toBe(true);
    expect(textOf(evs)).toContain("$19"); // earlier figures are kept, attributed to when they were said
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
