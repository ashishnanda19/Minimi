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
  it("orders only the providers that have keys: Anthropic, then the fastest free tier", () => {
    const cfg = loadConfig({ ...base, OPENROUTER_API_KEY: "o", GROQ_API_KEY: "g", GOOGLE_GENERATIVE_AI_API_KEY: "k" });
    expect(cfg.order).toEqual(["groq", "google", "openrouter"]);
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
      scriptedModel([{ error: limited("Please retry in 14s") }, { text: "Back and fine." }]),
      scriptedModel([{ error: limited("Rate limit reached. Please try again in 9s.") }, { text: "Back and fine." }]),
    ), slept);
    expect(slept).toEqual([9500]); // shortest hint (9s) + 500ms buffer; both are over the 8s short-retry threshold
    expect(events.some((e) => e.type === "status" && /Retrying in 10s/.test(e.text))).toBe(true);
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
      scriptedModel([{ error: limited("Please retry in 30s") }]),
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

describe("uncited answers after a search", () => {
  it("fails over to the next model when a model searched but cited nothing, and accepts the last as-is", async () => {
    const sloppy = scriptedModel([{ tools: [{ input: { query: "acme pricing" } }] }, { text: "Acme costs $49 a month." }]);
    const careful = scriptedModel([{ tools: [{ input: { query: "acme pricing" } }] }, { text: "Acme costs $49 a month [1]." }]);
    const events = await run(new ModelPool([
      { name: "sloppy", model: sloppy, cacheable: false },
      { name: "careful", model: careful, cacheable: false },
    ]));
    expect(events.at(-1)).toMatchObject({ type: "done", metrics: { model: "careful" } });

    // a lone model that never cites still gets through: failing forever would be worse
    const alone = await run(new ModelPool([{ name: "sloppy", model: scriptedModel([{ tools: [{ input: { query: "acme pricing" } }] }, { text: "Acme costs $49." }]), cacheable: false }]));
    expect(alone.at(-1)?.type).toBe("done");
  });
});

describe("plan-compatible settings", () => {
  it("accepts the plan's MODEL variable as the Anthropic model", () => {
    const cfg = loadConfig({ TAVILY_API_KEY: "t", ANTHROPIC_API_KEY: "a", MODEL: "claude-haiku-5-5" });
    expect(cfg.models.anthropic).toEqual(["claude-haiku-5-5"]);
    expect(loadConfig({ TAVILY_API_KEY: "t", ANTHROPIC_API_KEY: "a", MODEL: "x", ANTHROPIC_MODEL: "y" }).models.anthropic).toEqual(["y"]);
  });
  it("defaults memory to global and supports the plan's per-session scope", () => {
    expect(loadConfig({ TAVILY_API_KEY: "t", GROQ_API_KEY: "g" }).memoryScope).toBe("global");
    expect(loadConfig({ TAVILY_API_KEY: "t", GROQ_API_KEY: "g", MEMORY_SCOPE: "session" }).memoryScope).toBe("session");
  });
  it("session scope keeps other chats out of the prompt", async () => {
    store.ensureSession("old", "UTC", NOW);
    store.addMessages("old", [{ role: "user", content: "SECRET-OLD-QUESTION", createdAt: new Date("2026-11-03T08:30:00Z") }]);
    const ask = async (memoryScope: "global" | "session") => {
      const m = scriptedModel([{ text: "ok" }]);
      await collect(runAgent({ models: ModelPool.single(m), provider: fakeProvider(), store, memoryScope },
        { sessionId: `new-${memoryScope}`, message: "what did I ask on 3 November?", tz: "UTC", now: NOW }));
      return JSON.stringify(m.doStreamCalls[0]!.prompt);
    };
    expect(await ask("global")).toContain("SECRET-OLD-QUESTION");
    expect(await ask("session")).not.toContain("SECRET-OLD-QUESTION");
  });
});

describe("slow models", () => {
  it("benches a model that answered but took too long, so the next turn skips it", () => {
    let t = 0;
    const mk = (n: string) => ({ name: n, model: scriptedModel([{ text: "x" }]), cacheable: false });
    const pool = new ModelPool([mk("slow"), mk("fast")], () => t);
    pool.markOk("slow", 21_000);
    expect(pool.ordered().map((e) => e.name)).toEqual(["fast", "slow"]);
    t = 6 * 60_000;
    expect(pool.ordered()[0]!.name).toBe("slow"); // recovers after five minutes
    pool.markOk("slow", 3_000);                    // a fast turn clears any bench
    expect(pool.ordered()[0]!.name).toBe("slow");
  });
  it("never benches the only model", () => {
    const pool = new ModelPool([{ name: "only", model: scriptedModel([{ text: "x" }]), cacheable: false }]);
    pool.markOk("only", 60_000);
    expect(pool.ordered()[0]!.name).toBe("only");
  });
});

