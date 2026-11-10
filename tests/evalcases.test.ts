import { describe, expect, it } from "vitest";
import { CASES } from "../evals/cases.js";

describe("evals/cases.json", () => {
  it("has 15-20 well-formed cases (the plan's range) with unique ids", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(15);
    expect(CASES.length).toBeLessThanOrEqual(20);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    for (const c of CASES) {
      expect(c.question.length, c.id).toBeGreaterThan(3);
      expect(c.rubric.length, c.id).toBeGreaterThan(20);
      for (const re of [...(c.expect.mustMatch ?? []), ...(c.expect.mustNotMatch ?? [])]) expect(() => new RegExp(re, "i"), `${c.id}: ${re}`).not.toThrow();
      for (const s of c.seed ?? []) for (const m of s.messages) expect(Number.isNaN(Date.parse(m.at)), `${c.id} ${m.at}`).toBe(false);
      if (c.current) expect(c.seed?.some((s) => s.id === c.current), `${c.id} current chat must be seeded`).toBe(true);
    }
  });
  it("covers the brief's three examples and the plan's normal-question kinds", () => {
    const ids = CASES.map((c) => c.id).join(" ");
    for (const needle of ["crm", "recall", "postgres-last-tuesday", "no-search", "search-current", "multi-entity", "ambiguous", "injection"]) {
      expect(ids, needle).toContain(needle);
    }
  });
});
