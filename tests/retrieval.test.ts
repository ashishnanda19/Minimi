import { beforeEach, describe, expect, it } from "vitest";
import { formatRecalled, ftsMatch, keywordsOf, retrieveRelevant } from "../src/agent/retrieval.js";
import { Store } from "../src/store/db.js";

const NOW = new Date("2026-11-10T09:00:00Z");
let store: Store;
beforeEach(() => { store = new Store(":memory:"); });

function chat(user: string, id: string, q: string, a: string, iso: string, sources: { id: number; title: string; url: string }[] = []) {
  store.ensureSession(id, "UTC", NOW, user);
  store.addMessages(id, [{ role: "user", content: q, createdAt: new Date(iso) }, { role: "assistant", content: a, sources, createdAt: new Date(new Date(iso).getTime() + 5_000) }]);
}

describe("keywordsOf", () => {
  it("keeps the topic words and drops chatter, dates and weekdays", () => {
    expect(keywordsOf("What did I ask you last Tuesday about my Postgres hosting pricing?")).toEqual(expect.arrayContaining(["postgres", "hosting", "pricing"]));
    expect(keywordsOf("What did I ask you last Tuesday about my Postgres hosting pricing?")).not.toEqual(expect.arrayContaining(["tuesday", "what", "last", "about"]));
  });
  it("puts the most specific (longest) words first and caps the list", () => {
    const k = keywordsOf("alpha bravo charlie delta echo foxtrot golfing hotelier indigo juliet");
    expect(k).toHaveLength(8);
    expect(k[0]!.length).toBeGreaterThanOrEqual(k.at(-1)!.length);
  });
  it("returns nothing for a message with no topic", () => {
    expect(keywordsOf("what did I ask you yesterday?")).toEqual([]);
    expect(ftsMatch([])).toBeUndefined();
  });
  it("quotes tokens so operators in user text cannot break the query", () => {
    expect(ftsMatch(['neon"; drop', "a"])).toBe('"neon""; drop" OR "a"');
  });
});

describe("retrieveRelevant: finds a conversation by what it was about", () => {
  beforeEach(() => {
    chat("u", "pg", "What's the cheapest managed Postgres hosting for a small SaaS?", "Neon has a free tier, Supabase Pro is $25/mo [1].", "2026-09-02T09:00:00Z", [{ id: 1, title: "Supabase", url: "https://supabase.com/pricing" }]);
    chat("u", "crm", "Shortlist five CRM tools for a 20-person sales team", "HubSpot, Pipedrive, Salesforce, Zoho CRM and Freshsales.", "2026-09-10T09:00:00Z");
    for (let i = 0; i < 30; i++) chat("u", `noise${i}`, `Unrelated question number ${i} about gardening`, "Water it.", `2026-10-${String((i % 28) + 1).padStart(2, "0")}T09:00:00Z`);
  });
  it("recalls a two-month-old chat that the recency ledger would long since have dropped", () => {
    const r = retrieveRelevant(store, "u", "my Postgres question from before, has pricing changed?", "now", NOW);
    expect(r[0]!.sessionId).toBe("pg");
    expect(r[0]!.question).toContain("managed Postgres hosting");
    expect(r[0]!.answer).toContain("Supabase Pro is $25/mo (src: supabase.com)"); // [1] rewritten as provenance
    expect(r[0]!.domains).toEqual(["supabase.com"]);
  });
  it("finds the shortlist when only a loose reference is given", () => {
    expect(retrieveRelevant(store, "u", "that CRM shortlist we made, any pricing changes?", "now", NOW)[0]!.sessionId).toBe("crm");
  });
  it("matches stemmed words: 'hosts' finds 'hosting'", () => {
    expect(retrieveRelevant(store, "u", "which Postgres hosts did you recommend", "now", NOW)[0]!.sessionId).toBe("pg");
  });
  it("returns nothing for an unrelated question, rather than a weak match", () => {
    expect(retrieveRelevant(store, "u", "how tall is mount everest", "now", NOW)).toEqual([]);
  });
  it("does not retrieve from the current chat, or from another user", () => {
    expect(retrieveRelevant(store, "u", "my Postgres hosting question", "pg", NOW).some((r) => r.sessionId === "pg")).toBe(false);
    expect(retrieveRelevant(store, "someone-else", "my Postgres hosting question", "now", NOW)).toEqual([]);
  });
  it("one shared word is not enough when the user gave us several", () => {
    chat("u", "weak", "gardening in Postgres Texas", "Hot.", "2026-10-30T09:00:00Z");
    const r = retrieveRelevant(store, "u", "managed Postgres hosting pricing", "now", NOW);
    expect(r.map((x) => x.sessionId)).not.toContain("weak");
  });
  it("renders a dated block for the prompt", () => {
    const block = formatRecalled(retrieveRelevant(store, "u", "my Postgres hosting question", "now", NOW).slice(0, 1), NOW, "UTC");
    expect(block).toMatch(/^\[Wed 2 Sep 2026, 09:00, 69 days ago\] You asked: "What's the cheapest managed Postgres hosting/);
    expect(block).toContain("I answered:");
  });
});
