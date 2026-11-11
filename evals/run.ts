/**
 * `npm run eval [-- --only id1,id2] [-- --no-judge]`
 * Runs every case against the real model and real search, with a fixed clock and seeded memory.
 * Needs ANTHROPIC_API_KEY and TAVILY_API_KEY. Writes evals/results.md.
 */
import { writeFileSync } from "node:fs";
import { buildPool } from "../src/agent/models.js";
import { runAgent, type AgentEvent } from "../src/agent/run.js";
import { TtlCache } from "../src/lib/cache.js";
import { buildCalendar } from "../src/agent/temporal.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store/db.js";
import { TavilyProvider, type Hit, type RawResult, type SearchProvider } from "../src/tools/search.js";
import { CASES, NOW, TZ, type Case } from "./cases.js";
import { checkCase } from "./checks.js";
import { judge, type Verdict } from "./judge.js";

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const useJudge = !args.includes("--no-judge");
const CONCURRENCY = 2; // free tiers allow only a handful of requests per minute

let cfg: ReturnType<typeof loadConfig>;
try {
  cfg = loadConfig();
} catch (e) {
  console.error(`\n${(e as Error).message}\n`);
  process.exit(1);
}
const models = buildPool(cfg);
const realProvider = new TavilyProvider(cfg.tavilyKey);

interface Row {
  id: string;
  failures: string[];
  searches: number;
  steps: number;
  ttftMs: number | null;
  totalMs: number;
  verdict?: Verdict;
  answer: string;
  queries: string[];
  model: string;
}

async function runCase(c: Case): Promise<Row> {
  const store = new Store(":memory:");
  const now = new Date(c.now ?? NOW);
  const tz = c.tz ?? TZ;

  for (const s of c.seed ?? []) {
    store.ensureSession(s.id, tz, now);
    store.addMessages(s.id, s.messages.map((m) => ({ role: m.role, content: m.content, sources: m.sources, createdAt: new Date(m.at) })));
  }

  // Wrap the provider to record exactly what the model was shown, for the groundedness check.
  const seen: RawResult[] = [];
  const base: SearchProvider = c.injectedResults ? { search: async () => c.injectedResults! } : realProvider;
  const provider: SearchProvider = { search: async (r) => { const out = await base.search(r); seen.push(...out); return out; } };

  const events: AgentEvent[] = [];
  for await (const e of runAgent(
    { models, provider, store, cache: new TtlCache<Hit[]>(100, 60_000) },
    { sessionId: c.current ?? `case-${c.id}`, message: c.question, tz, now },
  )) events.push(e);

  const { failures, answer, metrics: m, sources } = checkCase(c, events, seen);

  let verdict: Verdict | undefined;
  if (useJudge && answer) {
    try {
      verdict = await judge(models, {
        calendar: buildCalendar(now, tz),
        memory: (c.seed ?? []).flatMap((s) => s.messages.map((x) => `[${x.at}] ${x.role}: ${x.content}`)).join("\n"),
        question: c.question, answer, rubric: c.rubric,
        queries: m.searches.map((s) => s.query),
        sources: sources.map((s) => `[${s.id}] ${s.url}`).join(" "),
        evidence: seen.slice(0, 24).map((r) => `- ${r.title} (${r.url}) [${r.publishedDate ? `published ${r.publishedDate}` : "undated"}]: ${r.content.replace(/\s+/g, " ").slice(0, 600)}`).join("\n"),
      });
      if (!verdict.pass) failures.push(`judge: ${verdict.reason}`);
    } catch (e) {
      failures.push(`judge error: ${(e as Error).message}`);
    }
  }

  store.close();
  return { id: c.id, failures, searches: m.searches.length, steps: m.steps, ttftMs: m.ttftMs, totalMs: m.totalMs, verdict, answer, queries: m.searches.map((x) => `${x.query}${x.since ? ` (since ${x.since})` : ""} [${(x.ms / 1000).toFixed(1)}s${x.cached ? ", cached" : ""}${x.error ? `, ERROR ${x.error.slice(0, 60)}` : ""}]`), model: m.model };
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); }
  }));
  return out;
}

const cases = CASES.filter((c) => !only || only.includes(c.id));
console.log(`Running ${cases.length} cases on ${models.names.join(" -> ")} (judge: ${useJudge ? "on" : "off"})\n`);
const rows = await pool(cases, CONCURRENCY, async (c) => {
  const row = await runCase(c);
  console.log(`${row.failures.length ? "FAIL" : "ok  "}  ${c.id}`);
  for (const f of row.failures) console.log(`        - ${f}`);
  return row;
});

const sec = (ms: number | null) => (ms == null ? "-" : (ms / 1000).toFixed(1) + "s");
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : 0);
const scored = rows.filter((r) => r.verdict);
const mean = (k: "honesty" | "leadsWithAnswer" | "usefulness") => avg(scored.map((r) => r.verdict![k])).toFixed(1);
const dateScores = scored.map((r) => r.verdict!.dateResolution).filter((x): x is number => x != null);

const table = [
  "| case | result | searches | steps | first token | total | date | honesty | lead | useful |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.id} | ${r.failures.length ? "FAIL" : "pass"} | ${r.searches} | ${r.steps} | ${sec(r.ttftMs)} | ${sec(r.totalMs)} | ${r.verdict?.dateResolution ?? "-"} | ${r.verdict?.honesty ?? "-"} | ${r.verdict?.leadsWithAnswer ?? "-"} | ${r.verdict?.usefulness ?? "-"} |`),
].join("\n");

const passed = rows.filter((r) => !r.failures.length).length;
const summary = [
  `**${passed}/${rows.length} cases pass** · models \`${models.names.join(" -> ")}\` · judge ${useJudge ? "on" : "off"} · clock fixed at ${NOW}`,
  `First token: median ${sec(med(rows.map((r) => r.ttftMs ?? 0)))}, total: median ${sec(med(rows.map((r) => r.totalMs)))}, p-max ${sec(Math.max(...rows.map((r) => r.totalMs)))}`,
  scored.length ? `Judge means (1-5): date ${avg(dateScores).toFixed(1)}, honesty ${mean("honesty")}, leads-with-answer ${mean("leadsWithAnswer")}, usefulness ${mean("usefulness")}` : "",
].filter(Boolean).join("\n\n");

const queryLog = rows.map((r) => `- **${r.id}** (${r.model || "n/a"}): ${r.queries.length ? r.queries.join(" | ") : "no search"}`).join("\n");
const details = rows.filter((r) => r.failures.length).map((r) => `### ${r.id}\n${r.failures.map((f) => `- ${f}`).join("\n")}\n\n> ${r.answer.replace(/\n/g, "\n> ")}`).join("\n\n");
writeFileSync(new URL("./results.md", import.meta.url), `# Eval results\n\n${summary}\n\n${table}\n\n## Searches run\n\n${queryLog}\n\n${details ? `## Failures\n\n${details}\n` : ""}`);
console.log(`\n${summary}\n\n${table}\n\nWrote evals/results.md`);
process.exit(rows.some((r) => r.failures.length) ? 1 : 0);
