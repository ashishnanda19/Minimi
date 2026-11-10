import { beforeEach, describe, expect, it } from "vitest";
import { TtlCache } from "../src/lib/cache.js";
import { runAgent, MAX_STEPS, type AgentEvent } from "../src/agent/run.js";
import { Store } from "../src/store/db.js";
import { collect, fakeProvider, scriptedModel } from "./helpers.js";

const NOW = new Date("2026-11-10T13:15:00Z"); // Tue 10 Nov 2026, 18:45 IST
const TZ = "Asia/Kolkata";
let store: Store;
beforeEach(() => { store = new Store(":memory:"); });

const deps = (model: ReturnType<typeof scriptedModel>) => ({ model, provider: fakeProvider(), store, cache: new TtlCache<any>(10, 1000) });
const base = { sessionId: "s1", tz: TZ, now: NOW };

describe("agent loop", () => {
  it("fans out parallel searches, drops preamble, cites only what the answer uses, and persists the turn", async () => {
    const model = scriptedModel([
      { text: "Let me check. ", tools: [{ input: { query: "HubSpot pricing" } }, { input: { query: "Pipedrive pricing" } }] },
      { text: "Pipedrive is cheaper [2]; HubSpot starts higher [1]." },
    ]);
    const events = await collect(runAgent(deps(model), { ...base, message: "Compare HubSpot and Pipedrive" }));

    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "status")).toHaveLength(2);
    expect(types).toContain("reset"); // preamble discarded
    expect(types.at(-1)).toBe("done");

    const sources = events.find((e) => e.type === "sources") as Extract<AgentEvent, { type: "sources" }>;
    expect(sources.items.map((s) => s.id)).toEqual([1, 2]);

    const done = events.at(-1) as Extract<AgentEvent, { type: "done" }>;
    expect(done.metrics.searches).toHaveLength(2);
    expect(done.metrics.steps).toBe(2);

    const saved = store.sessionMessages("s1");
    expect(saved.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(saved[1]!.content).toBe("Pipedrive is cheaper [2]; HubSpot starts higher [1]."); // preamble not persisted
    expect(saved[1]!.sources).toHaveLength(2);
  });

  it("injects the calendar, timestamped turns and a dated ledger of OTHER chats into the prompt", async () => {
    store.ensureSession("old", TZ, NOW);
    store.addMessages("old", [
      { role: "user", content: "Which Postgres hosts are cheapest?", createdAt: new Date("2026-11-03T08:30:00Z") },
      { role: "assistant", content: "Neon starts free [1].", sources: [{ id: 1, title: "Neon", url: "https://neon.tech/pricing" }], createdAt: new Date("2026-11-03T08:31:00Z") },
    ]);
    const model = scriptedModel([{ text: "On Tue 3 Nov you asked about Postgres hosting." }]);
    await collect(runAgent(deps(model), { ...base, message: "What did I ask on 3 November?" }));

    const prompt = model.doStreamCalls[0]!.prompt;
    const system = prompt.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    expect(system).toContain("Tue 3 Nov 2026 (2026-11-03): 7 days ago, last Tuesday");
    expect(system).toContain("[Tue 3 Nov 2026, 14:00, 7 days ago] USER: Which Postgres hosts are cheapest?");
    expect(system).toContain("Neon starts free (src: neon.tech)."); // [1] rewritten into provenance
    const user = prompt.find((m) => m.role === "user")!;
    expect(JSON.stringify(user.content)).toContain("[Tue 10 Nov 2026, 18:45] What did I ask on 3 November?");
  });

  it("keeps the current chat as real turns, seeded history included", async () => {
    const model = scriptedModel([{ text: "ok" }]);
    await collect(runAgent(deps(model), {
      ...base, message: "Has any of them changed pricing since?",
      history: [
        { role: "user", content: "Shortlist: HubSpot, Pipedrive", timestamp: new Date("2026-11-09T05:00:00Z") },
        { role: "assistant", content: "Noted: HubSpot, Pipedrive.", timestamp: new Date("2026-11-09T05:00:20Z") },
      ],
    }));
    const turns = model.doStreamCalls[0]!.prompt.filter((m) => m.role !== "system");
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(turns[0]!.content)).toContain("[Mon 9 Nov 2026, 10:30] Shortlist: HubSpot, Pipedrive");
  });

  it("seeding the same history twice is idempotent", async () => {
    const history = [{ role: "user" as const, content: "hi", timestamp: new Date("2026-11-09T05:00:00Z") }];
    for (let i = 0; i < 2; i++) await collect(runAgent(deps(scriptedModel([{ text: "hello" }])), { ...base, message: `m${i}`, history }));
    expect(store.sessionMessages("s1").filter((m) => m.content === "hi")).toHaveLength(1);
  });

  it("forces prose on the last allowed step", async () => {
    const looping = Array.from({ length: 6 }, () => ({ tools: [{ input: { query: "again" } }] }));
    const model = scriptedModel([...looping.slice(0, MAX_STEPS - 1), { text: "Final answer." }]);
    await collect(runAgent(deps(model), { ...base, message: "q" }));
    expect(model.doStreamCalls).toHaveLength(MAX_STEPS);
    expect(model.doStreamCalls.at(-1)!.toolChoice).toEqual({ type: "none" });
  });

  it("on model failure: emits a friendly error and persists nothing, so retry cannot duplicate", async () => {
    const err = Object.assign(new Error("overloaded"), { statusCode: 529 });
    const events = await collect(runAgent(deps(scriptedModel([{ error: err }])), { ...base, message: "q" }));
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(store.sessionMessages("s1")).toHaveLength(0);

    await collect(runAgent(deps(scriptedModel([{ text: "fine" }])), { ...base, message: "q" }));
    expect(store.sessionMessages("s1").map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("survives a search outage: the model sees SEARCH_FAILED and still answers", async () => {
    const failing = { search: async () => { throw new Error("tavily down"); } };
    const model = scriptedModel([{ tools: [{ input: { query: "x corp pricing" } }] }, { text: "I couldn't verify that right now." }]);
    const events = await collect(runAgent({ ...deps(model), provider: failing }, { ...base, message: "price of x?" }));
    expect(events.at(-1)?.type).toBe("done");
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).toContain("SEARCH_FAILED");
  });

  it("stops quietly (no error, no persistence) when the client aborts", async () => {
    const ctrl = new AbortController();
    const model = scriptedModel([{ text: "partial" }]);
    const gen = runAgent(deps(model), { ...base, message: "q", signal: ctrl.signal });
    ctrl.abort();
    const events = await collect(gen);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(store.sessionMessages("s1")).toHaveLength(0);
  });
});
