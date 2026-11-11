import { describe, expect, it } from "vitest";
import { extractClaims } from "../src/agent/claims.js";
import { extractFigures, isDerived } from "../src/agent/figures.js";
import { datesIn, describeProblems, verifyAnswer, type EvidenceSource } from "../src/agent/verify.js";

const NOW = new Date("2026-11-10T13:15:00Z");
const ev = (id: number, text: string, extra: Partial<EvidenceSource> = {}): EvidenceSource => ({ id, url: `https://s${id}.com`, title: `Source ${id}`, text, ...extra });
const verify = (answer: string, evidence: EvidenceSource[], extra: Partial<Parameters<typeof verifyAnswer>[0]> = {}) =>
  verifyAnswer({ answer, evidence, memoryText: "", searched: evidence.length > 0, now: NOW, ...extra });
const status = (r: ReturnType<typeof verify>) => r.figures.map((f) => `${f.figure}:${f.status}`);

describe("extractFigures", () => {
  it("normalises prices so formats compare equal", () => {
    expect(extractFigures("$20, $20.00, 20 USD, US$20, $1,200, $0.106, $2k").map((f) => f.value)).toEqual(["20", "20", "20", "20", "1200", "0.106", "2000"]);
  });
  it("finds percentages and versions", () => {
    expect(extractFigures("up 40%, Node v26.13.0 and 24.22.1").map((f) => `${f.kind}:${f.value}`)).toEqual(["percent:40", "version:26.13.0", "version:24.22.1"]);
  });
  it("derives multiples and sums but not arbitrary numbers", () => {
    const known = extractFigures("$20 per seat and $5 base");
    expect(isDerived(extractFigures("$80")[0]!, known)).toBe(true);   // 4 x 20
    expect(isDerived(extractFigures("$25")[0]!, known)).toBe(true);   // 20 + 5
    expect(isDerived(extractFigures("$15")[0]!, known)).toBe(true);   // 20 - 5
    expect(isDerived(extractFigures("$37")[0]!, known)).toBe(false);
  });
});

describe("verifyAnswer: figures", () => {
  it("accepts a figure that the cited source states", () => {
    const r = verify("Neon Launch is $19/mo [1].", [ev(1, "Launch plan from $19 per month")]);
    expect(status(r)).toEqual(["$19/mo:supported"].map((s) => s.replace("$19/mo", "$19")));
    expect(r.ok).toBe(true);
  });
  it("rejects an invented figure (the failure seen in live runs)", () => {
    const r = verify("Neon Launch is $37/mo [1].", [ev(1, "Launch plan from $19 per month")]);
    expect(status(r)).toEqual(["$37:unsupported"]);
    expect(r.ok).toBe(false);
    expect(describeProblems(r)[0]).toMatch(/\$37.*no source/);
  });
  it("flags a real figure cited to the wrong source", () => {
    const r = verify("Neon is $19 per month [2].", [ev(1, "Neon Launch from $19"), ev(2, "Supabase Pro is $25")]);
    expect(status(r)).toEqual(["$19:misattributed"]);
    expect(describeProblems(r)[0]).toMatch(/cited to \[2\] but only appears in \[1\]/);
  });
  it("a supported figure with no citation is still flagged as uncited; an unsupported one is flagged as wrong", () => {
    const supported = verify("It costs $19.", [ev(1, "from $19")]);
    expect(status(supported)).toEqual(["$19:supported"]);
    expect(supported.uncited).toBe(true);
    expect(supported.ok).toBe(false);
    expect(status(verify("It costs $23.", [ev(1, "from $19")]))).toEqual(["$23:unsupported"]);
  });
  it("does not split a price or version number at its decimal point", () => {
    expect(status(verify("Neon charges $0.106 per CU-hour [1].", [ev(1, "compute at $0.106 per CU-hour")]))).toEqual(["$0.106:supported"]);
  });
  it("accepts arithmetic on quoted figures", () => {
    const r = verify("For 4 developers Vercel starts at $80 [1].", [ev(1, "Pro is $20 per seat")]);
    expect(status(r)).toEqual(["$80:derived"]);
    expect(r.ok).toBe(true);
  });
  it("accepts an earlier figure only when framed as earlier, never as the current state", () => {
    const memory = "I told you Neon Launch was about $19/mo.";
    const framed = verify("I said $19 earlier; Neon's page now shows $15 [1].", [ev(1, "typical spend $15 per month")], { memoryText: memory });
    expect(status(framed)).toEqual(["$19:memory", "$15:supported"]);
    expect(framed.ok).toBe(true);
    const asCurrent = verify("Neon Launch costs $19 per month.", [ev(1, "typical spend $15 per month")], { memoryText: memory });
    expect(status(asCurrent)).toEqual(["$19:unsupported"]); // stale memory presented as fact
  });
  it("on a recall turn, memory alone is enough", () => {
    const r = verify("You asked about Postgres and I quoted $19 for Neon.", [], { memoryText: "Neon Launch from about $19/mo", recall: true });
    expect(r.ok).toBe(true);
  });
  it("percentages and versions are checked like prices", () => {
    expect(verify("Node 26.13.0 is LTS [1].", [ev(1, "v26.13.0 promoted to LTS")]).ok).toBe(true);
    expect(verify("Node 26.99.0 is LTS [1].", [ev(1, "v26.13.0 promoted to LTS")]).ok).toBe(false);
  });
  it("checks each table row's figure against its own citation", () => {
    const answer = "| Tool | Price |\n|---|---|\n| HubSpot | $20 [1] |\n| Pipedrive | $14 [2] |";
    expect(verify(answer, [ev(1, "Starter $20 per seat"), ev(2, "Essential $14")]).ok).toBe(true);
    expect(verify(answer, [ev(1, "Starter $20 per seat"), ev(2, "Essential $9")]).ok).toBe(false);
  });
});

