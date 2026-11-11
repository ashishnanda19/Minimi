import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_USER, Store } from "../src/store/db.js";

const NOW = new Date("2026-11-10T09:00:00Z");
const at = (iso: string) => new Date(iso);
let store: Store;
beforeEach(() => { store = new Store(":memory:"); });

function chat(s: Store, user: string, id: string, q: string, a: string, iso: string) {
  s.ensureSession(id, "UTC", NOW, user);
  s.addMessages(id, [{ role: "user", content: q, createdAt: at(iso) }, { role: "assistant", content: a, createdAt: new Date(at(iso).getTime() + 5_000) }]);
}

describe("users never see each other's conversations", () => {
  beforeEach(() => {
    chat(store, "alice", "a1", "Cheapest Postgres host?", "Neon.", "2026-11-03T09:00:00Z");
    chat(store, "bob", "b1", "Best CRM for sales?", "HubSpot.", "2026-11-04T09:00:00Z");
  });
  it("lists only your own chats and memories", () => {
    expect(store.listSessions("alice").map((s) => s.id)).toEqual(["a1"]);
    expect(store.listSessions("bob").map((s) => s.id)).toEqual(["b1"]);
    expect(store.recentQuestions("alice").map((m) => m.text)).toEqual(["Cheapest Postgres host?"]);
  });
  it("memory for the agent is scoped the same way", () => {
    expect(store.earlierMessages("new", 50, "alice").map((m) => m.sessionId)).toEqual(["a1", "a1"]);
    expect(store.earlierMessages("new", 50, "bob").map((m) => m.content)).not.toContain("Neon.");
  });
  it("blocks reading or deleting someone else's session, and an unseen session is open to all", () => {
    expect(store.canAccess("a1", "alice")).toBe(true);
    expect(store.canAccess("a1", "bob")).toBe(false);
    expect(store.canAccess("brand-new", "bob")).toBe(true);
    expect(store.deleteSession("a1", "bob")).toBe(false);
    expect(store.sessionMessages("a1")).toHaveLength(2);
    expect(store.deleteSession("a1", "alice")).toBe(true);
  });
  it("the first user to touch a session owns it", () => {
    store.ensureSession("a1", "UTC", NOW, "mallory");
    expect(store.sessionOwner("a1")).toBe("alice");
  });
  it("callers that send no user share the default user, as before", () => {
    chat(store, DEFAULT_USER, "d1", "hi there", "hello", "2026-11-05T09:00:00Z");
    expect(store.listSessions().map((s) => s.id)).toEqual(["d1"]);
  });
  it("search, ranges and day lists are scoped too", () => {
    expect(store.searchMessages("bob", '"postgres"', "x", 5)).toEqual([]);
    expect(store.searchMessages("alice", '"postgres"', "x", 5).length).toBeGreaterThan(0);
    expect(store.messagesBetween("bob", at("2026-11-01T00:00:00Z"), at("2026-11-09T00:00:00Z")).map((m) => m.sessionId)).toEqual(["b1", "b1"]);
    expect(store.userMessageTimes("alice")).toHaveLength(1);
  });
});

describe("titles", () => {
  it("a stored title wins over the first question", () => {
    chat(store, "u", "s1", "What is the cheapest managed Postgres hosting for a small SaaS company?", "Neon.", "2026-11-03T09:00:00Z");
    expect(store.listSessions("u")[0]!.title).toBe("What is the cheapest managed Postgres hosting for a small SaaS company?");
    store.setTitle("s1", "Cheapest Postgres hosting");
    expect(store.listSessions("u")[0]!.title).toBe("Cheapest Postgres hosting");
    expect(store.getTitle("s1")).toBe("Cheapest Postgres hosting");
  });
});

