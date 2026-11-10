# DESIGN

The three example prompts look like search problems. They are **time and memory problems with a search step**: *which* Monday, *which* five tools, *what did I tell you then*. So I solved time and memory deterministically in code, and left the model two jobs: decide what to search, and write the answer.

## How it works

```
POST /api/chat ─► load memory (SQLite) ─► build prompt ─► streamText loop, ONE tool ─► SSE ─► persist
                  this chat → real turns    cached rules       step 1: every search in parallel
                  other chats → dated       + calendar         step 2: only if surprised
                  ledger (token-budgeted)   + ledger           step 3: forced prose (tool_choice none)
```

`src/agent/run.ts` is the loop (dependency-injected, so server, evals and tests drive the same code). `temporal.ts` and `memory.ts` build the context, `prompt.ts` holds the behaviour rules, `tools/search.ts` is the only tool.

## Decisions, and why

1. **Memory and time are code, not tools.** A history-lookup tool would cost an extra model round trip and break the one-tool brief. History is small and timestamped, so lookup is exact; the model just reads it.
2. **A calendar table, not model arithmetic.** Models get "last Tuesday" wrong. `temporal.ts` renders 28 days back and 7 forward, each labelled ("Tue 3 Nov: 7 days ago, last Tuesday"), using civil-date maths in the user's timezone (DST- and midnight-safe, tested). The prompt forbids weekday arithmetic.
3. **Memory is user-global.** "What did I ask on 3 November?" is usually asked in a *new* chat. Current chat = real turns with timestamps; every other chat = a dated ledger in the system prompt, newest-first under a ~3.5k-token budget. `history` and `now` on the API let a harness seed any scenario. Assumption: single user, no auth.
4. **Old answers are claims to re-verify.** Stored citations `[1]` are rewritten to `(src: neon.tech)` in later prompts: no number collisions, and the model knows *where to re-check*. The prompt gives an explicit protocol: extract claims, search per entity, report changed / no change found / couldn't verify, and only call a change "confirmed" if a source states it.
5. **`since` runs two queries in parallel.** A date filter alone drops pricing pages (they're undated). The tool pairs the dated query (what was published) with an unfiltered one (current official page). The model sees one simple tool; I pay one extra search credit.
6. **Speed.** Parallel fan-out (5 CRMs ≈ 1 search of latency); step cap of 3 with forced prose on the last; Anthropic prompt caching on the static rules; Tavily `basic` depth, 600-char snippets as plain text not JSON; 10-minute LRU on searches; a live "Searching: …" status stream; "no text before tool calls" rule, backed by a `reset` event that discards any preamble anyway.
7. **Correctness plumbing.** Citation numbers are assigned in code per turn (parallel calls can't collide); only cited sources are shown. A turn is persisted only if it completes, so a retry never duplicates. A per-session lock orders concurrent requests (this caught a real timestamp-ordering bug in testing).
8. **Untrusted web.** Results are fenced as untrusted, a fake closing tag is stripped, the prompt says never to obey them; the UI's markdown renderer escapes first and whitelists tags (tested against XSS).

## Considered and rejected

- **LangGraph / planner-executor / multi-agent:** more latency, no gain with one tool. The AI SDK loop is enough.
- **Vector DB for history:** history is small and recall is by date; exact beats approximate.
- **A separate memory tool:** extra round trip, violates the brief.
- **Router model before each query:** adds a hop to every turn; the prompt's search rules cost nothing.
- **Fetching full pages:** slow and token-heavy; snippets plus a second round when needed.
- **Per-session memory:** fails the "ask in a new chat" case.

## Verification

60 offline tests (no keys): date edge cases (leap day, DST, 00:30 across zones), search retry/merge/cache rules, the full tool loop on a scripted model, the real HTTP surface, and the **exact request sent to Anthropic** (one tool, cache marker on the static block only, parallel tool results in one turn). `npm run eval` runs 17 cases on the live model with a fixed clock: search-or-not, parallelism, correct `since`, citation integrity, an automatic **groundedness check** (every price in an answer must appear in a search result or memory), a prompt-injection case, plus an LLM judge for behaviour.

**Live eval results:** _paste the summary from `evals/results.md` after `npm run eval`._

## With another week

- **Retrieval over memory:** SQLite FTS5 + date index so conversations beyond the ledger budget stay reachable.
- **Scheduled re-checks:** "tell me when HubSpot changes pricing", run as a background claim re-verification.
- **Source quality:** official-domain boosting, and fetching a pricing table when the snippet lacks the number.
- **Runtime citation verification:** check each cited figure appears in its snippet before streaming it (today this runs only in evals).
- **Per-claim confidence** in the UI, and per-user memory with auth.
