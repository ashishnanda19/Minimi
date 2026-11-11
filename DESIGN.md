# DESIGN

The example prompts look like search problems. They are **memory and time problems with a search step**: *which* Monday, *which* five tools, *what did I tell you then*. So judgement is split: code decides what is remembered, what a date means, whether to search, and whether an answer is supported. The model decides what to search and writes the answer.

```
message ─► REMEMBER   recent-chat ledger + full-text retrieval of old chats + exact lookup of any day or span named
        ─► REASON     earlier answers become a claim checklist; code decides: forbid search / require search / ask which
        ─► RESEARCH   ONE tool, parallel searches, official sources ranked first, dated + current-page query pair
        ─► VERIFY     figures, citations, dates and "no change" claims checked against sources; fixes in code; one repair
        ─► ModelPool  Claude if keyed, else free models with failover            (per-user memory in SQLite)
```

## Decisions

1. **Memory is code, not a tool** (a tool costs a round trip and breaks the one-tool brief). Recent chats form a dated ledger; **older ones are found by topic** (SQLite FTS5, BM25 plus recency; a word counts only if distinctive in that user's history). Memory is per user (a browser id).
2. **Dates are resolved by code, including spans:** "last Tuesday", "last week", "in October", "2 weeks ago", "this morning" become exact timezone-correct ranges, and the prompt is told what is stored for them ("NO stored messages in that span; nearest: 3 Nov"). Otherwise a weak model invents a recall.
3. **Search policy is enforced, not requested.** Recall and small talk cannot search (0.4-1.3 s). "Is that still correct?" **must** search first. "Has any of *them* changed?" with nothing remembered cannot search: it asks which.
4. **Old answers are a claim checklist** (entity, figure, source), minus bullet headings that are not products; the verifier flags any claim the new answer skips.
5. **`since` runs two queries:** hard-dated, and the undated current page. Results are tagged official or review-site and ranked; if a pricing query returns no page from the vendor, one more query restricted to its likely domains goes looking.
6. **Every answer is verified, without a model.** Each figure must be in a cited source, in a remembered sentence *about the same entity*, or be arithmetic on those. A cited page must be *about* what it is cited for. "No change found" is refused if a source dated inside the window describes a change beside that name, or if nothing was retrieved at all. Wrong citations are **corrected in code**; the rest gets one repair pass. What remains is shown: a chip, and an underline on the figure.
7. **Free-tier failover:** any failure (rate limit, timeout, empty, uncited, raw tool markup) moves to the next model, even mid-stream; providers take model lists. Titles use free models only.

**Rejected:** LangGraph/multi-agent (latency, no gain with one tool) · vector DB (FTS5 plus exact date lookup is exact where it matters) · asking the model to self-check (it shares its blind spot) · full-page fetch (slow).

**Found by testing, fixed, each with a regression test:** a remembered "$19" for Neon vouched for HubSpot's "$19" · a correct recall was "repaired" by deleting its prices · a splitter cut "26.99.0" in half · the prompt's own notes (`[said …]`) leaked into an answer · headings ("Total Cost of Ownership") were re-verified as products · Railway pricing was cited to government pages · "No changes found" was reported after every search had failed · a stalled provider held a turn 75 s.

## Results (`npm run eval`, free providers only)

**17/18 in the full run** (before the last checks above; a re-run was blocked when the free Tavily quota ran out). The miss was a verifier false positive, since fixed. Judge means (date, honesty, lead, useful): **5.0 / 5.0 / 5.0 / 5.0**. Median first token 3.7 s.

| case | intent | searches | total |
|---|---|---|---|
| CRM shortlist, "changed since Monday?" | reverify | 5 | 19.7 s |
| "What did I ask on 3 Nov? Still correct?" | reverify | 3 | 19.3 s |
| old Postgres chat, found by topic | recall | 0 | 0.9 s |
| "What did I ask you last week?" | recall | 0 | 1.3 s |
| "Has any of **them** changed…?" (no memory) | asks which | 0 | 1.3 s |
| hostile search result | lookup | 1 | 2.5 s |

Speed (`evals/speed.md`): Gemini thinking off 8.5 s → 3.4 s; 5 parallel searches 14.3 s → 3.8 s; a per-model deadline cut a stalled turn from 123 s to 8 s. Free quotas (models and Tavily) are the weak spot; `ANTHROPIC_API_KEY` is tried first.

**Next:** entity-aware retrieval, scheduled re-checks, fetching a pricing table when a snippet lacks the number, real accounts on the browser id.
