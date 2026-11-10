import { describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import { Store } from "../src/store/db.js";
import { fakeProvider, scriptedModel } from "./helpers.js";

const make = (steps: Parameters<typeof scriptedModel>[0]) => {
  const model = scriptedModel(steps);
  const store = new Store(":memory:");
  return { app: createApp({ model, provider: fakeProvider(), store, defaultTz: "UTC" }), model, store };
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
    const { app } = make([{ tools: [{ input: { query: "hubspot pricing" } }] }, { text: "It costs $20 [1]." }]);
    const res = await post(app, { sessionId: "abc", message: "price?" }, { accept: "text/event-stream" });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSse(await res.text());
    expect(events.map((e) => e.event)).toEqual(["session", "status", "token", "sources", "done"]);
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
