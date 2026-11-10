# DESIGN

The three example prompts look like search problems. They are **time and memory problems with a search step**: *which* Monday, *which* five tools, *what did I tell you then*. So I solved time and memory deterministically in code and left the model two jobs: decide what to search, and write the answer.

## How it works

```
POST /api/chat ─► load memory (SQLite) ─► build prompt ─► streamText loop, ONE tool ─► SSE ─► persist
                  this chat → real turns    cached rules       step 1: every search in parallel
                  other chats → dated       + calendar         step 2: only if surprised
                  ledger (budgeted)         + ledger           step 3: forced prose (tool_choice none)
```

`run.ts` is the loop (dependency-injected: server, evals and tests drive the same code). `temporal.ts` and `memory.ts` build context, `prompt.ts` holds behaviour rules, `tools/search.ts` is the only tool.

## Decisions, and why

1. **Memory and time are code, not tools.** A history-lookup tool costs an extra model round trip and breaks the one-tool brief. History is small and timestamped, so lookup is exact; the model just reads it.
2. **A calendar table, not model arithmetic.** Models get "last Tuesday" wrong. `temporal.ts` renders 28 days back and 7 forward, each labelled ("Tue 3 Nov: 7 days ago, last Tuesday"), using civil-date maths in the user's timezone (DST and midnight safe, tested).
3. **Memory is user-global.** "What did I ask on 3 November?" is usually asked in a *new* chat. The current chat is real timestamped turns; every other chat is a dated ledger (~3.5k tokens, newest kept; the 6 newest answers are never clipped because they are the ones re-verified). `history` and `now` on the API let a harness seed any scenario. Trade-off: one user, no auth, so unrelated test conversations in one DB can see each other.
4. **Old answers are claims to re-verify.** Stored `[1]` citations become `(src: neon.tech)` in later prompts: no number collisions, and the model knows *where to re-check*. The prompt gives a protocol: extract claims, search per entity, report changed / no change found / couldn't verify, and call a change "confirmed" only if a dated source says so. If the shortlist isn't in memory it asks, rather than guesses.
5. **`since` runs two queries in parallel.** A date filter alone drops pricing pages (they're undated), so the tool pairs a hard-dated query (what was published) with an unfiltered one (the current page). The model sees one tool. Cost: two search credits per entity, so five CRMs is ten parallel calls.
6. **Speed.** Parallel fan-out; step cap of 3 with forced prose last; prompt caching on the static rules (effective on Sonnet-class models; below the minimum cacheable size it is a no-op, not an error); Tavily `basic` depth and 600-char plain-text snippets; 10-minute LRU on searches; a live "Searching: …" stream; a "no text before tool calls" rule backed by a `reset` event that discards preamble anyway.
7. **Correctness plumbing.** Citation numbers are assigned in code per turn (parallel calls can't collide) and only cited sources are shown. A failed turn stores no messages, so a retry never duplicates. A per-session lock orders concurrent requests (testing caught a real timestamp-ordering bug here).
8. **Untrusted web.** Results are fenced as untrusted data, fence-lookalike tags are stripped from every field, and the prompt says never to obey them. The UI renderer escapes first and whitelists tags. Not covered: a malicious page's wording can echo into a stored answer and re-enter the ledger as quoted text.

## Considered and rejected

- **LangGraph / planner-executor / multi-agent:** more latency, no gain with one tool.
- **Vector DB for history:** history is small and recall is by date; exact beats approximate.
- **A memory tool, or a router model per query:** an extra hop on every turn.
- **Fetching full pages:** slow and token-heavy; snippets, plus a second round when needed.
- **Per-session memory:** fails the "ask in a new chat" case.

## Verification

67 offline tests, no keys needed: date edge cases (leap day, DST, 00:30 across zones), search retry/merge/cache rules, the whole tool loop on a scripted model, the HTTP surface, and the **exact request sent to Anthropic** (one tool, cache marker on the static block only, parallel tool results in one turn). `npm run eval` runs 16 cases on the live model with a fixed clock: search-or-not, one-round parallelism, correct `since`, citation integrity, an automatic **groundedness check** (every price must appear in a search result or memory), a prompt-injection case, and an LLM judge for behaviour.

**Live results:** _run `npm run eval`; the summary is written to `evals/results.md`._

## With another week

- **Retrieval over memory:** SQLite FTS5 plus a date index, so history beyond the ledger budget stays reachable; per-user scoping.
- **Scheduled re-checks:** "tell me when HubSpot changes pricing" as background claim re-verification.
- **Source quality:** official-domain boosting, fetching the pricing table when a snippet lacks the number.
- **Runtime citation verification:** check each cited figure appears in its snippet before streaming it (today only evals do).
