import type { AgentEvent, Metrics } from "../src/agent/run.js";
import type { Case } from "./cases.js";

export interface Outcome {
  failures: string[];
  answer: string;
  metrics: Metrics;
  sources: { id: number; url: string }[];
}

/** Deterministic (non-LLM) checks. Groundedness allows arithmetic on quoted figures, but not invented ones.
 * `seen` is everything the search backend returned to the model. */
export function checkCase(c: Case, events: AgentEvent[], seen: { title: string; content: string }[]): Outcome {
  const err = events.find((e): e is Extract<AgentEvent, { type: "error" }> => e.type === "error");
  const done = events.find((e): e is Extract<AgentEvent, { type: "done" }> => e.type === "done");
  const sources = events.find((e): e is Extract<AgentEvent, { type: "sources" }> => e.type === "sources")?.items ?? [];
  let answer = "";
  for (const e of events) {
    if (e.type === "reset") answer = "";
    else if (e.type === "token") answer += e.text;
  }

  const failures: string[] = [];
  if (err || !done) failures.push(`run failed: ${err?.message ?? "no done event"}`);
  const metrics: Metrics = done?.metrics ?? { model: "", fallbacks: [], ttftMs: null, firstStatusMs: null, searchWallMs: 0, totalMs: 0, steps: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, searches: [] };
  const ex = c.expect;

  const searched = metrics.searches.length > 0;
  if (ex.search === "yes" && !searched) failures.push("expected a search, got none");
  if (ex.search === "no" && searched) failures.push(`expected no search, ran ${metrics.searches.length}`);
  if (ex.minSearches && metrics.searches.length < ex.minSearches) {
    failures.push(`expected >=${ex.minSearches} searches, ran ${metrics.searches.length}`);
  }
  if (ex.maxSteps && metrics.steps > ex.maxSteps) failures.push(`took ${metrics.steps} steps, max ${ex.maxSteps}`);
  if (ex.sinceUsed && !metrics.searches.some((s) => s.since === ex.sinceUsed)) {
    failures.push(`no search used since=${ex.sinceUsed} (saw: ${metrics.searches.map((s) => s.since ?? "-").join(",") || "none"})`);
  }
  for (const re of ex.mustMatch ?? []) if (!new RegExp(re, "i").test(answer)) failures.push(`answer should match /${re}/`);
  for (const re of ex.mustNotMatch ?? []) if (new RegExp(re, "i").test(answer)) failures.push(`answer must not match /${re}/`);

  // Citation integrity: every [n] in the answer resolves to a source we actually emitted.
  const known = new Set(sources.map((s) => s.id));
  const cited = [...answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((x) => x[1]!.split(",").map((n) => Number(n.trim())));
  const dangling = [...new Set(cited.filter((n) => !known.has(n)))];
  if (dangling.length) failures.push(`dangling citation(s): ${dangling.join(",")}`);
  if (searched && seen.length && sources.length === 0 && /\$\d/.test(answer)) failures.push("prices stated but nothing cited");

  // Groundedness: every $ figure in the answer must appear in search results, memory or the question.
  const norm = (s: string) => s.replace(/,/g, "").replace(/\$\s+/g, "$");
  const haystack = norm([
    ...seen.map((r) => `${r.title} ${r.content}`),
    ...(c.seed ?? []).flatMap((s) => s.messages.map((m) => m.content)),
    c.question,
  ].join(" "));
  const grounded = [...haystack.matchAll(/\$(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  // A figure is fine if it is quoted, or is simple arithmetic on quoted ones ("4 seats x $20 = $80", "$20 + $5").
  const derivable = (v: number) =>
    grounded.some((g) => g > 0 && Number.isInteger(v / g) && v / g >= 2 && v / g <= 36) ||
    grounded.some((a) => grounded.some((b) => Math.abs(a + b - v) < 1e-9));
  const ungrounded = [...new Set([...answer.matchAll(/\$\s?\d[\d,]*(?:\.\d+)?/g)].map((x) => norm(x[0])).filter((p) => !haystack.includes(p) && !derivable(Number(p.slice(1)))))];
  if (ungrounded.length) failures.push(`ungrounded figure(s): ${ungrounded.join(", ")}`);

  return { failures, answer, metrics, sources };
}
