# Speed pass

Run on 2026-11-10 against the live services. Reproduce with `npm run bench`.

## A. Tavily search depth

6 pricing queries x 2 runs per depth. "Official" = an official domain appears in the top 5; "has price" = some snippet contains a $ figure.

| depth | median | p90 | official domain in top 5 | has price | results |
|---|---|---|---|---|---|
| basic | 0.3s | 1.3s | 33% | 100% | 5.0 |
| fast | 0.3s | 0.7s | 17% | 100% | 4.8 |
| ultra-fast | 0.3s | 0.3s | 33% | 100% | 5.0 |

## D. Why not ultra-fast?

It is 4x faster in A, so I checked what it costs.

- Same pages as basic? Mean top-5 overlap (Jaccard) **0.04**; identical top result in 0/6 queries.
- Does the `since` date filter still work? basic returned **5** results, ultra-fast returned **1**.

Decision: keep `basic`. ultra-fast returns different, more aggregator-heavy pages and breaks the date filter that "what changed since Monday" depends on.

## B. Snippet length

Tokens estimated at 4 chars/token. A 5-entity change check sends 5 searches' results to the model.

| snippet cap (chars) | tokens per search | tokens for 5 searches | snippets whose first price figure survives the cut |
|---|---|---|---|
| 300 | 563 | 2814 | 93% |
| 600 | 934 | 4668 | 97% |
| 900 | 1291 | 6453 | 100% |
| 1500 | 1603 | 8015 | 100% |

## C. End to end

`searches summed` is what the searches would cost run one after another; `search wall` is what the user actually waited. Cache read is nonzero only on Anthropic.

| case | model | searches | first status | searches summed | search wall | total | tokens in / out | cache read |
|---|---|---|---|---|---|---|---|---|
| search-current-fact | gemini-3.1-flash-lite | 1 | 7.6s | 1.3s | 1.3s | 10.3s | 5624 / 70 | 0 |
| multi-entity-parallel | gemini-3.1-flash-lite | 3 | 1.5s | 4.2s | 2.6s | 7.0s | 7650 / 545 | 0 |
| crm-changed-since-monday | nvidia/nemotron-3-ultra-550b-a55b | 5 | 39.0s | 15.8s | 5.7s | 78.2s | 12832 / 1793 | 0 |

Note: section C swings with which model answers. On free tiers a throttled primary hands the turn to a fallback and can add quota waits (an earlier run of the 5-CRM case took 6.8 s on gemini-3.1-flash-lite, with 14.3 s of searches collapsing to 3.8 s; this run fell through to nemotron and took 78 s). The parallelism ratio (summed vs wall) is the stable signal, not total time.