describe("verifyAnswer: citations, dates, coverage", () => {
  it("catches citation numbers that match no source", () => {
    const r = verify("It is listed [1] and also [7].", [ev(1, "listed")]);
    expect(r.dangling).toEqual([7]);
    expect(r.ok).toBe(false);
  });
  it("catches a publication date no source shows", () => {
    const evidence = [ev(1, "Neon update", { published: "2026-11-04" })];
    expect(verify("Neon's page, published 4 Nov [1], shows the change.", evidence).unsupportedDates).toEqual([]);
    expect(verify("Neon's page, published 9 Nov [1], shows the change.", evidence).unsupportedDates).toEqual(["2026-11-09"]);
  });
  it("does not police dates that are not attributed to a source", () => {
    expect(verify("As of Tue 10 Nov 2026 nothing changed.", [ev(1, "x")]).unsupportedDates).toEqual([]);
  });
  it("flags an answer that searched but cited nothing", () => {
    const r = verify("Neon is a serverless Postgres provider that has been growing quickly and offers branching, autoscaling and a generous free tier for developers.", [ev(1, "Neon serverless Postgres")]);
    expect(r.uncited).toBe(true);
    expect(describeProblems(r).join(" ")).toMatch(/cited no source/);
  });
  it("flags earlier claims a re-verification silently skipped", () => {
    const claims = extractClaims("Neon is $19/mo. Supabase is $25/mo.", [], new Date("2026-11-03T00:00:00Z"));
    const r = verify("Neon: $19 -> $19 unchanged [1].", [ev(1, "Launch $19")], { priorClaims: claims, reverify: true });
    expect(r.uncovered).toEqual(["Supabase"]);
    expect(r.ok).toBe(false);
  });
  it("reports how many figures were checked and verified", () => {
    const r = verify("A is $19 [1] and B is $50 [1].", [ev(1, "A costs $19")]);
    expect([r.checked, r.verified]).toEqual([2, 1]);
  });
});

describe("datesIn", () => {
  it("parses common formats and infers the year as the most recent past one", () => {
    expect([...datesIn("on 4 Nov, Nov 5th, 2026-11-06 and 25 December", NOW)].sort()).toEqual(["2025-12-25", "2026-11-04", "2026-11-05", "2026-11-06"]);
  });
});
