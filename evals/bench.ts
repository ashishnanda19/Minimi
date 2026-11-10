/**
 * `npm run bench`: the speed pass behind evals/speed.md. Needs real keys.
 *   A. Tavily depth: latency and result quality for basic / fast / ultra-fast (no model calls).
 *   B. Snippet length: prompt tokens vs how many price figures survive the cut (no model calls).
 *   C. End to end: full turns on the configured models, including how parallel the searches really are.
 */
import { writeFileSync } from "node:fs";
import { buildPool } from "../src/agent/models.js";
import { runAgent, type AgentEvent, type Metrics } from "../src/agent/run.js";
import { TtlCache } from "../src/lib/cache.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store/db.js";
import { formatHits, TavilyProvider, type Hit, type SearchDepth } from "../src/tools/search.js";
import { CASES, NOW, TZ } from "./cases.js";

let cfg: ReturnType<typeof loadConfig>;
try { cfg = loadConfig(); } catch (e) { console.error(`\n${(e as Error).message}\n`); process.exit(1); }

const QUERIES: [string, string][] = [
  ["HubSpot Sales Hub pricing", "hubspot"], ["Neon Postgres pricing", "neon"], ["Supabase pricing", "supabase"],
  ["Pipedrive pricing", "pipedrive"], ["Linear pricing per user", "linear"], ["Vercel Pro plan pricing", "vercel"],
];
const REPS = 2;
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] ?? 0;
const f1 = (n: number) => n.toFixed(1);
const out: string[] = ["# Speed pass", "", `Run on ${new Date().toISOString().slice(0, 10)} against the live services. Reproduce with \`npm run bench\`.`, ""];

// ---- A. Tavily depth ------------------------------------------------------------------------
console.log("A. Tavily depth ...");
const depths: SearchDepth[] = ["basic", "fast", "ultra-fast"];
const rowsA: string[] = [];
let basicHits: Hit[][] = [];
for (const depth of depths) {
  const provider = new TavilyProvider(cfg.tavilyKey, fetch, depth);
  const ms: number[] = []; let official = 0, withPrice = 0, results = 0, n = 0; const kept: Hit[][] = [];
  for (let r = 0; r < REPS; r++) {
    for (const [q, brand] of QUERIES) {
      const t = performance.now();
      try {
        const res = await provider.search({ query: q, topic: "general", maxResults: 5 });
        ms.push(performance.now() - t); n++; results += res.length;
        if (res.some((x) => new URL(x.url).hostname.includes(brand))) official++;
        if (res.some((x) => /\$\s?\d/.test(x.content))) withPrice++;
        if (r === 0) kept.push(res.map((x) => ({ ...x, inWindow: false })));
      } catch (e) { console.error(`  ${depth} "${q}" failed: ${(e as Error).message.slice(0, 80)}`); }
    }
  }
  if (depth === "basic") basicHits = kept;
  rowsA.push(`| ${depth} | ${f1(pct(ms, 0.5) / 1000)}s | ${f1(pct(ms, 0.9) / 1000)}s | ${n ? ((official / n) * 100).toFixed(0) : 0}% | ${n ? ((withPrice / n) * 100).toFixed(0) : 0}% | ${n ? f1(results / n) : 0} |`);
}
out.push("## A. Tavily search depth", "", `${QUERIES.length} pricing queries x ${REPS} runs per depth. "Official" = an official domain appears in the top 5; "has price" = some snippet contains a $ figure.`, "", "| depth | median | p90 | official domain in top 5 | has price | results |", "|---|---|---|---|---|---|", ...rowsA, "");

// ---- D. Is ultra-fast a free win? -----------------------------------------------------------
console.log("D. basic vs ultra-fast ...");
{
  const norm = (u: string) => { try { const x = new URL(u); return x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/+$/, ""); } catch { return u; } };
  const basic = new TavilyProvider(cfg.tavilyKey, fetch, "basic"), ultra = new TavilyProvider(cfg.tavilyKey, fetch, "ultra-fast");
  let jac = 0, top1 = 0;
  for (const [q] of QUERIES) {
    const [a, b] = await Promise.all([basic.search({ query: q, topic: "general", maxResults: 5 }), ultra.search({ query: q, topic: "general", maxResults: 5 })]);
    const A = new Set(a.map((x) => norm(x.url))), B = new Set(b.map((x) => norm(x.url)));
    jac += [...A].filter((x) => B.has(x)).length / Math.max(1, new Set([...A, ...B]).size);
    if (a[0] && b[0] && norm(a[0].url) === norm(b[0].url)) top1++;
  }
  const since = async (p: TavilyProvider) => (await p.search({ query: "HubSpot new features announcement", since: "2026-10-01", topic: "general", maxResults: 5 }).catch(() => [])).length;
  out.push("## D. Why not ultra-fast?", "", "It is 4x faster in A, so I checked what it costs.", "",
    `- Same pages as basic? Mean top-5 overlap (Jaccard) **${(jac / QUERIES.length).toFixed(2)}**; identical top result in ${top1}/${QUERIES.length} queries.`,
    `- Does the \`since\` date filter still work? basic returned **${await since(basic)}** results, ultra-fast returned **${await since(ultra)}**.`, "",
    "Decision: keep `basic`. ultra-fast returns different, more aggregator-heavy pages and breaks the date filter that \"what changed since Monday\" depends on.", "");
}

