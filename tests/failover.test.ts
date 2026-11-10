import { beforeEach, describe, expect, it } from "vitest";
import { ModelPool } from "../src/agent/models.js";
import { runAgent, type AgentEvent } from "../src/agent/run.js";
import { loadConfig } from "../src/config.js";
import { TtlCache } from "../src/lib/cache.js";
import { Store } from "../src/store/db.js";
import { collect, fakeProvider, scriptedModel } from "./helpers.js";

const NOW = new Date("2026-11-10T13:15:00Z");
const http = (statusCode: number) => Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
let store: Store;
beforeEach(() => { store = new Store(":memory:"); });

const run = (pool: ModelPool) =>
  collect(runAgent({ models: pool, provider: fakeProvider(), store, cache: new TtlCache<any>(10, 1000) }, { sessionId: "s", message: "q", tz: "UTC", now: NOW }));

describe("ModelPool", () => {
  it("benches a failed provider and recovers it after the cooldown", () => {
    let t = 0;
    const pool = new ModelPool([
      { name: "a", model: scriptedModel([{ text: "x" }]), cacheable: false },
      { name: "b", model: scriptedModel([{ text: "x" }]), cacheable: false },
    ], () => t);
    pool.markFailed("a", http(429));
    expect(pool.ordered().map((e) => e.name)).toEqual(["b", "a"]); // benched goes last, never dropped
    t = 59_000;
    expect(pool.ordered()[0]!.name).toBe("b");
    t = 61_000;
    expect(pool.ordered()[0]!.name).toBe("a");
  });

  it("benches bad keys much longer than rate limits", () => {
    let t = 0;
    const mk = (n: string) => ({ name: n, model: scriptedModel([{ text: "x" }]), cacheable: false });
    const pool = new ModelPool([mk("a"), mk("b")], () => t);
    pool.markFailed("a", http(401));
    t = 5 * 60_000;
    expect(pool.ordered()[0]!.name).toBe("b");
    t = 11 * 60_000;
    expect(pool.ordered()[0]!.name).toBe("a");
  });

  it("honours a long reset hint (daily quota) but re-checks within the hour", () => {
    let t = 0;
    const mk = (n: string) => ({ name: n, model: scriptedModel([{ text: "x" }]), cacheable: false });
    const pool = new ModelPool([mk("a"), mk("b")], () => t);
    pool.markFailed("a", Object.assign(new Error("Please retry in 12h49m9s"), { statusCode: 429, responseHeaders: { "retry-after": "46149" } }));
    t = 59 * 60_000;
    expect(pool.ordered()[0]!.name).toBe("b");   // still benched
    t = 61 * 60_000;
    expect(pool.ordered()[0]!.name).toBe("a");   // capped at one hour, not 12
  });

  it("reads the status through the SDK's RetryError wrapper", () => {
    let t = 0;
    const mk = (n: string) => ({ name: n, model: scriptedModel([{ text: "x" }]), cacheable: false });
    const pool = new ModelPool([mk("a"), mk("b")], () => t);
    pool.markFailed("a", Object.assign(new Error("retries exhausted"), { lastError: http(429) }));
    t = 70_000;
    expect(pool.ordered()[0]!.name).toBe("a"); // 60s rate-limit cooldown, not the 10-minute auth one
  });
});

