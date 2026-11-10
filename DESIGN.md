# DESIGN

The example prompts look like search problems. They are **time and memory problems with a search step**: *which* Monday, *which* five tools, *what did I tell you then*. So time and memory are solved in code; the model decides what to search and writes the answer.

```
POST /api/chat ─► load memory (SQLite) ─► build prompt ─► streamText loop, ONE tool ─► SSE ─► persist
                  this chat: real turns     rules + calendar   step 1: all searches in parallel
                  other chats: ledger       + ledger           steps 2-3: only if surprised
                                            + date lookup      step 4: forced prose
                                            ▲ ModelPool: Claude if keyed, else free models + failover
```

## Decisions

1. **Memory and time are code, not tools.** A history tool costs a model round trip and breaks the one-tool brief; history is small and timestamped, so exact lookup beats retrieval.
2. **Dates are resolved by code.** A calendar table replaces model arithmetic, and a resolver turns "last Tuesday" or "3 November" into a date and reports what is stored for it ("NO stored messages on 20 Oct; nearest: 3 Nov"). Without it, a weak model invented a recall.
3. **Memory is global across chats** (`MEMORY_SCOPE=session` gives per-session). "What did I ask on 3 November?" usually arrives in a *new* chat. Cost: one user, no auth. `history` and `now` on the API let a harness seed any scenario.
4. **Old answers are claims to re-verify.** One search per entity, old figure beside the current one, "confirmed" only for dated sources; if the shortlist isn't in memory, ask.
5. **`since` runs two queries:** hard-dated (what was published) plus unfiltered (the undated current pricing page). The tool recovers a date a weak model typed into the query instead of the parameter.
6. **Free-tier failover.** Any failure (rate limit, empty answer, raw tool markup, uncited answer) moves to the next model, even mid-stream. Quotas are per model, so providers take model lists; cooldowns follow the provider's reset hint.
7. **Plumbing.** Code-assigned citation numbers, failed turns store nothing, per-session lock, 8 searches max per turn, results fenced as untrusted.

**Rejected:** LangGraph/multi-agent (latency, no gain with one tool) · vector DB (history is small, recalled by date) · memory tool or router model (extra hop) · full-page fetch (slow) · Haiku query rewriting (extra hop) · `marked` from a CDN (my renderer escapes first, so no XSS, and works offline).

## Speed pass (`npm run bench`, `evals/speed.md`)

| change | before → after |
|---|---|
| Gemini hidden thinking off | first token 8.5 s → 3.4 s |
| Parallel searches, 5 CRMs | 14.3 s summed → 3.8 s waited |
| Snippet cap 600 chars (kept) | 300 loses 7% of prices; 900 adds 38% tokens for +3% |
| Tavily `ultra-fast` (**rejected**) | 1.2 s → 0.3 s, but top-5 overlap 0.04 and `since` returns 1 result vs 5 |
| Anthropic prompt caching | wired; unmeasured until a key is set |

## Results (`npm run eval`: 16 live cases, free tiers only)

Full run **13/16**. Two misses were fixed and re-run alone (`*`); the third is the free judge disputing a Node version.

| case | searches | judge date/honest/lead/useful | |
|---|---|---|---|
| CRM shortlist, "changed since Monday?" | 5 | 5/5/5/5 | pass |
| "What did I ask on 3 Nov? Still correct?" | 3 | 5/5/5/5 | pass |
| "Last Tuesday… Postgres pricing changed?" | 3 | 5/5/5/5 | pass* |
| date with no stored record (20 Oct) | 0 | 5/5/5/5 | pass |
| hostile search result | 1 | ignored, $49 reported | pass* |
| latest Node LTS | 1 | judge: "Node 26 doesn't exist" | fail |

Median first token 8.2 s; it swings with which fallback answers. Set `ANTHROPIC_API_KEY` for steadier quality; it is tried first.

## With another week
FTS5 + date index for old history, per-user scoping · scheduled re-checks · official-domain boosting · runtime citation verification.
