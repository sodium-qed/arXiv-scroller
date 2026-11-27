# Indexing and readership coverage

The completed OpenAIRE census does **not** establish usable Trending or Rising data. It found exact metadata matches for **6 of 2,555 Recent papers (0.2348%)** and **179 of 701 Today papers (25.5350%)**, but no matched record supplied either a view count or a download count. These results describe the frozen populations and recorded request period, not future provider coverage. The authoritative evidence is the [coverage report and request ledger](../../research/trending/coverage-results.json).

## Complete populations and outcomes

Every distinct identifier in the two complete official arXiv mathematics listings was queried: **2,783 union identifiers**, with **473 shared identifiers** counted against both original population denominators. This was a census, not a sample. Collection ran from **2026-11-26T23:41:27.990Z to 2026-11-26T23:42:36.712Z**. All **56 census requests returned HTTP 200**, using at most 50 arXiv identifiers per batch. Three separate diagnostics brought the session total to **59 requests**; the [recorded probes](../../research/trending/provider-probes.json) are not coverage observations.

| Population | Eligible | Exact matches | No exact match | Matched but metric unavailable | Measured zero | Measured positive | Unresolved / untested |
|---|---:|---:|---:|---:|---:|---:|---:|
| Recent | 2,555 | 6 | 2,549 | 6 | 0 | 0 | 0 / 0 |
| Today | 701 | 179 | 522 | 179 | 0 | 0 | 0 / 0 |

The metric columns apply **separately and identically to views and downloads**. Metric coverage and positive-measurement coverage are each 0/2,555 for Recent and 0/701 for Today. Conditional metric availability is 0/6 and 0/179; positive/measured is undefined because there are no measurements. **Missing is not zero:** no response established a genuine zero count. A successful complete exact-ID query with no returned match is classified as `not_indexed` for this endpoint and observation time; authentication, rate-limit and network failures would remain unresolved instead. None occurred during the census.

## Cohorts, categories and Today bias

Today matches came from **0/379 new submissions**, **1/61 cross-submissions** and **178/261 replacements**. Its higher match rate therefore does not establish prompt indexing of new papers: replacement records can represent papers submitted much earlier. Recent supplied no submission-type labels, so its 2,555 entries retain `unknown`.

The existing comparison report contains the complete [Today section table](provider-comparison.md#why-today-matches-more-often), [five Recent announcement cohorts](provider-comparison.md#recent-announcement-cohorts) and [all 32 mathematics-category tables](provider-comparison.md#coverage-across-all-32-mathematics-categories). Category rows include cross-list memberships and overlap. Every category and date cohort had zero available usage measurements. The machine-readable report additionally retains announcement-age breakdowns; announcement age does not measure first-submission age, indexing latency or elapsed time to the first positive measurement.

## Raw evidence, hashes and offline replay

The [per-paper CSV](../../research/trending/coverage-results.csv) and [normalized observations](../../research/trending/observations.json) preserve individual outcomes. The request ledger links every exact raw response under `research/trending/provider-responses/` and records its URL, identifiers, retrieval timestamp and SHA-256 hash. Population manifests retain source HTML hashes and parser-replay inputs: [Recent manifest](../../research/trending/populations/recent-manifest.json) and [Today manifest](../../research/trending/populations/today-manifest.json).

| Frozen population | Retrieved at | Population JSON SHA-256 |
|---|---|---|
| [Recent](../../research/trending/populations/recent.json) | `2026-11-26T23:33:54.746305+00:00` | `0847fea85df6aa67e3d4a5b5265bb4b1a492c84bc823d9dc4cb736a522530773` |
| [Today](../../research/trending/populations/today.json) | `2026-11-26T23:37:45.314388+00:00` | `c060db9f5e99f18039707ece3268e2d03118e717339af49c1548e9283fad19e9` |

From the repository root, run:

```sh
node scripts/replay-readership-experiment.mjs
```

The replay verifies hashes, reprocesses the raw responses, reconciles the coverage tables and reruns the ranking gates without network access. Expected output is `verified: true`, 56 requests, 2,783 distinct queried identifiers, the counts above, and unavailable Trending/Rising for both metrics. [Full reproduction instructions](experiment-running.md) also cover production-parser replay from the archived arXiv HTML. [Methodology](trending-methodology.md) and [limitations](trending-limitations.md) explain the quality gates, unknown metric freshness and absence of validated cumulative history. No conclusion about unmeasured providers follows from this census.
