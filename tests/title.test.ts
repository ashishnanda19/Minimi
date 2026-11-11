import { describe, expect, it } from "vitest";
import { ModelPool } from "../src/agent/models.js";
import { cleanTitle, generateTitle, heuristicTitle } from "../src/agent/title.js";
import { scriptedModel } from "./helpers.js";

describe("heuristicTitle: a deterministic summary, free and instant", () => {
  it("drops filler and question words and capitalises", () => {
    expect(heuristicTitle("Can you tell me what's the latest Node LTS?")).toBe("Latest Node LTS");
    expect(heuristicTitle("hey, how much does Linear cost per user?")).toBe("Linear cost per user");
    expect(heuristicTitle("thanks")).toBe("Thanks");
  });
  it("shortens long questions at a word boundary", () => {
    const t = heuristicTitle("What's the cheapest managed Postgres hosting provider for a small SaaS startup with spiky traffic?");
    expect(t.length).toBeLessThanOrEqual(49);
    expect(t.endsWith("…")).toBe(true);
    expect(t).not.toMatch(/\?/);
    expect(t).toMatch(/^Cheapest managed Postgres hosting/);
  });
  it("never returns an empty title", () => {
    expect(heuristicTitle("?")).toBe("?");
    expect(heuristicTitle("   ")).toBe("");
  });
});

describe("cleanTitle", () => {
  it("strips quotes, labels and trailing punctuation", () => {
    expect(cleanTitle('"Postgres hosting costs".')).toBe("Postgres hosting costs");
    expect(cleanTitle("Title: CRM pricing check")).toBe("CRM pricing check");
    expect(cleanTitle("**Node LTS version**\nBecause the user asked…")).toBe("Node LTS version");
  });
  it("rejects rambling output so the deterministic title is used instead", () => {
    expect(cleanTitle("")).toBeUndefined();
    expect(cleanTitle("a ".repeat(15))).toBeUndefined();
    expect(cleanTitle("x".repeat(90))).toBeUndefined();
  });
});

describe("generateTitle: free models only, with a safe fallback", () => {
  const pool = (...names: string[]) => new ModelPool(names.map((name) => ({ name, model: scriptedModel([{ text: "x" }]), cacheable: false })));

  it("uses a free model's title", async () => {
    const t = await generateTitle(pool("groq:a"), "cheapest postgres host?", { generate: async () => '"Cheapest Postgres hosting"' });
    expect(t).toBe("Cheapest Postgres hosting");
  });
  it("never spends the paid model on a title", async () => {
    const used: string[] = [];
    const t = await generateTitle(pool("anthropic:claude"), "cheapest postgres host?", { generate: async () => { used.push("called"); return "X"; } });
    expect(used).toEqual([]);
    expect(t).toBe("Cheapest postgres host");
  });
  it("skips Anthropic but still uses a free model behind it", async () => {
    let calls = 0;
    const t = await generateTitle(pool("anthropic:claude", "google:g"), "q?", { generate: async () => { calls++; return "Free title"; } });
    expect([calls, t]).toEqual([1, "Free title"]);
  });
  it("tries a second free model when the first fails, then falls back to the deterministic title", async () => {
    let n = 0;
    const second = await generateTitle(pool("groq:a", "google:b"), "q?", { generate: async () => { if (n++ === 0) throw new Error("rate limited"); return "Second model title"; } });
    expect(second).toBe("Second model title");
    const none = await generateTitle(pool("groq:a", "google:b"), "What is the best CRM?", { generate: async () => { throw new Error("down"); } });
    expect(none).toBe("Best CRM");
  });
  it("falls back when the model returns rambling text", async () => {
    expect(await generateTitle(pool("groq:a"), "What is the best CRM?", { generate: async () => "x ".repeat(30) })).toBe("Best CRM");
  });
});