describe("deadlines", () => {
  const withTimeouts = (pool: ModelPool, timeouts: object, signal?: AbortSignal) =>
    collect(runAgent(
      { models: pool, provider: fakeProvider(), store, cache: new TtlCache<any>(10, 1000), timeouts },
      { sessionId: "s", message: "q", tz: "UTC", now: NOW, signal },
    ));

  it("abandons a model that never answers and fails over within the deadline, instead of hanging for a minute", async () => {
    const { hangingModel } = await import("./helpers.js");
    const started = performance.now();
    const events = await withTimeouts(new ModelPool([
      { name: "stuck", model: hangingModel(), cacheable: false },
      { name: "good", model: scriptedModel([{ text: "Answered promptly." }]), cacheable: false },
    ]), { firstChunkMs: 150, lastResortFirstChunkMs: 5_000 });
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(events.at(-1)).toMatchObject({ type: "done", metrics: { model: "good" } });
    expect((events.at(-1) as any).metrics.fallbacks[0].model).toBe("stuck");
    expect(store.sessionMessages("s")).toHaveLength(2);
  });

  it("a deadline hit is reported as a failure, not mistaken for the user cancelling", async () => {
    const { hangingModel } = await import("./helpers.js");
    const events = await withTimeouts(new ModelPool([{ name: "stuck", model: hangingModel(), cacheable: false }]), { lastResortFirstChunkMs: 150 });
    expect(events.at(-1)).toMatchObject({ type: "error" }); // an error the UI can show, not a silent empty turn
  });

  it("still treats a real user abort as silent", async () => {
    const { hangingModel } = await import("./helpers.js");
    const ctrl = new AbortController();
    const p = withTimeouts(new ModelPool([{ name: "stuck", model: hangingModel(), cacheable: false }]), { lastResortFirstChunkMs: 5_000 }, ctrl.signal);
    setTimeout(() => ctrl.abort(), 50);
    const events = await p;
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(store.sessionMessages("s")).toHaveLength(0);
  });
});

describe("short rate limits and timeouts", () => {
  const limited = (msg: string) => Object.assign(new Error(msg), { statusCode: 429 });

  it("waits out a rate limit that resets in seconds and retries the SAME model, instead of cascading to slower ones", async () => {
    const slept: number[] = [];
    const first = scriptedModel([{ error: limited("Rate limit reached. Please try again in 2.4s.") }, { text: "Answered after a short wait." }]);
    const second = scriptedModel([{ text: "should never be used" }]);
    const events = await collect(runAgent(
      { models: new ModelPool([{ name: "groq:fast", model: first, cacheable: false }, { name: "google:slow", model: second, cacheable: false }]),
        provider: fakeProvider(), store, sleep: async (ms) => { slept.push(ms); } },
      { sessionId: "s", message: "q", tz: "UTC", now: NOW },
    ));
    expect(slept).toEqual([2700]);
    expect(events.at(-1)).toMatchObject({ type: "done", metrics: { model: "groq:fast", fallbacks: [] } });
    expect(second.doStreamCalls).toHaveLength(0);
    expect(events.some((e) => e.type === "status" && /busy, retrying in 3s/.test(e.text))).toBe(true);
  });

  it("does this only once per turn, and never for long resets", async () => {
    const slept: number[] = [];
    const a = scriptedModel([{ error: limited("try again in 1s") }]);        // always limited
    const b = scriptedModel([{ error: limited("retry in 120s") }]);          // hint too long: no waiting
    const c = scriptedModel([{ text: "fine" }]);
    const events = await collect(runAgent(
      { models: new ModelPool([{ name: "a", model: a, cacheable: false }, { name: "b", model: b, cacheable: false }, { name: "c", model: c, cacheable: false }]),
        provider: fakeProvider(), store, sleep: async (ms) => { slept.push(ms); } },
      { sessionId: "s", message: "q", tz: "UTC", now: NOW },
    ));
    expect(slept).toEqual([1300]);                 // one wait, for a only
    expect(a.doStreamCalls).toHaveLength(2);       // a: first try + the single retry
    expect(events.at(-1)).toMatchObject({ type: "done", metrics: { model: "c" } });
  });

  it("benches a model that timed out for minutes, not seconds, so the next turn skips it", () => {
    let t = 0;
    const mk = (n: string) => ({ name: n, model: scriptedModel([{ text: "x" }]), cacheable: false });
    const pool = new ModelPool([mk("stuck"), mk("ok")], () => t);
    pool.markFailed("stuck", Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
    t = 4 * 60_000;
    expect(pool.ordered()[0]!.name).toBe("ok");
    t = 6 * 60_000;
    expect(pool.ordered()[0]!.name).toBe("stuck");
  });
});