describe("verification reports are saved with the answer", () => {
  it("round-trips through the database", () => {
    store.ensureSession("s", "UTC", NOW);
    store.addMessages("s", [{ role: "assistant", content: "x", verification: { ok: false, checked: 2, verified: 1 }, createdAt: NOW }]);
    expect(store.sessionMessages("s")[0]!.verification).toEqual({ ok: false, checked: 2, verified: 1 });
  });
});

describe("date ranges and full-text search", () => {
  it("messagesBetween is half-open and ordered", () => {
    chat(store, "u", "s1", "one", "a", "2026-11-03T10:00:00Z");
    chat(store, "u", "s2", "two", "b", "2026-11-04T00:00:00Z");
    const hits = store.messagesBetween("u", at("2026-11-03T00:00:00Z"), at("2026-11-04T00:00:00Z"));
    expect(hits.map((m) => m.content)).toEqual(["one", "a"]); // 04T00:00 is excluded
  });
  it("matches stemmed words and ranks the better match first", () => {
    chat(store, "u", "s1", "Cheapest managed Postgres hosting for a small SaaS", "Neon free tier, Supabase Pro.", "2026-11-03T09:00:00Z");
    chat(store, "u", "s2", "How do I host a static website", "Use Netlify.", "2026-11-04T09:00:00Z");
    const hits = store.searchMessages("u", '"postgres" OR "hosts"', "other", 10);
    expect(hits[0]!.message.sessionId).toBe("s1");
    expect(hits.some((h) => h.message.sessionId === "s2")).toBe(true); // "host" stems to "hosts"
  });
  it("excludes the current session and pairs a hit with its other half", () => {
    chat(store, "u", "s1", "Neon pricing question", "Launch is about $19.", "2026-11-03T09:00:00Z");
    expect(store.searchMessages("u", '"neon"', "s1", 10)).toEqual([]);
    const hit = store.searchMessages("u", '"launch"', "none", 10).find((h) => h.message.role === "assistant")!;
    expect(store.pairedTurn(hit.message)!.content).toBe("Neon pricing question");
    const q = store.searchMessages("u", '"pricing"', "none", 10).find((h) => h.message.role === "user")!;
    expect(store.pairedTurn(q.message)!.content).toBe("Launch is about $19.");
  });
  it("deleting a session removes it from search as well", () => {
    chat(store, "u", "s1", "Neon pricing question", "Launch is about $19.", "2026-11-03T09:00:00Z");
    store.deleteSession("s1", "u");
    expect(store.searchMessages("u", '"neon"', "x", 10)).toEqual([]);
  });
});

describe("migration from the previous schema", () => {
  it("opens a database written by the old version, keeps its data and indexes it", () => {
    const path = join(mkdtempSync(join(tmpdir(), "minimi-")), "old.db");
    const old = new Database(path);
    old.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, tz TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
        role TEXT NOT NULL CHECK (role IN ('user','assistant')), content TEXT NOT NULL, sources_json TEXT, created_at TEXT NOT NULL,
        UNIQUE (session_id, role, created_at, content));
      INSERT INTO sessions VALUES ('legacy', 'UTC', '2026-10-01T00:00:00Z');
      INSERT INTO messages (session_id, role, content, created_at) VALUES ('legacy', 'user', 'Legacy Kubernetes question', '2026-10-01T00:00:00Z');
    `);
    old.close();

    const migrated = new Store(path);
    expect(migrated.listSessions(DEFAULT_USER).map((s) => s.title)).toEqual(["Legacy Kubernetes question"]); // old rows belong to the default user
    expect(migrated.searchMessages(DEFAULT_USER, '"kubernetes"', "x", 5)).toHaveLength(1);                   // the full-text index was rebuilt
    migrated.addMessages("legacy", [{ role: "assistant", content: "answer", verification: { ok: true }, createdAt: NOW }]);
    expect(migrated.sessionMessages("legacy")).toHaveLength(2);
    migrated.close();
    expect(() => new Store(path).close()).not.toThrow(); // opening twice is safe
  });
});
