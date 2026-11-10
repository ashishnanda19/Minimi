# DESIGN

The example prompts look like search problems. They are **time and memory problems with a search step**: *which* Monday, *which* five tools, *what did I tell you then*. So time and memory are solved in code, and the model has two jobs: decide what to search, and write the answer.

```
POST /api/chat ─► load memory (SQLite) ─► build prompt ─► streamText loop, ONE tool ─► SSE ─► persist
                  this chat → real turns    rules              step 1: all searches in parallel
                  other chats → dated       + calendar         step 2: only if surprised
                  ledger (budgeted)         + ledger           step 3: forced prose
                                            + date lookup      ▲ ModelPool: free models, failover
```

## Decisions, and why

1. **Memory and time are code, not tools.** A history tool costs a model round trip and breaks the one-tool brief. History is small and timestamped, so exact lookup beats retrieval.
2. **Dates are resolved by code.** A calendar table (28 days back, 7 forward, "Tue 3 Nov: last Tuesday") replaces model arithmetic. A resolver parses "last Tuesday", "3 November", "5 days ago", then looks up what is stored for that day and tells the model "NO stored messages on 20 Oct; nearest: 3 Nov". A live eval showed a weak model otherwise invents the recall.
3. **Memory is user-global.** "What did I ask on 3 November?" usually comes in a *new* chat. The current chat is real timestamped turns; other chats form a dated ledger (~3.5k tokens; the six newest answers are never clipped since they get re-verified). `history` and `now` on the API let a harness seed any scenario. Trade-off: one user, no auth.
4. **Old answers are claims to re-verify.** Stored `[1]` becomes `(src: neon.tech)` in later prompts, so the model knows where to re-check. Protocol: one search per entity, old figure beside the current one, "confirmed" only if a dated source says so; if the shortlist isn't in memory, ask.
5. **`since` runs two queries in parallel**: a hard-dated one (what was published) and an unfiltered one (the current, undated pricing page). One tool for the model; two search credits per entity; 8 searches per turn max.
6. **Speed.** Parallel fan-out; step cap 3 with forced prose last; 600-char plain-text snippets; 10-minute search cache; live "Searching: …" status; Gemini thinking off (8.5 s → 3.4 s first token, measured).
7. **Free-tier failover.** `ModelPool` moves to the next model on any failure (rate limit, outage, empty answer, raw tool markup, or an uncited answer after a search), even mid-stream; `reset` discards partial text. Quotas are per model, so each provider takes a model list. Failed models are benched for the provider's own reset hint (max 1 h). If everyone is rate-limited it waits up to 20 s and retries once. SDK retries are off except on the last candidate: retrying a throttled model wastes seconds.
8. **Correctness plumbing.** Citation numbers are assigned in code per turn; a failed turn stores no messages; a per-session lock orders concurrent requests.
9. **Untrusted web.** Results are fenced as data, lookalike tags stripped, the UI escapes before rendering. Not covered: page wording can echo into a stored answer and re-enter the ledger.

## Considered and rejected

- **LangGraph / multi-agent planner:** more latency, no gain with one tool.
- **Vector DB for history:** history is small and recalled by date; exact beats approximate.
- **A memory tool, or a router model per query:** an extra hop on every turn.
- **Full-page fetching:** slow and token-heavy.
- **Per-session memory:** fails the "ask in a new chat" case.

## Verification

105 offline tests, no keys: date edge cases (leap day, DST, 00:30 across zones), the resolver, search retry/merge/cache, the tool loop, failover and cooldowns, the HTTP surface, and the exact request sent to each provider. `npm run eval` runs 16 live cases with a fixed clock, with deterministic checks (search-or-not, parallelism, correct `since`, citation integrity, every price grounded in a result or memory, prompt injection) plus an LLM judge.

**Live results, free tiers only: 10/16 (two runs).** The brief's three examples pass: five parallel searches, correct `since`, judge 5/5, 8.9 s end to end. The misses are mostly quota, not logic: free limits are per model per day (Gemini 2.5 Flash: 20/day), so heavy runs push answers onto weaker fallbacks or exhaust every provider, and the judge is itself a free, noisy model. The first run exposed real bugs, now fixed: two searches per entity, old releases reported as news, a fabricated recall, raw tool markup shown as an answer. For consistent quality set `ANTHROPIC_API_KEY`; it is tried first, the free chain stays as backup.

## With another week

- **Retrieval over memory:** FTS5 plus a date index so history beyond the ledger stays reachable; per-user scoping.
- **Scheduled re-checks:** "tell me when HubSpot changes pricing".
- **Source quality:** official-domain boosting; fetch the pricing table when a snippet lacks the number.
- **Runtime citation verification:** check each cited figure against its snippet before streaming.
