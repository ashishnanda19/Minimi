# Eval results

**2/2 cases pass** · models `groq:openai/gpt-oss-120b -> groq:openai/gpt-oss-20b -> google:gemini-3.5-flash -> google:gemini-3.6-flash -> google:gemini-3.1-flash-lite -> google:gemini-2.5-flash-lite -> openrouter:google/gemma-4-31b-it:free -> openrouter:nvidia/nemotron-3-ultra-550b-a55b:free` · judge on · clock fixed at 2026-11-10T13:15:00Z

First token: median 37.7s, total: median 43.7s, p-max 43.7s

Judge means (1-5): date 5.0, honesty 5.0, leads-with-answer 4.5, usefulness 5.0

| case | result | intent | searches | steps | first token | total | repaired | date | honesty | lead | useful |
|---|---|---|---|---|---|---|---|---|---|---|---|
| recall-and-reverify | pass | reverify | 3 | 2 | 37.7s | 43.7s | - | 5 | 5 | 4 | 5 |
| postgres-last-tuesday | pass | reverify | 3 | 2 | 12.5s | 13.3s | - | 5 | 5 | 5 | 5 |

## Searches run

- **recall-and-reverify** (openrouter:nvidia/nemotron-3-ultra-550b-a55b:free): Supabase Pro pricing per project (since 2026-11-03) [2.4s] | Neon Postgres pricing Launch plan (since 2026-11-03) [3.4s] | Render Postgres pricing basic (since 2026-11-03) [4.0s]
- **postgres-last-tuesday** (google:gemini-3.1-flash-lite): Supabase Pro pricing (since 2026-11-03) [1.3s] | Neon database pricing (since 2026-11-03) [1.4s] | Render Postgres database pricing (since 2026-11-03) [3.4s]

