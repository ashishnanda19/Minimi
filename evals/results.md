# Eval results

**2/2 cases pass** · models `groq:openai/gpt-oss-120b -> groq:openai/gpt-oss-20b -> google:gemini-3.5-flash -> google:gemini-3.6-flash -> google:gemini-3.1-flash-lite -> google:gemini-2.5-flash-lite -> openrouter:google/gemma-4-31b-it:free -> openrouter:nvidia/nemotron-3-ultra-550b-a55b:free` · judge on · clock fixed at 2026-11-10T13:15:00Z

First token: median 17.4s, total: median 18.3s, p-max 18.3s

Judge means (1-5): date 5.0, honesty 5.0, leads-with-answer 5.0, usefulness 5.0

| case | result | intent | searches | steps | first token | total | repaired | date | honesty | lead | useful |
|---|---|---|---|---|---|---|---|---|---|---|---|
| postgres-last-tuesday | pass | reverify | 3 | 2 | 16.5s | 17.0s | - | 5 | 5 | 5 | 5 |
| five-vendors-no-leaks | pass | reverify | 5 | 2 | 17.4s | 18.3s | - | 5 | 5 | 5 | 5 |

## Searches run

- **postgres-last-tuesday** (google:gemini-3.1-flash-lite): Neon database pricing (since 2026-11-03) [1.6s] | Supabase database pricing (since 2026-11-03) [1.9s] | Render postgres database pricing (since 2026-11-03) [4.5s]
- **five-vendors-no-leaks** (google:gemini-3.1-flash-lite): Neon database pricing (since 2026-11-09) [0.3s] | Supabase pricing (since 2026-11-09) [0.6s] | DigitalOcean managed database pricing (since 2026-11-09) [2.7s] | Railway pricing (since 2026-11-09) [3.9s] | PlanetScale pricing (since 2026-11-09) [4.1s]

