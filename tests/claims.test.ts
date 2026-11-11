import { describe, expect, it } from "vitest";
import { claimsBlock, dedupeClaims, extractClaims, uncoveredEntities } from "../src/agent/claims.js";

const WHEN = new Date("2026-11-03T08:31:00Z");
const src = [
  { id: 1, title: "Neon", url: "https://neon.com/pricing" },
  { id: 2, title: "Supabase", url: "https://supabase.com/pricing" },
  { id: 3, title: "Render", url: "https://render.com/pricing" },
];

describe("extractClaims: an earlier answer becomes a checklist", () => {
  it("splits a prose answer with several entities", () => {
    const c = extractClaims("For a small SaaS: Neon has a free tier and a Launch plan from about $19/mo [1]; Supabase Pro is $25/mo per project [2]; Render's basic Postgres starts around $6/mo [3].", src, WHEN);
    expect(c.map((x) => x.entity)).toEqual(["Neon", "Supabase Pro", "Render"]);
    expect(c.map((x) => x.figures)).toEqual([["$19"], ["$25"], ["$6"]]);
    expect(c[0]!.domains).toEqual(["neon.com"]);
  });
  it("reads a markdown table row by row", () => {
    const c = extractClaims("| Tool | Price |\n|---|---|\n| HubSpot | $20/seat/mo [1] |\n| Pipedrive | $14 [2] |", src, WHEN);
    expect(c.map((x) => x.entity)).toEqual(["HubSpot", "Pipedrive"]);
  });
  it("reads bullets and strips markdown and citations from the claim text", () => {
    const c = extractClaims("- **Zoho CRM**: Standard is $14/seat/mo [1]\n- Freshsales Growth is $9/seat/mo", src, WHEN);
    expect(c).toHaveLength(2);
    expect(c[0]!.text).toBe("Zoho CRM: Standard is $14/seat/mo");
    expect(c[0]!.text).not.toMatch(/\[|\*\*/);
  });
  it("skips sentences with no checkable figure", () => {
    expect(extractClaims("Neon is a serverless Postgres provider. It is popular.", src, WHEN)).toEqual([]);
  });
  it("captures version numbers and percentages as figures too", () => {
    const c = extractClaims("Node.js 26.13.0 is the current LTS. Adoption is about 40%.", src, WHEN);
    expect(c.flatMap((x) => x.figures)).toEqual(["26.13.0", "40%"]);
  });
});

describe("claims bookkeeping", () => {
  it("dedupes by entity and figures, keeping the newest", () => {
    const a = extractClaims("Neon Launch is $19/mo.", [], new Date("2026-11-01T00:00:00Z"));
    const b = extractClaims("Neon Launch is $19/mo.", [], new Date("2026-11-05T00:00:00Z"));
    const d = dedupeClaims([...a, ...b]);
    expect(d).toHaveLength(1);
    expect(d[0]!.when.toISOString()).toBe("2026-11-05T00:00:00.000Z");
  });
  it("renders a dated checklist for the prompt", () => {
    const block = claimsBlock(extractClaims("Neon Launch is about $19/mo [1].", src, WHEN), "UTC");
    expect(block).toBe('[said Tue 3 Nov 2026] Neon Launch: "Neon Launch is about $19/mo." (src: neon.com)');
  });
  it("finds entities the new answer silently skipped", () => {
    const claims = extractClaims("Neon is $19/mo. Supabase is $25/mo. Render is $6/mo.", [], WHEN);
    expect(uncoveredEntities(claims, "Neon: $19 -> $15. Render: unchanged.")).toEqual(["Supabase"]);
    expect(uncoveredEntities(claims, "NEON, SUPABASE and RENDER all unchanged.")).toEqual([]);
  });
});