describe("failover in the agent loop", () => {
  it("falls through a rate-limited provider to the next, and says which model answered", async () => {
    const limited = scriptedModel([{ error: http(429) }]);
    const healthy = scriptedModel([{ text: "Answer from the backup." }]);
    const pool = new ModelPool([
      { name: "google:gemini", model: limited, cacheable: false },
      { name: "groq:llama", model: healthy, cacheable: false },
    ]);
    const events = await run(pool);
    const done = events.at(-1) as Extract<AgentEvent, { type: "done" }>;
    expect(done.type).toBe("done");
    expect(done.metrics.model).toBe("groq:llama");
    expect(done.metrics.fallbacks).toHaveLength(1);
    expect(done.metrics.fallbacks[0]!.model).toBe("google:gemini");
    expect(events.some((e) => e.type === "status" && /switching/.test(e.text))).toBe(true);
    expect(store.sessionMessages("s").map((m) => m.role)).toEqual(["user", "assistant"]); // persisted exactly once
  });

  it("discards text a failing model had already streamed (reset) so answers never splice together", async () => {
    // First model: streams a tool call, then dies on the second step.
    const flaky = scriptedModel([{ text: "Partial garbage. ", tools: [{ input: { query: "some query" } }] }, { error: http(503) }]);
    const good = scriptedModel([{ text: "Clean answer." }]);
    const events = await run(new ModelPool([
      { name: "a", model: flaky, cacheable: false },
      { name: "b", model: good, cacheable: false },
    ]));
    let text = "";
    for (const e of events) { if (e.type === "reset") text = ""; else if (e.type === "token") text += e.text; }
    expect(text).toBe("Clean answer.");
    expect(store.sessionMessages("s")[1]!.content).toBe("Clean answer.");
  });

  it("a later request skips the benched provider instead of paying for another failure", async () => {
    const limited = scriptedModel([{ error: http(429) }]);
    const healthy = scriptedModel([{ text: "one" }, { text: "two" }]);
    const pool = new ModelPool([
      { name: "a", model: limited, cacheable: false },
      { name: "b", model: healthy, cacheable: false },
    ]);
    await run(pool);
    await run(pool);
    expect(limited.doStreamCalls).toHaveLength(1); // second request never touched it
    expect(healthy.doStreamCalls).toHaveLength(2);
  });

  it("treats an empty answer from a weak model as a failure and moves on", async () => {
    const mute = scriptedModel([{}]);
    const good = scriptedModel([{ text: "Real answer." }]);
    const events = await run(new ModelPool([
      { name: "weak", model: mute, cacheable: false },
      { name: "good", model: good, cacheable: false },
    ]));
    expect(events.at(-1)).toMatchObject({ type: "done", metrics: { model: "good" } });
  });

  it("reports one friendly error only when every provider has failed, and persists nothing", async () => {
    const events = await run(new ModelPool([
      { name: "a", model: scriptedModel([{ error: http(429) }]), cacheable: false },
      { name: "b", model: scriptedModel([{ error: http(503) }]), cacheable: false },
    ]));
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
    expect(store.sessionMessages("s")).toHaveLength(0);
  });

  it("sends non-Anthropic providers a single plain system string, with no cache markers", async () => {
    const m = scriptedModel([{ text: "ok" }]);
    await run(new ModelPool([{ name: "google:g", model: m, cacheable: false }]));
    const system = m.doStreamCalls[0]!.prompt.filter((p) => p.role === "system");
    expect(system).toHaveLength(1);
    expect(JSON.stringify(system)).not.toContain("cacheControl");
    expect(system[0]!.content).toContain("Calendar (authoritative");
  });
});

describe("config", () => {
  const base = { TAVILY_API_KEY: "t" };
  it("needs at least one model key and the search key", () => {
    expect(() => loadConfig({ TAVILY_API_KEY: "t" })).toThrow(/at least one model key/);
    expect(() => loadConfig({ GROQ_API_KEY: "g" })).toThrow(/TAVILY_API_KEY/);
  });
  it("orders only the providers that have keys, free ones after Anthropic by default", () => {
    const cfg = loadConfig({ ...base, OPENROUTER_API_KEY: "o", GROQ_API_KEY: "g", GOOGLE_GENERATIVE_AI_API_KEY: "k" });
    expect(cfg.order).toEqual(["google", "groq", "openrouter"]);
  });
  it("lets LLM_ORDER and *_MODEL (comma lists) override", () => {
    const cfg = loadConfig({ ...base, GROQ_API_KEY: "g", GOOGLE_GENERATIVE_AI_API_KEY: "k", LLM_ORDER: "groq,google", GROQ_MODEL: "llama-x, llama-y" });
    expect(cfg.order).toEqual(["groq", "google"]);
    expect(cfg.models.groq).toEqual(["llama-x", "llama-y"]);
  });
  it("chains several models per provider by default, because free quotas are per model", () => {
    const cfg = loadConfig({ ...base, GOOGLE_GENERATIVE_AI_API_KEY: "k" });
    expect(cfg.models.google.length).toBeGreaterThan(1);
  });
});

