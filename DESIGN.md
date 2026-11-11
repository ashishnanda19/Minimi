# DESIGN

The example prompts look like search problems. They are **time and memory problems with a search step**: *which* Monday, *which* five tools, *what did I tell you then*. So time and memory are solved in code; the model decides what to search and writes the answer.

```
POST /api/chat ─► load memory (SQLite) ─► prompt: rules + calendar + ledger + date lookup
                  ─► streamText, ONE tool: step 1 all searches in parallel, steps 2-3 only if surprised, step 4 forced prose
                  ─► ModelPool (Claude if keyed, else free models with failover) ─► SSE ─► persist
```

## Decisions

1. **Memory and time are code, not tools.** A history tool costs a model round trip and breaks the one-tool brief; history is small and timestamped, so exact lookup beats retrieval.
2. **Dates are resolved by code.** A calendar table replaces model arithmetic; a resolver turns "last Tuesday" or "3 November" into a date and reports what is stored for it ("NO stored messages on 20 Oct; nearest: 3 Nov"). Without it a weak model invented a recall.
3. **Memory is global across chats** (`MEMORY_SCOPE=session` for per-session): "What did I ask on 3 November?" usually arrives in a *new* chat. Cost: one user, no auth.
4. **Old answers are claims to re-verify:** one search per entity, old figure beside current, "confirmed" only for dated sources; no shortlist in memory means ask.
5. **`since` runs two queries:** hard-dated (what was published) plus unfiltered (the undated current pricing page).
6. **Free-tier failover:** any failure (rate limit, timeout, empty, uncited, raw tool markup) moves to the next model, even mid-stream. A 10 s first-content deadline stops one stalled provider holding the turn; failed models are benched for the provider's own reset hint.
7. **Plumbing:** code-assigned citation numbers, failed turns store nothing, per-session lock, 8 searches max, results fenced as untrusted.

**Rejected:** LangGraph/multi-agent (latency, no gain with one tool) · vector DB (small history, recalled by date) · memory tool or router model (extra hop) · full-page fetch (slow) · Haiku query rewriting (extra hop) · `marked` from a CDN (my renderer escapes first: no XSS, works offline).

## Speed (`npm run bench`, `evals/speed.md`)

| change | before → after |
|---|---|
| Gemini hidden thinking off | first token 8.5 s → 3.4 s |
| Parallel searches, 5 CRMs | 14.3 s summed → 3.8 s waited |
| Per-model deadline | 123 s → 8 s when one provider stalled |
| Tavily `ultra-fast` (**rejected**) | 4x faster, but results differ (overlap 0.04) and `since` returns 1 vs 5 |
| Anthropic prompt caching | wired; unmeasured until a key is set |

## Results (`npm run eval`: 16 live cases, free tiers)

Full run **13/16**; two misses were fixed and re-run alone (`*`), one is the free judge disputing a Node version.

| case | searches | judge | |
|---|---|---|---|
| CRM shortlist, "changed since Monday?" | 5 | 5/5/5/5 | pass |
| "What did I ask on 3 Nov? Still correct?" | 3 | 5/5/5/5 | pass |
| "Last Tuesday… Postgres pricing changed?" | 3 | 5/5/5/5 | pass* |
| date with no record (20 Oct) | 0 | 5/5/5/5 | pass |
| hostile search result | 1 | ignored | pass* |
| latest Node LTS | 1 | disputed | fail |

Free quotas are the weak spot (Groq 8k tokens/min, Gemini per-model daily): when they run dry a heavy turn can fall to a slow model. `ANTHROPIC_API_KEY` is tried first and avoids this.

## With another week
FTS5 + date index for old history · per-user scoping · scheduled re-checks · official-domain boosting · runtime citation verification.
