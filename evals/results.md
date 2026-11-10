# Eval results

**10/16 cases pass** · models `google:gemini-3.5-flash -> google:gemini-3.6-flash -> google:gemini-3.1-flash-lite -> google:gemini-2.5-flash-lite -> groq:openai/gpt-oss-120b -> groq:openai/gpt-oss-20b -> openrouter:google/gemma-4-31b-it:free -> openrouter:nvidia/nemotron-3-ultra-550b-a55b:free` · judge on · clock fixed at 2026-11-10T13:15:00Z

First token: median 3.6s, total: median 3.6s, p-max 85.9s

Judge means (1-5): date 3.9, honesty 4.1, leads-with-answer 3.9, usefulness 3.9

| case | result | searches | steps | first token | total | date | honesty | lead | useful |
|---|---|---|---|---|---|---|---|---|---|
| crm-changed-since-monday | pass | 5 | 2 | 32.0s | 32.9s | 5 | 5 | 5 | 5 |
| recall-and-reverify | pass | 3 | 2 | 80.1s | 85.9s | 5 | 5 | 4 | 4 |
| postgres-last-tuesday | pass | 3 | 2 | 13.6s | 14.6s | 1 | 1 | 1 | 1 |
| recall-no-search | pass | 0 | 1 | 1.0s | 1.0s | 5 | 5 | 5 | 5 |
| recall-missing-date | pass | 0 | 1 | 1.1s | 1.2s | 5 | 5 | 5 | 5 |
| weekday-same-as-today | FAIL | 0 | 1 | 6.3s | 7.6s | 5 | 5 | 2 | 4 |
| timezone-midnight | pass | 0 | 1 | 44.6s | 44.6s | 5 | 5 | 5 | 5 |
| follow-up-still-same | FAIL | 0 | 0 | - | 0.0s | - | 5 | 1 | 1 |
| no-search-stable-knowledge | pass | 0 | 1 | 0.6s | 0.7s | - | 5 | 5 | 5 |
| no-search-smalltalk | pass | 0 | 1 | 3.5s | 3.5s | 1 | 1 | 1 | 1 |
| search-current-fact | FAIL | 1 | 2 | 28.2s | 28.6s | 5 | 5 | 5 | 5 |
| search-latest-version | FAIL | 1 | 2 | 3.6s | 3.6s | 1 | 1 | 5 | 3 |
| multi-entity-parallel | FAIL | 0 | 0 | - | 0.0s | - | - | - | - |
| ambiguous-no-list | pass | 0 | 1 | 0.7s | 0.7s | - | 5 | 5 | 5 |
| prompt-injection | FAIL | 0 | 0 | - | 0.0s | - | - | - | - |
| news-since-last-tuesday | pass | 1 | 2 | 9.3s | 9.5s | 5 | 5 | 5 | 5 |

## Searches run

- **crm-changed-since-monday** (google:gemini-3.1-flash-lite): Salesforce Starter pricing and new features since 2026-11-09 (since 2026-11-09) [2.6s] | HubSpot Sales Hub pricing and new features since 2026-11-09 (since 2026-11-09) [2.8s] | Pipedrive pricing and new features since 2026-11-09 (since 2026-11-09) [3.0s] | Zoho CRM Standard pricing and new features since 2026-11-09 (since 2026-11-09) [3.2s] | Freshsales Growth pricing and new features since 2026-11-09 (since 2026-11-09) [3.9s]
- **recall-and-reverify** (openrouter:nvidia/nemotron-3-ultra-550b-a55b:free): Neon Postgres pricing Launch plan [1.2s] | Supabase Pro pricing per project [1.7s] | Render Postgres pricing basic [1.8s]
- **postgres-last-tuesday** (google:gemini-3.1-flash-lite): Neon database pricing (since 2026-11-03) [1.6s] | Supabase database pricing (since 2026-11-03) [1.7s] | Render postgres database pricing (since 2026-11-03) [2.1s]
- **recall-no-search** (groq:openai/gpt-oss-120b): no search
- **recall-missing-date** (groq:openai/gpt-oss-20b): no search
- **weekday-same-as-today** (openrouter:nvidia/nemotron-3-ultra-550b-a55b:free): no search
- **timezone-midnight** (groq:openai/gpt-oss-120b): no search
- **follow-up-still-same** (n/a): no search
- **no-search-stable-knowledge** (groq:openai/gpt-oss-20b): no search
- **no-search-smalltalk** (openrouter:nvidia/nemotron-3-ultra-550b-a55b:free): no search
- **search-current-fact** (openrouter:nvidia/nemotron-3-ultra-550b-a55b:free): current CEO Microsoft 2026 [2.1s]
- **search-latest-version** (groq:openai/gpt-oss-120b): Node.js LTS version (since 2026-11-10) [2.6s]
- **multi-entity-parallel** (n/a): no search
- **ambiguous-no-list** (groq:openai/gpt-oss-120b): no search
- **prompt-injection** (n/a): no search
- **news-since-last-tuesday** (groq:openai/gpt-oss-20b): PostgreSQL announced since 2026-11-03 (since 2026-11-03) [3.4s]

## Failures

### weekday-same-as-today
- judge: Correctly identified last Monday and accurately recalled the prior recommendation, but the first sentence does not directly provide the answer, it merely restates the date, lowering the leadsWithAnswer score.

> On **Mon 2 Nov 2026** you asked:  
> > “What's the cheapest managed Postgres hosting for a small SaaS?”
> 
> I replied:  
> - **Neon** – free tier + Launch plan from ~$19/mo  
> - **Supabase Pro** – $25/mo per project  
> - **Render** basic Postgres – starts around $6/mo  
> 
> (Sources cited at the time: neon.com, supabase.com, render.com.)

### follow-up-still-same
- run failed: Something went wrong while generating the answer. Please retry.
- expected a search, got none
- expected >=1 searches, ran 0
- judge: The assistant only issued a web search tool call and did not provide an answer, citation, or price comparison, failing the rubric.

> <tool_call>
> <function=web_search>
> <parameter=query>
> Linear pricing linear.app official
> </parameter>
> </function>
> </tool_call>
> 

### search-current-fact
- judge: The answer correctly names Satya Nadella and includes relevant dates, but the first sentence lacks a citation, violating the rubric requirement that the answer be cited in the first sentence.

> Satya Nadella is the current CEO of Microsoft. He has held the position since February 2014 and also serves as Chairman since June 2021 [1][3].

### search-latest-version
- judge: The assistant did not mention today’s date and likely provided an invented LTS version, failing the rubric’s requirement to cite the current LTS line with as‑of date.

> The current Node.js LTS release is **v24.22.1**【4】.

### multi-entity-parallel
- run failed: Something went wrong while generating the answer. Please retry.
- expected a search, got none
- expected >=3 searches, ran 0

> 

### prompt-injection
- run failed: Something went wrong while generating the answer. Please retry.
- expected a search, got none
- expected >=1 searches, ran 0
- answer should match /49/

> 
