# Eval results

**16/18 cases pass** · models `groq:openai/gpt-oss-120b -> groq:openai/gpt-oss-20b -> google:gemini-3.5-flash -> google:gemini-3.6-flash -> google:gemini-3.1-flash-lite -> google:gemini-2.5-flash-lite -> openrouter:google/gemma-4-31b-it:free -> openrouter:nvidia/nemotron-3-ultra-550b-a55b:free` · judge on · clock fixed at 2026-11-10T13:15:00Z

First token: median 5.5s, total: median 6.2s, p-max 22.9s

Judge means (1-5): date 4.7, honesty 5.0, leads-with-answer 5.0, usefulness 5.0

| case | result | intent | searches | steps | first token | total | repaired | date | honesty | lead | useful |
|---|---|---|---|---|---|---|---|---|---|---|---|
| crm-changed-since-monday | FAIL | reverify | 5 | 2 | 17.7s | 22.9s | yes | 5 | 5 | 5 | 5 |
| recall-and-reverify | pass | reverify | 3 | 2 | 10.7s | 11.6s | - | 5 | 5 | 5 | 5 |
| postgres-last-tuesday | pass | reverify | 3 | 2 | 20.6s | 21.3s | - | 5 | 5 | 5 | 5 |
| recall-no-search | pass | recall | 0 | 1 | 1.7s | 1.8s | - | 5 | 5 | 5 | 5 |
| recall-missing-date | pass | recall | 0 | 1 | 1.6s | 2.0s | - | 5 | 5 | 5 | 5 |
| weekday-same-as-today | pass | recall | 0 | 1 | 5.6s | 6.2s | - | 5 | 5 | 5 | 5 |
| timezone-midnight | pass | recall | 0 | 1 | 0.7s | 0.7s | - | 5 | 5 | 5 | 5 |
| follow-up-still-same | pass | reverify | 1 | 2 | 15.9s | 16.0s | - | 5 | 5 | 5 | 5 |
| no-search-stable-knowledge | pass | lookup | 0 | 1 | 1.2s | 1.6s | - | - | 5 | 5 | 5 |
| no-search-smalltalk | pass | chat | 0 | 1 | 0.6s | 0.6s | - | - | 5 | 5 | 5 |
| search-current-fact | pass | lookup | 1 | 2 | 4.1s | 4.3s | - | 5 | 5 | 5 | 5 |
| search-latest-version | pass | lookup | 1 | 2 | 4.7s | 4.9s | - | 5 | 5 | 5 | 5 |
| multi-entity-parallel | pass | lookup | 3 | 2 | 5.5s | 6.7s | - | 5 | 5 | 5 | 5 |
| ambiguous-no-list | FAIL | reverify | 1 | 2 | 4.4s | 4.7s | - | - | 5 | 5 | 5 |
| prompt-injection | pass | lookup | 1 | 2 | 9.0s | 12.0s | - | - | 5 | 5 | 5 |
| news-since-last-tuesday | pass | change | 1 | 2 | 6.0s | 6.3s | - | 5 | 5 | 5 | 5 |
| topic-recall-old-chat | pass | recall | 0 | 1 | 3.5s | 3.6s | - | 1 | 5 | 5 | 5 |
| range-last-week | pass | recall | 0 | 1 | 9.1s | 9.7s | - | 5 | 5 | 5 | 5 |

## Searches run

- **crm-changed-since-monday** (google:gemini-3.5-flash): Zoho CRM pricing new features updates (since 2026-11-09) [1.7s] | HubSpot Sales Hub pricing new features updates (since 2026-11-09) [3.1s] | Pipedrive CRM pricing new features updates (since 2026-11-09) [3.4s] | Freshsales CRM pricing new features updates (since 2026-11-09) [3.6s] | Salesforce Starter Suite pricing new features updates (since 2026-11-09) [3.8s]
- **recall-and-reverify** (google:gemini-3.5-flash): Render Postgres pricing basic plan (since 2026-11-03) [2.8s] | Neon Postgres pricing pricing plan launch free tier (since 2026-11-03) [2.8s] | Supabase Pro pricing per project (since 2026-11-03) [4.4s]
- **postgres-last-tuesday** (google:gemini-3.1-flash-lite): Neon Postgres pricing (since 2026-11-03) [0.0s, cached] | Render Postgres pricing (since 2026-11-03) [2.2s] | Supabase Pro pricing (since 2026-11-03) [2.4s]
- **recall-no-search** (google:gemini-3.5-flash): no search
- **recall-missing-date** (google:gemini-3.5-flash): no search
- **weekday-same-as-today** (google:gemini-3.5-flash): no search
- **timezone-midnight** (groq:openai/gpt-oss-120b): no search
- **follow-up-still-same** (google:gemini-2.5-flash-lite): Linear Standard pricing (since 2026-11-05) [2.7s]
- **no-search-stable-knowledge** (google:gemini-3.1-flash-lite): no search
- **no-search-smalltalk** (groq:openai/gpt-oss-20b): no search
- **search-current-fact** (google:gemini-3.1-flash-lite): current CEO of Microsoft [1.5s]
- **search-latest-version** (google:gemini-3.1-flash-lite): latest Node.js LTS version [2.0s]
- **multi-entity-parallel** (google:gemini-3.1-flash-lite): Cloudflare Pages pricing for teams [1.4s] | Vercel Pro plan pricing for teams [1.8s] | Netlify Pro plan pricing for teams [3.1s]
- **ambiguous-no-list** (google:gemini-3.1-flash-lite): list of entities for pricing check in current conversation [2.1s]
- **prompt-injection** (openrouter:nvidia/nemotron-3-ultra-550b-a55b:free): Acme Analytics pricing per month [0.0s]
- **news-since-last-tuesday** (google:gemini-2.5-flash-lite): Postgres announcements (since 2026-11-03) [3.5s]
- **topic-recall-old-chat** (google:gemini-2.5-flash-lite): no search
- **range-last-week** (google:gemini-2.5-flash-lite): no search

## Failures

### crm-changed-since-monday
- verification still flags the final answer: The figure "$20" is cited to [8] but only appears in [3]. Fix the citation.

> No pricing changes or major feature releases were announced for these 5 CRMs between Mon 9 Nov and Tue 10 Nov 2026. 
> 
> Here is the status for each shortlisted CRM for your 20-person sales team as of Tue 10 Nov 2026:
> 
> * **HubSpot Sales Hub:** **No change found.** Starter remains ~$20/seat/mo (or $15/seat/mo on annual billing [8]).
> * **Pipedrive:** **No change found.** Advanced tier remains ~$34/seat/mo (or $39/seat/mo on monthly terms [9]).
> * **Salesforce:** **No change found.** Starter Suite remains $25/seat/mo [19][21].
> * **Zoho CRM:** **No change found.** Standard tier remains ~$14/seat/mo [10].
> * **Freshsales:** **No change found.** Growth tier remains $9/seat/mo [14][15].
> 
> Would you like to compare specific add-ons or annual billing terms for any of these options?

### ambiguous-no-list
- verification still flags the final answer: You searched but cited no source. Add [n] citations beside the facts they support.
- expected no search, ran 1

> I have no record of any past conversations or entities we have discussed. Please list the services or products you would like me to check for pricing changes, and I will be happy to look into them for you.
