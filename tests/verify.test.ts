import { describe, expect, it } from "vitest";
import { extractClaims } from "../src/agent/claims.js";
import { extractFigures, isDerived } from "../src/agent/figures.js";
import { correctCitations, datesIn, describeProblems, subjectsOf, verifyAnswer, type EvidenceSource } from "../src/agent/verify.js";

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
    const r = verify("For 4 developers Vercel starts at $80 [1].", [ev(1, "Vercel Pro is $20 per seat")]);
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
  it("a remembered figure about one thing does not excuse the same number about another", () => {
    const memory = "Neon Launch is about $19/mo [1]. Supabase Pro is $25/mo.";
    const wrong = verify("HubSpot | Changed | $19 → $20 per seat [1]", [ev(1, "HubSpot Starter $20 per seat")], { memoryText: memory });
    expect(status(wrong)).toContain("$19:unsupported"); // the arrow frames it as old, but nothing remembered says HubSpot was $19
    const right = verify("Neon Launch: $19 → $15 [1]", [ev(1, "Neon typical spend $15 per month")], { memoryText: memory });
    expect(status(right)).toEqual(["$19:memory", "$15:supported"]);
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
    expect(verify(answer, [ev(1, "HubSpot Starter $20 per seat"), ev(2, "Pipedrive Essential $14")]).ok).toBe(true);
    expect(verify(answer, [ev(1, "HubSpot Starter $20 per seat"), ev(2, "Pipedrive Essential $9")]).ok).toBe(false);
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
  it("a conversation date is not a claim about a source (regression from a live run)", () => {
    const evidence = [ev(1, "Neon Launch from $19", { published: "2026-11-04" })];
    const memory = "[Tue 3 Nov 2026] You asked about Postgres hosting. \"3 November\" = Tue 3 Nov 2026 (2026-11-03)";
    expect(verify("On Tue 3 Nov you asked about hosting, and Neon is still $19 [1].", evidence, { memoryText: memory }).unsupportedDates).toEqual([]);
    expect(verify("On 3 Nov you asked; Neon's page, updated 3 Nov [1], says $19.", evidence).unsupportedDates).toEqual(["2026-11-03"]); // a real source-date claim is still checked
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


describe("correctCitations: repairing attribution without a model", () => {
  const fix = (answer: string, evidence: EvidenceSource[]) => correctCitations(answer, verify(answer, evidence));
  const sources = [ev(1, "Neon Launch from $19"), ev(2, "Supabase Pro is $25"), ev(3, "HubSpot Starter $20")];

  it("swaps a wrong number for the source that states the figure", () => {
    const r = fix("Neon is $19 per month [3].", sources);
    expect(r).toEqual({ answer: "Neon is $19 per month [1].", fixed: 1 });
    expect(verify(r.answer, sources).ok).toBe(true);
  });
  it("fixes several sentences at once", () => {
    const r = fix("Neon is $19 [2]. Supabase is $25 [1].", sources);
    expect(r.answer).toBe("Neon is $19 [1]. Supabase is $25 [2].");
  });
  it("in a sentence with several figures it adds the right source and keeps the existing citation", () => {
    const r = fix("Neon is $19 and HubSpot is $20 [3].", sources);
    expect(r.answer).toBe("Neon is $19 and HubSpot is $20 [3][1].");
    expect(verify(r.answer, sources).figures.every((f) => f.status === "supported")).toBe(true);
  });
  it("leaves an answer alone when nothing is misattributed", () => {
    expect(fix("Neon is $19 [1].", sources)).toEqual({ answer: "Neon is $19 [1].", fixed: 0 });
  });
  it("does not invent support for a figure no source states", () => {
    const r = fix("Neon is $99 [1].", sources);
    expect(r.fixed).toBe(0);
    expect(verify(r.answer, sources).ok).toBe(false);
  });
  it("works inside a table row", () => {
    const r = fix("| Tool | Price |\n|---|---|\n| Neon | $19 [2] |", sources);
    expect(r.answer).toContain("| Neon | $19 [1] |");
  });
});

describe("citations must be about the thing claimed (from a real answer)", () => {
  const sources = [
    ev(1, "Neon pricing: usage based, no monthly minimum", { url: "https://neon.com/pricing", title: "Neon Pricing" }),
    ev(6, "State of Michigan railroad safety programme and rail grants", { url: "https://www.michigan.gov/mdot/rail", title: "Rail programs" }),
    ev(7, "Representative Hoyle statement on transport funding", { url: "https://hoyle.house.gov/news", title: "News" }),
  ];
  it("flags a claim about Railway that cites pages which never mention Railway", () => {
    const r = verify("Railway: No pricing changes have been reported since Monday [6][7].", sources);
    expect(r.weakCitations).toHaveLength(1);
    expect(r.weakCitations[0]).toMatchObject({ ids: [6, 7], subjects: ["Railway"] });
    expect(r.ok).toBe(false);
    expect(describeProblems(r).join(" ")).toMatch(/none of those pages \(michigan\.gov, hoyle\.house\.gov\) mention Railway/);
    expect(r.weakCitations[0]!.pages).toEqual(["https://www.michigan.gov/mdot/rail", "https://hoyle.house.gov/news"]);
  });
  it("accepts a claim whose cited page is about it, and the page need only mention it once", () => {
    expect(verify("Neon: continues its usage-based model [1].", sources).weakCitations).toEqual([]);
    expect(verify("Neon: continues its model [6][1].", sources).weakCitations).toEqual([]); // one good source among several is enough
  });
  it("matches on the page's address and title, not just its text", () => {
    const r = verify("Supabase: unchanged [1].", [ev(1, "plans and limits", { url: "https://supabase.com/pricing", title: "Pricing" })]);
    expect(r.weakCitations).toEqual([]);
  });
  it("does not police sentences with nothing to name, or no citation", () => {
    expect(verify("Prices have not moved since Monday [6].", sources).weakCitations).toEqual([]);
    expect(verify("Railway had no changes.", sources).weakCitations).toEqual([]);
  });
});

describe("subjectsOf", () => {
  it("finds product names and ignores sentence-starting words, months, weekdays and generic nouns", () => {
    expect(subjectsOf("Railway: No pricing changes since Monday 9 November [6]")).toEqual(["Railway"]);
    expect(subjectsOf("Recent news regarding Supabase concerns funding and the acquisition of Turso")).toEqual(["Supabase", "Turso"]);
    expect(subjectsOf("| HubSpot | Changed | $19 → $20 per seat [1] |")).toEqual(["HubSpot"]);
    expect(subjectsOf("Total Cost of Ownership is lower for managed hosting")).toEqual([]);
    expect(subjectsOf("As of today nothing changed")).toEqual([]);
  });
  it("recognises CamelCase names even at the start of a sentence", () => {
    expect(subjectsOf("PlanetScale remains consistent")).toEqual(["PlanetScale"]);
  });
});

describe("overlooked changes: 'no change' contradicted by a source inside the window (from a live run)", () => {
  const recent = (text: string, published = "2026-11-10", extra: Partial<EvidenceSource> = {}) => ev(1, text, { published, url: "https://neon.com/blog", title: "Neon blog", ...extra });
  const check = (answer: string, evidence: EvidenceSource[], extra = {}) => verify(answer, evidence, { reverify: true, windowStart: "2026-11-09", ...extra });

  it("flags 'no pricing changes' when a source published in the window says the free tier was increased", () => {
    const r = check("Neon: No pricing changes found [1].", [recent("Neon increased the free tier to 100 projects on Nov 10, effective immediately")]);
    expect(r.overlooked).toHaveLength(1);
    expect(r.overlooked[0]).toMatchObject({ subject: "Neon", id: 1, published: "2026-11-10" });
    expect(r.overlooked[0]!.excerpt).toContain("increased the free tier");
    expect(r.ok).toBe(false);
    expect(describeProblems(r).join(" ")).toMatch(/You say nothing changed for Neon, but source \[1\] \(published 2026-11-10\)/);
  });
  it("flags 'unchanged' and 'remains' phrasings too", () => {
    for (const a of ["Neon is unchanged [1].", "Neon's pricing remains the same [1].", "Neon: no change found [1]."]) {
      expect(check(a, [recent("Neon will no longer offer the old Scale plan")]).overlooked, a).toHaveLength(1);
    }
  });
  it("stays quiet when the source is older than the window", () => {
    expect(check("Neon: no changes found [1].", [recent("Neon increased the free tier", "2026-11-05")]).overlooked).toEqual([]);
  });
  it("stays quiet when the answer itself reports a change", () => {
    expect(check("Neon: the free tier was increased on 10 Nov [1].", [recent("Neon increased the free tier")]).overlooked).toEqual([]);
  });
  it("stays quiet about generic text with no change language, or about another company", () => {
    expect(check("Neon: no changes found [1].", [recent("Neon offers a free tier and usage-based billing")]).overlooked).toEqual([]);
    expect(check("Neon: no changes found [1].", [recent("Supabase increased its prices", "2026-11-10", { url: "https://supabase.com", title: "Supabase" })]).overlooked).toEqual([]);
  });
  it("only applies to re-verification with a window, never to ordinary answers", () => {
    const e = [recent("Neon increased the free tier")];
    expect(verify("Neon: no changes found [1].", e, { reverify: true }).overlooked).toEqual([]);                    // no window
    expect(verify("Neon: no changes found [1].", e, { windowStart: "2026-11-09" }).overlooked).toEqual([]);         // not a re-verification
  });
});

describe("false alarms found in live runs (each stays fixed)", () => {
  const page = (id: number, text: string, extra: Partial<EvidenceSource> = {}) => ev(id, text, { published: "2026-11-09", ...extra });
  const check = (answer: string, evidence: EvidenceSource[]) => verify(answer, evidence, { reverify: true, windowStart: "2026-11-09" });

  it("change language about ANOTHER company on the same page does not contradict a claim about this one", () => {
    const text = "Supabase offers Postgres with auth and storage for growing products. " + "x ".repeat(120) + "Neon announced it would join Databricks.";
    const r = check("Supabase: no pricing changes found [1].", [page(1, text, { title: "Postgres hosts compared", url: "https://example.com/compare" })]);
    expect(r.overlooked).toEqual([]);
  });
  it("...but change language right beside the subject does", () => {
    expect(check("Supabase: no pricing changes found [1].", [page(1, "Supabase increased the Pro plan price this week")]).overlooked).toHaveLength(1);
  });
  it("a change described with an explicit date before the window is old news, not an overlooked change", () => {
    const r = check("Neon: no pricing changes found [1].", [page(1, "Neon announced on May 14, 2025 that it would join Databricks")]);
    expect(r.overlooked).toEqual([]);
    expect(check("Neon: no pricing changes found [1].", [page(1, "Neon announced on Nov 10, 2026 that it raised prices")]).overlooked).toHaveLength(1);
  });
  it("a misattributed figure found in many sources is corrected to the one about the subject", () => {
    const evidence = [
      ev(2, "Postgres at scale: PlanetScale from $5 per month"),
      ev(4, "Railway Hobby plan is $5 per month", { url: "https://railway.com/pricing", title: "Railway Pricing" }),
      ev(10, "Fly.io Postgres starts at $5 per month"), ev(11, "Render free plan, paid from $5 per month"), ev(15, "Heroku Eco dynos $5 per month"),
    ];
    const answer = "Railway: entry pricing remains from $5/month [2].";
    const fixed = correctCitations(answer, verify(answer, evidence), evidence);
    expect(fixed.answer).toBe("Railway: entry pricing remains from $5/month [4].");
    expect(verify(fixed.answer, evidence).figures.map((f) => f.status)).toEqual(["supported"]);
  });
  it("...and left alone when several sources match and none is about the subject", () => {
    const evidence = [ev(1, "Plan A $5 per month"), ev(2, "Plan B $5 per month"), ev(3, "Plan C $5 per month"), ev(4, "Plan D $5 per month"), ev(9, "unrelated")];
    const answer = "Zeta: costs $5 per month [9].";
    expect(correctCitations(answer, verify(answer, evidence), evidence)).toEqual({ answer, fixed: 0 });
  });
});

describe("no evidence, no reassurance (from a live run where every search failed)", () => {
  const rv = (answer: string, evidence: EvidenceSource[] = []) => verify(answer, evidence, { reverify: true, searched: true });

  it("flags 'no changes found' when nothing was retrieved", () => {
    const r = rv("No changes found as of today. The figures I provided earlier remain the latest available information.");
    expect(r.unverifiedAbsence).toBe(true);
    expect(r.ok).toBe(false);
    expect(describeProblems(r).join(" ")).toMatch(/No web evidence was retrieved this turn/);
  });
  it("also flags 'remains unchanged' and 'still the same'", () => {
    for (const a of ["Neon remains unchanged.", "Everything is still the same.", "Supabase: no pricing changes have been reported."]) expect(rv(a).unverifiedAbsence, a).toBe(true);
  });
  it("accepts an honest admission that it could not verify", () => {
    for (const a of ["I could not verify whether pricing has changed: the search was unavailable.", "I couldn't retrieve the pages, so I can't confirm any change.", "Search is unavailable, so I am unable to say whether anything is unchanged."]) {
      expect(rv(a).unverifiedAbsence, a).toBe(false);
    }
  });
  it("does not apply when evidence was retrieved, or on turns that are not re-verification", () => {
    expect(rv("Neon: no changes found [1].", [ev(1, "Neon pricing page", { url: "https://neon.com" })]).unverifiedAbsence).toBe(false);
    expect(verify("No changes found.", [], { reverify: false }).unverifiedAbsence).toBe(false);
  });
});

describe("a figure stated as the present needs a source, not memory (from a live run)", () => {
  const memory = "I told you Neon Launch was about $19/mo.";
  const ev1 = [ev(1, "Neon typical spend $15 per month, usage based", { url: "https://neon.com/pricing", title: "Neon Pricing" })];

  it("'$19 -> $19, unchanged' is flagged when the source says $15: the current-side $19 has no support", () => {
    const r = verify("Neon: $19 -> $19, unchanged [1].", ev1, { memoryText: memory });
    expect(status(r)).toEqual(["$19:memory", "$19:unsupported"]);
    expect(r.ok).toBe(false);
  });
  it("'still / remains / now' makes the figure a claim about the present", () => {
    for (const a of ["Neon still costs $19 per month [1].", "Neon remains $19/mo [1].", "Neon is currently $19 per month [1]."]) {
      expect(status(verify(a, ev1, { memoryText: memory })), a).toEqual(["$19:unsupported"]);
    }
  });
  it("'$19 -> $15' passes: the old side is memory, the new side is sourced", () => {
    expect(status(verify("Neon: $19 -> $15 [1].", ev1, { memoryText: memory }))).toEqual(["$19:memory", "$15:supported"]);
  });
  it("'$19 -> $19, unchanged' still passes when a source really says $19", () => {
    const r = verify("Neon: $19 -> $19, unchanged [1].", [ev(1, "Neon Launch from $19 per month", { url: "https://neon.com/p", title: "Neon" })], { memoryText: memory });
    expect(status(r)).toEqual(["$19:supported", "$19:supported"]); // a source states it, so memory is not even needed
    expect(r.ok).toBe(true);
  });
  it("on a recall turn, quoting memory as current is fine", () => {
    expect(verify("Neon still showed $19 when you asked.", [], { memoryText: memory, recall: true }).ok).toBe(true);
  });
});

describe("overlooked changes must be about price or plan (from a live run)", () => {
  const check = (answer: string, evidence: EvidenceSource[]) => verify(answer, evidence, { reverify: true, windowStart: "2026-11-09" });
  it("a railroad article near the word 'Railway' is not a pricing change", () => {
    const rail = ev(17, "A project will reduce the risk of derailment and improve the safety and reliability of Railway passenger and freight service in Minneapolis", { published: "2026-11-09", url: "https://www.dot.state.mn.us/news", title: "Rail project" });
    expect(check("Railway: no pricing changes found [17].", [rail]).overlooked).toEqual([]);
  });
  it("a vendor's own page counts even when the name is only in its address and title", () => {
    const neon = ev(3, "Free plan storage increased from 0.5 GB to 5 GB, effective Nov 10", { published: "2026-11-10", url: "https://neon.com/blog/free-plan", title: "Neon: bigger free plan" });
    const r = check("Neon: no pricing changes found [3].", [neon]);
    expect(r.overlooked).toHaveLength(1);
    expect(r.overlooked[0]!.excerpt).toContain("storage increased");
  });
  it("change language with no price or plan word beside it is ignored", () => {
    expect(check("Neon: no changes found [1].", [ev(1, "Neon announced a new office in Berlin", { published: "2026-11-10" })]).overlooked).toEqual([]);
  });
});

describe("figures are extracted without trailing punctuation", () => {
  it("keeps $1,200 whole but not the comma that follows $19", () => {
    expect(extractFigures("$19, then $1,200, and $5.").map((f) => f.raw)).toEqual(["$19", "$1,200", "$5"]);
  });
});