describe("broken tool-call markup", () => {
  it("is treated as a provider failure, never shown to the user", async () => {
    const broken = scriptedModel([{ text: '<tool_call>web_search<arg_key>query</arg_key><arg_value>x</arg_value></tool_call>' }]);
    const good = scriptedModel([{ text: "Proper answer." }]);
    const events = await run(new ModelPool([
      { name: "weak", model: broken, cacheable: false },
      { name: "good", model: good, cacheable: false },
    ]));
    let text = "";
    for (const e of events) { if (e.type === "reset") text = ""; else if (e.type === "token") text += e.text; }
    expect(text).toBe("Proper answer.");
    expect(events.at(-1)).toMatchObject({ type: "done", metrics: { model: "good" } });
  });
});

describe("everyone rate-limited", () => {
  const limited = (msg: string) => Object.assign(new Error(msg), { statusCode: 429 });
  const pool2 = (a: ReturnType<typeof scriptedModel>, b: ReturnType<typeof scriptedModel>) => new ModelPool([
    { name: "a", model: a, cacheable: false }, { name: "b", model: b, cacheable: false },
  ]);
  const runWith = (pool: ModelPool, slept: number[]) =>
    collect(runAgent(
      { models: pool, provider: fakeProvider(), store, cache: new TtlCache<any>(10, 1000), sleep: async (ms) => { slept.push(ms); } },
      { sessionId: "s", message: "q", tz: "UTC", now: NOW },
    ));

  it("waits for the SHORTEST hinted reset, tells the user, then succeeds instead of erroring", async () => {
    const slept: number[] = [];
    const events = await runWith(pool2(
      scriptedModel([{ error: limited("Please retry in 2.4s") }, { text: "Back and fine." }]),
      scriptedModel([{ error: limited("Rate limit reached. Please try again in 450ms.") }, { text: "Back and fine." }]),
    ), slept);
    expect(slept).toEqual([950]); // 450ms hint + 500ms buffer
    expect(events.some((e) => e.type === "status" && /Retrying in 1s/.test(e.text))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("uses a default wait when providers give no hint", async () => {
    const slept: number[] = [];
    await runWith(pool2(
      scriptedModel([{ error: limited("quota exceeded") }, { text: "ok" }]),
      scriptedModel([{ error: limited("too many requests") }, { text: "ok" }]),
    ), slept);
    expect(slept).toEqual([10_500]);
  });

  it("does not wait when the hinted reset is too long: fails fast with a friendly error", async () => {
    const slept: number[] = [];
    const events = await runWith(pool2(
      scriptedModel([{ error: limited("Please retry in 120s") }]),
      scriptedModel([{ error: limited("Please retry in 90s") }]),
    ), slept);
    expect(slept).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });

  it("never waits when any failure is something other than a rate limit", async () => {
    const slept: number[] = [];
    const events = await runWith(pool2(
      scriptedModel([{ error: limited("Please retry in 1s") }]),
      scriptedModel([{ error: Object.assign(new Error("bad key"), { statusCode: 401 }) }]),
    ), slept);
    expect(slept).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });

  it("gives up after one waiting round (no infinite loop)", async () => {
    const slept: number[] = [];
    const events = await runWith(new ModelPool([{ name: "a", model: scriptedModel([{ error: limited("Please retry in 1s") }]), cacheable: false }]), slept);
    expect(slept).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });
});
