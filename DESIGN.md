# DESIGN

The example prompts look like search problems. They are **time and memory problems with a search step**: *which* Monday, *which* five tools, *what did I tell you then*. So time and memory are solved deterministically in code, and the model has two jobs: decide what to search, and write the answer.

```
POST /api/chat ─► load memory (SQLite) ─► build prompt ─► streamText loop, ONE tool ─► SSE ─► persist
                  this chat → real turns    rules              step 1: all searches in parallel
                  other chats → dated       + calendar         step 2: only if surprised
                  ledger (budgeted)         + ledger           step 3: forced prose (tool_choice none)
                                                   ▲ ModelPool: Gemini → Groq → OpenRouter (→ Anthropic first if keyed)
```

## Decisions, and why

1. **Memory and time are code, not tools.** A history tool costs an extra model round trip and breaks the one-tool brief. History is small and timestamped, so exact lookup beats retrieval.
2. **A calendar table, not model arithmetic.** `temporal.ts` renders 28 days back and 7 forward, labelled ("Tue 3 Nov: 7 days ago, last Tuesday"), with civil-date maths in the user's timezone (DST and midnight safe, tested). The prompt forbids weekday arithmetic. A resolver then parses "last Tuesday", "3 November", "5 days ago" in the user's message and looks up what is stored for that day, so the model is told "NO stored messages on 20 Oct; nearest: 3 Nov" instead of being trusted to say so. A live eval showed a weak fallback model otherwise invents a recall.
3. **Memory is user-global.** "What did I ask on 3 November?" is usually asked in a *new* chat. The current chat is real timestamped turns; other chats form a dated ledger (~3.5k tokens, newest kept, six newest answers never clipped since those get re-verified). `history` and `now` on the API let a harness seed any scenario. Trade-off: one user, no auth, so unrelated test chats in one DB can see each other.
4. **Old answers are claims to re-verify.** Stored `[1]` becomes `(src: neon.tech)` in later prompts: no number collisions, and the model knows where to re-check. The prompt's protocol: extract claims, search per entity, report changed / no change found / couldn't verify, and call a change "confirmed" only if a dated source says so. If the shortlist isn't in memory it asks.
5. **`since` runs two queries in parallel.** A date filter alone drops pricing pages (undated), so a hard-dated query (what was published) is paired with an unfiltered one (the current page). One tool for the model; two search credits per entity.
6. **Speed.** Parallel fan-out; step cap of 3 with forced prose last; Anthropic prompt caching on the static rules; `basic` search depth, 600-char plain-text snippets; 10-minute search LRU; live "Searching: …" status; a "no text before tool calls" rule backed by a `reset` event.
7. **Free-tier failover.** `ModelPool` moves to the next provider on any failure (rate limit, outage, bad tool call, empty answer), even mid-stream; `reset` discards partial text so answers never splice. A failed provider is benched (60 s for rate limits, 10 min for bad keys) so the next request skips it. SDK retries are off except on the last candidate, since retrying a throttled provider wastes seconds. Weaker free models follow the rules less reliably, so quality is ordered by position.
8. **Correctness plumbing.** Citation numbers are assigned in code per turn, and only cited sources are shown. A failed turn stores no messages, so retries never duplicate. A per-session lock orders concurrent requests (tests caught a real timestamp-ordering bug).
9. **Untrusted web.** Results are fenced as data, fence-lookalike tags are stripped from every field, and the UI renderer escapes first and whitelists tags. Not covered: a malicious page's wording can echo into a stored answer and re-enter the ledger as quoted text.

## Considered and rejected

- **LangGraph / multi-agent planner:** more latency, no gain with one tool.
- **Vector DB for history:** history is small and recalled by date; exact beats approximate.
- **A memory tool, or a router model per query:** an extra hop on every turn.
- **Full-page fetching:** slow and token-heavy; snippets, plus a second round when needed.
- **Per-session memory:** fails the "ask in a new chat" case.

## Verification

105 offline tests, no keys needed: date edge cases (leap day, DST, 00:30 across zones), the date resolver, search retry/merge/cache, the whole tool loop on a scripted model, failover and cooldowns, the HTTP surface, and the **exact requests sent to each provider**. `npm run eval` runs 16 cases on the live models with a fixed clock: search-or-not, one-round parallelism, correct `since`, citation integrity, a **groundedness check** (every price must appear in a search result or memory), a prompt-injection case, and an LLM judge.

**Live results, free tiers only (two full runs, 10/16 and 10/16):** the brief's three examples pass in the latest run (5 parallel searches, correct `since`, judge 5/5 on the CRM case; 8.9 s end to end when the primary model answers). Residual failures are not agent logic: free quotas are per model and per day (Gemini 2.5 Flash allows 20 requests/day), so heavy eval days push answers onto weaker fallbacks (gpt-oss-20b, nemotron), which cite less and skip rules, or exhaust every provider. The judge is itself a free model and noisy. The first run found real bugs I fixed: double searching per entity (10 searches for 5 tools), old releases reported as news, a fabricated recall for an unrecorded date, a model printing raw tool-call markup, and a provider-specific tool-choice rejection. For consistent quality set `ANTHROPIC_API_KEY`: it is tried first and the free chain stays as backup.

## With another week

- **Retrieval over memory:** SQLite FTS5 plus a date index, so history beyond the ledger budget stays reachable; per-user scoping.
- **Scheduled re-checks:** "tell me when HubSpot changes pricing" as background claim re-verification.
- **Source quality:** official-domain boosting; fetch the pricing table when a snippet lacks the number.
- **Runtime citation verification:** check each cited figure appears in its snippet before streaming it (today only evals do).
