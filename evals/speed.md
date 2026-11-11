# Speed pass

Run on 2026-11-11 against the live services. Reproduce with `npm run bench`.

## A. Tavily search depth

6 pricing queries x 2 runs per depth. "Official" = an official domain appears in the top 5; "has price" = some snippet contains a $ figure.

| depth | median | p90 | official domain in top 5 | has price | results |
|---|---|---|---|---|---|
| basic | 1.4s | 2.2s | 33% | 100% | 5.0 |
| fast | 0.7s | 1.2s | 17% | 100% | 4.8 |
| ultra-fast | 0.3s | 0.9s | 33% | 100% | 5.0 |

## D. Why not ultra-fast?

It is 4x faster in A, so I checked what it costs.

- Same pages as basic? Mean top-5 overlap (Jaccard) **0.04**; identical top result in 0/6 queries.
- Does the `since` date filter still work? basic returned **5** results, ultra-fast returned **1**.

Decision: keep `basic`. ultra-fast returns different, more aggregator-heavy pages and breaks the date filter that "what changed since Monday" depends on.

## B. Snippet length

Tokens estimated at 4 chars/token. A 5-entity change check sends 5 searches' results to the model.

| snippet cap (chars) | tokens per search | tokens for 5 searches | snippets whose first price figure survives the cut |
|---|---|---|---|
| 300 | 561 | 2803 | 93% |
| 600 | 916 | 4578 | 100% |
| 900 | 1266 | 6328 | 100% |
| 1500 | 1631 | 8155 | 100% |

## C. End to end

`searches summed` is what the searches would cost run one after another; `search wall` is what the user actually waited. Cache read is nonzero only on Anthropic.

| case | model | searches | first status | searches summed | search wall | total | tokens in / out | cache read |
|---|---|---|---|---|---|---|---|---|
| search-current-fact | claude-sonnet-5-5 | 1 | 1.7s | 0.3s | 0.3s | 4.2s | 8240 / 265 | 4956 |
| multi-entity-parallel | claude-sonnet-5-5 | 3 | 1.3s | 4.6s | 2.9s | 10.2s | 10538 / 909 | 4956 |
| crm-changed-since-monday | claude-sonnet-5-5 | 5 | 1.3s | 15.9s | 6.1s | 17.1s | 14133 / 1636 | 4956 |


Note: section C swings with which model answers. On free tiers a throttled primary hands the turn to a fallback and can add quota waits (one earlier run of the 5-CRM case took 6.8 s on gemini-3.1-flash-lite with 14.3 s of searches collapsing to 3.8 s; this run fell through to nemotron and took 78 s). The parallelism ratio (summed vs wall) is the stable signal, not total time.