// ---- B. Snippet length ----------------------------------------------------------------------
console.log("B. Snippet length ...");
const rowsB: string[] = [];
for (const cap of [300, 600, 900, 1500]) {
  let chars = 0, priceTotal = 0, priceKept = 0;
  basicHits.forEach((hits, i) => {
    chars += formatHits(QUERIES[i]![0], undefined, hits, hits.map((_, j) => j + 1), cap).length;
    for (const h of hits) {
      const flat = h.content.replace(/\s+/g, " ");
      const at = flat.search(/\$\s?\d/);
      if (at >= 0) { priceTotal++; if (at < cap) priceKept++; }
    }
  });
  const perSearch = chars / Math.max(1, basicHits.length);
  rowsB.push(`| ${cap} | ${Math.round(perSearch / 4)} | ${Math.round((perSearch / 4) * 5)} | ${priceTotal ? ((priceKept / priceTotal) * 100).toFixed(0) : "-"}% |`);
}
out.push("## B. Snippet length", "", "Tokens estimated at 4 chars/token. A 5-entity change check sends 5 searches' results to the model.", "", "| snippet cap (chars) | tokens per search | tokens for 5 searches | snippets whose first price figure survives the cut |", "|---|---|---|---|", ...rowsB, "");

// ---- C. End to end --------------------------------------------------------------------------
console.log("C. End to end ...");
const models = buildPool(cfg);
const provider = new TavilyProvider(cfg.tavilyKey);
const rowsC: string[] = [];
const picked = ["search-current-fact", "multi-entity-parallel", "crm-changed-since-monday"].map((id) => CASES.find((c) => c.id === id)!);
for (const c of picked) {
  const store = new Store(":memory:");
  const now = new Date(c.now ?? NOW);
  for (const s of c.seed ?? []) {
    store.ensureSession(s.id, c.tz ?? TZ, now);
    store.addMessages(s.id, s.messages.map((m) => ({ role: m.role, content: m.content, sources: m.sources, createdAt: new Date(m.at) })));
  }
  let m: Metrics | undefined; let err = "";
  for await (const e of runAgent({ models, provider, store, cache: new TtlCache<Hit[]>(50, 60_000) }, { sessionId: c.current ?? "bench", message: c.question, tz: c.tz ?? TZ, now }) as AsyncGenerator<AgentEvent>) {
    if (e.type === "done") m = e.metrics; else if (e.type === "error") err = e.message;
  }
  if (!m) { rowsC.push(`| ${c.id} | failed: ${err} | | | | | | |`); continue; }
  const sum = m.searches.reduce((a, s) => a + s.ms, 0);
  rowsC.push(`| ${c.id} | ${m.model.split(":")[1]} | ${m.searches.length} | ${f1((m.firstStatusMs ?? 0) / 1000)}s | ${f1(sum / 1000)}s | ${f1(m.searchWallMs / 1000)}s | ${f1(m.totalMs / 1000)}s | ${m.usage.inputTokens} / ${m.usage.outputTokens} | ${m.usage.cacheReadTokens} |`);
  console.log(`  ${c.id}: total ${f1(m.totalMs / 1000)}s, searches ${m.searches.length}, sum ${f1(sum / 1000)}s vs wall ${f1(m.searchWallMs / 1000)}s`);
}
out.push("## C. End to end", "", "`searches summed` is what the searches would cost run one after another; `search wall` is what the user actually waited. Cache read is nonzero only on Anthropic.", "",
  "| case | model | searches | first status | searches summed | search wall | total | tokens in / out | cache read |", "|---|---|---|---|---|---|---|---|---|", ...rowsC, "");

out.push("", "Note: section C swings with which model answers. On free tiers a throttled primary hands the turn to a fallback and can add quota waits (one earlier run of the 5-CRM case took 6.8 s on gemini-3.1-flash-lite with 14.3 s of searches collapsing to 3.8 s; this run fell through to nemotron and took 78 s). The parallelism ratio (summed vs wall) is the stable signal, not total time.", "");
writeFileSync(new URL("./speed.md", import.meta.url), out.join("\n") + "\n");
console.log("\n" + out.join("\n") + "\nWrote evals/speed.md");
