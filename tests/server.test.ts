import { describe, expect, it } from "vitest";
import { ModelPool } from "../src/agent/models.js";
import { createApp } from "../src/server.js";
import { heuristicTitle } from "../src/agent/title.js";
import { Store } from "../src/store/db.js";
import { fakeProvider, scriptedModel } from "./helpers.js";

const make = (steps: Parameters<typeof scriptedModel>[0]) => {
  const model = scriptedModel(steps);
  const store = new Store(":memory:");
  return { app: createApp({ models: ModelPool.single(model), provider: fakeProvider(), store, defaultTz: "UTC", sleep: async () => {}, makeTitle: async (q: string) => heuristicTitle(q) }), model, store };
};
const post = (app: ReturnType<typeof make>["app"], body: object, headers: Record<string, string> = {}) =>
  app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

function parseSse(text: string) {
  return text.trim().split("\n\n").map((block) => {
    const event = /^event: (.*)$/m.exec(block)?.[1];
    const data = /^data: (.*)$/m.exec(block)?.[1];
    return { event, data: data ? JSON.parse(data) : null };
  });
}

describe("POST /api/chat", () => {
  it("streams session, status, token, sources and done events", async () => {
    const { app } = make([{ tools: [{ input: { query: "hubspot pricing" } }] }, { text: "The plan is listed on the pricing page [1]." }]);
    const res = await post(app, { sessionId: "abc", message: "price?" }, { accept: "text/event-stream" });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSse(await res.text());
    expect(events.map((e) => e.event)).toEqual(["session", "status", "token", "sources", "verification", "done", "title"]);
    expect(events[1]!.data.text).toBe("Searching: hubspot pricing");
    expect(events[3]!.data.items[0].url).toContain("example.com");
  });

  it("returns one JSON document by default (a plain POST works for scripts and harnesses)", async () => {
    const { app } = make([{ text: "Hello." }]);
    const res = await post(app, { message: "hi" });
    const body = await res.json();
    expect(body).toMatchObject({ answer: "Hello.", sources: [] });
    expect(body.sessionId).toMatch(/[0-9a-f-]{36}/);
    expect(body.metrics.totalMs).toBeGreaterThan(0);
  });

  it("rejects bad input with a readable 400", async () => {
    const { app } = make([{ text: "x" }]);
    for (const body of [{ message: "   " }, { message: "x".repeat(5000) }, { message: "ok", sessionId: "../etc" }, {}]) {
      const res = await post(app, body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBeTruthy();
    }
    expect((await app.request("/api/chat", { method: "POST", body: "not json" })).status).toBe(400);
  });

  it("uses the client's timezone, remembers it per session, and ignores invalid zones", async () => {
    const { app, model, store } = make([{ text: "ok" }]);
    await post(app, { sessionId: "s", message: "a", tz: "Asia/Kolkata", now: "2026-11-09T19:00:00Z" }, { accept: "application/json" });
    expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).toContain("Tue 10 Nov 2026, 00:30");
    await post(app, { sessionId: "s", message: "b", tz: "Not/AZone" }, { accept: "application/json" });
    expect(store.sessionTz("s")).toBe("Asia/Kolkata");
  });

  it("remembers across chats: a NEW session sees an earlier session in its ledger", async () => {
    const { app, model } = make([{ text: "Postgres hosting: Neon is cheapest." }, { text: "You asked about Postgres hosting." }]);
    await post(app, { sessionId: "monday-chat", message: "Cheapest Postgres hosting?", now: "2026-11-03T09:00:00Z" }, { accept: "application/json" });
    await post(app, { sessionId: "fresh-chat", message: "What did I ask on 3 Nov?", now: "2026-11-10T09:00:00Z" }, { accept: "application/json" });
    const system = JSON.stringify(model.doStreamCalls[1]!.prompt);
    expect(system).toContain("USER: Cheapest Postgres hosting?");
    expect(system).toContain("7 days ago");
  });

  it("seeds history from the request and serves it back", async () => {
    const { app } = make([{ text: "ok" }]);
    await post(app, {
      sessionId: "h", message: "now?", accept: undefined,
      history: [{ role: "user", content: "Shortlist: A, B", timestamp: "2026-11-09T05:00:00Z" }],
    }, { accept: "application/json" });
    const hist = await (await app.request("/api/history?sessionId=h")).json();
    expect(hist.messages.map((m: any) => m.content)).toEqual(["Shortlist: A, B", "now?", "ok"]);
  });

  it("accepts sloppy history: missing, date-only and unix-ms timestamps", async () => {
    const { app, model } = make([{ text: "ok" }]);
    const res = await post(app, {
      message: "and now?", now: "2026-11-10T09:00:00Z",
      history: [
        { role: "user", content: "no timestamp" },
        { role: "assistant", content: "date only", timestamp: "2026-11-09" },
        { role: "user", content: "unix ms", timestamp: Date.parse("2026-11-09T12:00:00Z") },
        { role: "assistant", content: "garbage", timestamp: "yesterday-ish" },
      ],
    });
    expect(res.status).toBe(200);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("serialises concurrent requests on one session (no interleaved history)", async () => {
    const { app, store } = make([{ text: "one" }, { text: "two" }]);
    await Promise.all([1, 2].map((n) => post(app, { sessionId: "c", message: `m${n}` }, { accept: "application/json" })));
    const roles = store.sessionMessages("c").map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("reports a friendly error and persists nothing on model failure", async () => {
    const { app, store } = make([{ error: Object.assign(new Error("x"), { statusCode: 429 }) }]);
    const res = await post(app, { sessionId: "e", message: "q" }, { accept: "application/json" });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/rate limiting/);
    expect(store.sessionMessages("e")).toHaveLength(0);
  });
});

describe("static", () => {
  it("serves the UI shell", async () => {
    const { app } = make([{ text: "x" }]);
    expect((await app.request("/health")).status).toBe(200);
  });
});

describe("conversation list (sidebar)", () => {
  const chat = (app: ReturnType<typeof make>["app"], sessionId: string, message: string, now: string) =>
    post(app, { sessionId, message, now }, { accept: "application/json" });

  it("lists conversations newest first, titled by the first question", async () => {
    const { app } = make([{ text: "a" }, { text: "b" }, { text: "c" }]);
    await chat(app, "old", "What is the cheapest Postgres host?", "2026-11-03T09:00:00Z");
    await chat(app, "new", "Compare   CRM tools\nfor a sales team", "2026-11-09T09:00:00Z");
    await chat(app, "old", "and Neon specifically?", "2026-11-10T09:00:00Z"); // activity bumps it to the top
    const { sessions } = await (await app.request("/api/sessions")).json();
    expect(sessions.map((s: any) => s.id)).toEqual(["old", "new"]);
    expect(sessions[0].title).toBe("Cheapest Postgres host"); // summarised: the question word is dropped
    expect(sessions[1].title).toBe("Compare CRM tools for a sales team"); // whitespace collapsed
    expect(sessions[0].updatedAt).toMatch(/^2026-11-10/);
  });

  it("does not list empty sessions or failed first turns", async () => {
    const { app } = make([{ error: Object.assign(new Error("x"), { statusCode: 401 }) }]);
    await chat(app, "failed", "hello", "2026-11-09T09:00:00Z");
    expect((await (await app.request("/api/sessions")).json()).sessions).toEqual([]);
  });

  it("deletes a conversation, including from memory, and validates the id", async () => {
    const { app, store } = make([{ text: "a" }]);
    await chat(app, "gone", "remember this", "2026-11-09T09:00:00Z");
    expect((await (await app.request("/api/sessions/gone", { method: "DELETE" })).json()).ok).toBe(true);
    expect(store.sessionMessages("gone")).toHaveLength(0);
    expect(store.earlierMessages("other", 10)).toHaveLength(0);
    expect((await (await app.request("/api/sessions/gone", { method: "DELETE" })).json()).ok).toBe(false);
    expect((await app.request("/api/sessions/bad%20id!", { method: "DELETE" })).status).toBe(400);
  });
});

describe("memory panel", () => {
  it("lists the most recent distinct questions across chats, newest first, each pointing at its chat", async () => {
    const { app } = make([{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }]);
    const ask = (sessionId: string, message: string, now: string) => post(app, { sessionId, message, now }, { accept: "application/json" });
    await ask("one", "Cheapest Postgres host?", "2026-11-03T09:00:00Z");
    await ask("two", "Shortlist 5 CRM tools", "2026-11-09T09:00:00Z");
    await ask("three", "cheapest postgres host?", "2026-11-10T09:00:00Z"); // same question, different case: one memory
    await ask("three", "What changed in Node 26?", "2026-11-10T10:00:00Z");
    const { memories } = await (await app.request("/api/memories")).json();
    expect(memories.map((m: any) => m.text)).toEqual(["What changed in Node 26?", "cheapest postgres host?", "Shortlist 5 CRM tools"]);
    expect(memories[1].sessionId).toBe("three"); // the newest ask of the repeated question
    expect(memories[0].createdAt).toMatch(/^2026-11-10T10/);
  });
  it("is empty before any conversation", async () => {
    const { app } = make([{ text: "x" }]);
    expect((await (await app.request("/api/memories")).json()).memories).toEqual([]);
  });
});

describe("users are isolated over the API", () => {
  const as = (user: string | undefined): Record<string, string> => (user ? { "x-user-id": user } : {});
  const send = (app: ReturnType<typeof make>["app"], user: string | undefined, body: object) =>
    post(app, body, { accept: "application/json", ...as(user) });
  const get = (app: ReturnType<typeof make>["app"], path: string, user?: string) => app.request(path, { headers: as(user) });

  it("each browser sees only its own chats and memories", async () => {
    const { app } = make([{ text: "a" }, { text: "b" }]);
    await send(app, "alice", { sessionId: "a1", message: "Cheapest Postgres host?" });
    await send(app, "bob", { sessionId: "b1", message: "Best CRM for sales?" });
    const list = async (u: string) => (await (await get(app, "/api/sessions", u)).json()).sessions.map((s: any) => s.id);
    expect(await list("alice")).toEqual(["a1"]);
    expect(await list("bob")).toEqual(["b1"]);
    const mem = async (u: string) => (await (await get(app, "/api/memories", u)).json()).memories.map((m: any) => m.text);
    expect(await mem("alice")).toEqual(["Cheapest Postgres host?"]);
    expect(await mem("bob")).toEqual(["Best CRM for sales?"]);
  });
  it("someone else's chat reads as empty, cannot be written to, and cannot be deleted", async () => {
    const { app, store } = make([{ text: "a" }, { text: "b" }]);
    await send(app, "alice", { sessionId: "a1", message: "private question" });
    const hist = await (await get(app, "/api/history?sessionId=a1", "bob")).json();
    expect(hist.messages).toEqual([]);
    const write = await send(app, "bob", { sessionId: "a1", message: "let me in" });
    expect(write.status).toBe(403);
    expect((await (await app.request("/api/sessions/a1", { method: "DELETE", headers: as("bob") })).json()).ok).toBe(false);
    expect(store.sessionMessages("a1")).toHaveLength(2); // untouched
  });
  it("a malformed user id falls back to the shared default instead of failing", async () => {
    const { app } = make([{ text: "a" }]);
    await send(app, "bad id with spaces!", { sessionId: "d1", message: "hello there friend" });
    expect((await (await get(app, "/api/sessions")).json()).sessions.map((s: any) => s.id)).toEqual(["d1"]); // visible to the default user
  });
  it("memory is shared across one user's chats but not across users", async () => {
    const { app, model } = make([{ text: "a" }, { text: "b" }, { text: "c" }]);
    await send(app, "alice", { sessionId: "a1", message: "Cheapest Postgres hosting?", now: "2026-11-03T09:00:00Z" });
    await send(app, "alice", { sessionId: "a2", message: "What did I ask on 3 November?", now: "2026-11-10T09:00:00Z" });
    await send(app, "bob", { sessionId: "b1", message: "What did I ask on 3 November?", now: "2026-11-10T09:00:00Z" });
    const prompt = (n: number) => JSON.stringify(model.doStreamCalls[n]!.prompt);
    expect(prompt(1)).toContain("Cheapest Postgres hosting?");
    expect(prompt(2)).not.toContain("Cheapest Postgres hosting?");
  });
});

describe("titles", () => {
  const withTitle = (makeTitle: (q: string) => Promise<string>) => {
    const model = scriptedModel([{ text: "Hello." }, { text: "Again." }]);
    const store = new Store(":memory:");
    return { store, app: createApp({ models: ModelPool.single(model), provider: fakeProvider(), store, defaultTz: "UTC", sleep: async () => {}, makeTitle }) };
  };

  it("the first turn gets a summarised title in the JSON response and in the sidebar", async () => {
    const { app } = withTitle(async () => "Postgres hosting costs");
    const body = await (await post(app, { sessionId: "t1", message: "What's the cheapest managed Postgres hosting for a small SaaS?" })).json();
    expect(body.title).toBe("Postgres hosting costs");
    expect((await (await app.request("/api/sessions")).json()).sessions[0].title).toBe("Postgres hosting costs");
  });
  it("streams a title event after the answer", async () => {
    const { app } = withTitle(async () => "CRM pricing check");
    const res = await post(app, { sessionId: "t2", message: "hello" }, { accept: "text/event-stream" });
    const events = parseSse(await res.text());
    expect(events.at(-1)).toMatchObject({ event: "title", data: { title: "CRM pricing check" } });
  });
  it("a failed or slow title model still gives an instant deterministic title", async () => {
    const { app } = withTitle(() => Promise.reject(new Error("rate limited")));
    const body = await (await post(app, { sessionId: "t3", message: "Can you tell me what's the latest Node LTS?" })).json();
    expect(body.title).toBe("Latest Node LTS");
  });
  it("the title is generated once, on the first turn only", async () => {
    let calls = 0;
    const { app } = withTitle(async () => { calls++; return "First title"; });
    await post(app, { sessionId: "t4", message: "first" });
    await post(app, { sessionId: "t4", message: "second" });
    expect(calls).toBe(1);
    expect((await (await app.request("/api/sessions")).json()).sessions[0].title).toBe("First title");
  });
  it("the title is available on reload through the history endpoint", async () => {
    const { app } = withTitle(async () => "Remembered title");
    await post(app, { sessionId: "t5", message: "hi there" });
    expect((await (await app.request("/api/history?sessionId=t5")).json()).title).toBe("Remembered title");
  });
});

describe("verification over the API", () => {
  it("the JSON response and the history both carry the report", async () => {
    const { app } = make([{ text: "The plan is listed on the pricing page." }]);
    const body = await (await post(app, { sessionId: "v1", message: "tell me about it" })).json();
    expect(body.verification).toMatchObject({ ok: true, checked: 0 });
    const hist = await (await app.request("/api/history?sessionId=v1")).json();
    expect(hist.messages[1].verification).toMatchObject({ ok: true });
  });
});
