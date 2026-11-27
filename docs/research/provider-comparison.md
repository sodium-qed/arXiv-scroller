# Provider comparison and selection gate

Review date: **2026-11-26**. Companion evidence: [source investigation](trending-data-sources.md) and [machine-readable evaluations](provider-evaluations.json).

## Decision

**No automatic default readership provider has been selected.** A completed OpenAIRE census found no available view/download measurements in either frozen population. ADS and Mendeley could not be evaluated beyond authentication failures. An unavailable-data outcome is the correct result: none of these observations supports a meaningful current readership ranking.

ADS/SciX is the next close readership candidate if authorized access and retention permission become available. Mendeley is a clear save-count candidate under its own label. OpenAIRE remains a useful reproducible negative result for these cohorts. Other services can support explicitly named attention or citation views only after the same identity, coverage and freshness tests. Counts from different services must not be summed: their populations and possible overlap are unknown.

## Required rubric

| Criterion | Maximum | Evidence needed to score it | Current evaluation |
|---|---:|---|---|
| Recent metric coverage | 25 | Matched, measured, zero, positive and unresolved counts against a complete frozen Recent denominator | OpenAIRE: measured 0/2,555; all other providers unknown. Metadata-only coverage does not qualify |
| Metric freshness | 20 | Per-metric timestamps or repeated observations of the same cohort | Unknown; a retrieval timestamp alone does not prove metric freshness |
| Measurement validity | 20 | Definition of the event, window, deduplication, source and units | Documented to varying degrees; assign a qualitative finding before a numeric score |
| Pure mathematics coverage | 15 | Breakdowns for all 32 categories, with zero-population and untested categories explicit | OpenAIRE: no measured views/downloads in any of the 32 populated categories; other providers unknown |
| Accessibility and integration | 10 | Authorized credentials/terms, successful request, exact matching, pagination and failure handling | OpenAIRE: complete anonymous census succeeded. Other access findings remain provider-specific |
| Cost and quota suitability | 10 | Effective limits, actual batch size/request count, cache permission and operating-cost estimate | Provider-dependent; no paid service was purchased |
| **Total** | **100** | Every criterion supported and its uncertainty explained | **Not scored** |

Unknown is not a score of zero. The JSON leaves unscored criteria and totals `null`; a total of zero would falsely imply that every criterion had been assessed numerically. OpenAIRE's zero measured coverage is a completed empirical finding, recorded separately from unscored freshness and measurement-window questions. A numeric score needs an explicit mapping from measured evidence to points, not an unexplained impression. The evidence includes population hashes, observation period and metric definition version, and should be revised after the next authorized experiment.

## Comparative assessment

| Candidate | Closest permitted label | Principal merit | Unresolved acceptance condition |
|---|---|---|---|
| ADS / SciX | ADS + arXiv accesses, rolling 90 days | Documented arXiv contribution | Token access, retention permission, per-category coverage and usable nonzero values |
| OpenAIRE | OpenAIRE views or OpenAIRE downloads | Separate metrics and documented reusable graph data | Current full census failed metric coverage: 0/2,555 Recent, 0/701 Today; window/freshness also unknown |
| Mendeley | Mendeley library saves | A defined human library action | OAuth access, indexing delay and coverage; counter is current membership |
| alphaXiv | alphaXiv views or votes | Direct platform activity | Exact raw metric contract and complete candidate lookups; key required |
| ArcXiv | ArcXiv reader activity, only if raw fields validated | Public paper API and a stated attention feed | Raw counts not established in documented paper contract |
| Emergent Mind | A named social metric | Separate counters in exact-paper responses | Quota, mathematical coverage and metric-window validation |
| Altmetric / PlumX | Named source-specific mentions, captures or usage | Multiple documented attention families | Licensed access and retention/display scope; no mixed popularity sum |
| MathOverflow / Bluesky / SciRate / Hugging Face | Platform-specific mentions or votes | Inspectable activity rather than inferred prestige | Completeness and field bias; these do not establish paper readership |
| Semantic Scholar / OpenAlex | Citation count | Exact scholarly attention event with bibliographic infrastructure | New-paper discrimination and coverage; never call it downloads or readers |
| Zenodo / repository counts | Named repository's views/downloads | Usage events for deposited records | Match the paper rather than associated data; characterize repository coverage |
| Crossref Event Data | Historical mentions only | Historical archive exists | Retired; cannot be a current source |
| Scholar Feed / personal ranking tools | Their own recommendation or impact score | Discovery and research navigation | Metric semantics fail the readership requirement |

These assessments are research judgments grounded in the linked source inventory. They are not experimental coverage rankings. In particular, the table order must not be used to select a source automatically.

## Completed OpenAIRE census

The complete frozen Today and Recent populations were queried from **2026-11-26 23:41:27.990 UTC to 23:42:36.712 UTC**. Their union contained **2,783 distinct identifiers**; overlapping identifiers were queried once and reported against each original denominator. All **56 census requests returned HTTP 200**. With three earlier diagnostics, the session used **59 of the documented 60 anonymous requests/hour**. The effective batch limit was 50 OR-separated arXiv identifiers; a rejected 100-ID diagnostic is included in that budget. No requests were retried and no credentials were used.

Evidence: [coverage JSON](../../research/trending/coverage-results.json), [per-paper CSV](../../research/trending/coverage-results.csv), [normalized observations](../../research/trending/observations.json), [Recent freeze](../../research/trending/populations/recent.json), [Today freeze](../../research/trending/populations/today.json), and the raw responses listed with SHA-256 hashes in the coverage JSON. Final source parsing used the production JavaScript parser in Chromium. The archived population-validation note records the exact equivalence check and offline reanalysis.

| Population | Eligible | Exact matches | Match rate | Valid views | Valid downloads | Positive metrics | Unresolved |
|---|---:|---:|---:|---:|---:|---:|---:|
| Recent | 2,555 | 6 | 0.235% | 0 | 0 | 0 | 0 |
| Today | 701 | 179 | 25.535% | 0 | 0 | 0 | 0 |

Every exact match omitted both usage fields. There were **zero genuinely measured zeros**, zero measured positives and zero untested or failed-request outcomes. Thus metric coverage is 0%, while underlying reader activity remains unknown. The conditional measured fraction is 0/6 for Recent and 0/179 for Today; a positive/measured ratio is undefined because its denominator is zero. These exact census rates describe the frozen identifiers and this query period, not all future mathematics cohorts.

### Why Today matches more often

Today includes new submissions, cross-submissions and replacements. Replacements can refer to papers first submitted months or years earlier. Its higher metadata match rate is dominated by those older records, so it does not demonstrate faster indexing of newly submitted mathematics. Recent did not label submission type in its source HTML; all 2,555 rows retain `unknown` rather than inventing a classification.

| Today section | Eligible | Exact matches | Match rate | Measured views/downloads |
|---|---:|---:|---:|---:|
| new | 379 | 0 | 0.000% | 0 / 0 |
| cross | 61 | 1 | 1.639% | 0 / 0 |
| replacement | 261 | 178 | 68.199% | 0 / 0 |

### Recent announcement cohorts

| Announcement date | Eligible | Exact matches | Views measured | Downloads measured |
|---|---:|---:|---:|---:|
| 2026-11-26 | 441 | 1 | 0 | 0 |
| 2026-11-25 | 489 | 2 | 0 | 0 |
| 2026-11-24 | 869 | 2 | 0 | 0 |
| 2026-11-23 | 352 | 0 | 0 | 0 |
| 2026-11-20 | 404 | 1 | 0 | 0 |

Announcement-date age was 0, 1, 2, 3 or 6 calendar days at observation. It is not elapsed time since original submission or first online appearance. No exact indexing latency, first-positive time or growth rate was measured.

### Coverage across all 32 mathematics categories

Category rows include cross-list memberships and therefore overlap. All categories were represented in both populations. Views and downloads were unavailable for every category, including the categories with metadata matches.

| Category | Recent eligible | Recent matches | Today eligible | Today matches | Available usage metrics in either population |
|---|---:|---:|---:|---:|---:|
| math.AC | 46 | 1 | 9 | 4 | 0 |
| math.AG | 180 | 0 | 60 | 19 | 0 |
| math.AP | 334 | 2 | 79 | 10 | 0 |
| math.AT | 41 | 1 | 16 | 8 | 0 |
| math.CA | 54 | 0 | 9 | 3 | 0 |
| math.CO | 353 | 1 | 83 | 19 | 0 |
| math.CT | 17 | 0 | 11 | 4 | 0 |
| math.CV | 65 | 0 | 15 | 2 | 0 |
| math.DG | 163 | 0 | 45 | 8 | 0 |
| math.DS | 141 | 0 | 46 | 8 | 0 |
| math.FA | 126 | 0 | 40 | 7 | 0 |
| math.GM | 22 | 0 | 8 | 1 | 0 |
| math.GN | 17 | 1 | 2 | 0 | 0 |
| math.GR | 76 | 0 | 28 | 7 | 0 |
| math.GT | 59 | 0 | 16 | 4 | 0 |
| math.HO | 13 | 0 | 1 | 1 | 0 |
| math.IT | 123 | 0 | 35 | 9 | 0 |
| math.KT | 14 | 0 | 5 | 3 | 0 |
| math.LO | 44 | 0 | 17 | 8 | 0 |
| math.MG | 48 | 0 | 13 | 5 | 0 |
| math.MP | 263 | 3 | 76 | 22 | 0 |
| math.NA | 189 | 0 | 48 | 13 | 0 |
| math.NT | 207 | 0 | 47 | 10 | 0 |
| math.OA | 43 | 0 | 13 | 2 | 0 |
| math.OC | 229 | 1 | 61 | 18 | 0 |
| math.PR | 223 | 0 | 59 | 14 | 0 |
| math.QA | 39 | 0 | 15 | 8 | 0 |
| math.RA | 67 | 0 | 14 | 4 | 0 |
| math.RT | 77 | 0 | 20 | 3 | 0 |
| math.SG | 18 | 0 | 4 | 3 | 0 |
| math.SP | 52 | 0 | 11 | 0 | 0 |
| math.ST | 102 | 0 | 34 | 13 | 0 |

### Population integrity

- Recent frozen at `2026-11-26T23:33:54.746305+00:00`; archived JSON SHA-256: `0847fea85df6aa67e3d4a5b5265bb4b1a492c84bc823d9dc4cb736a522530773`.
- Today frozen at `2026-11-26T23:37:45.314388+00:00`; archived JSON SHA-256: `c060db9f5e99f18039707ece3268e2d03118e717339af49c1548e9283fad19e9`.

The result rules out OpenAIRE as a usable default for this snapshot. It does not establish that ADS, Mendeley or another authorized service has better coverage; those populations were not successfully measured. It also does not establish that OpenAIRE lacks usage data for all papers or that these records had no real readers.

## Bounded endpoint observations

One preflight lookup used `2611.33166` on 2026-11-26 at approximately 23:31:10 UTC. It was a connectivity/contract probe, **not a random coverage sample**. The [recorded probe evidence](../../research/trending/provider-probes.json) separates these results from population experiments.

| Provider | Actual response | Interpretation |
|---|---|---|
| OpenAIRE | HTTP 200; zero matches | This exact query did not find that identifier at that time; no population inference |
| ArcXiv | HTTP 200; exact identifier, no readership count | Metadata matched; its assessment fields are not observed reads |
| ADS | HTTP 401; missing authorization | Access failure; indexing and metric availability unresolved |
| Mendeley | HTTP 401; no authentication header | Access failure; indexing and metric availability unresolved |
| Semantic Scholar | HTTP 429 | Rate limit; indexing and citation count unresolved |

The OpenAIRE response advertised a larger rate-limit header than its general anonymous-access documentation. The experiment must obey the conservative documented request budget unless the provider clarifies the applicable policy; an unexpectedly permissive header is not permission to flood the service.

## Coverage interpretation

For each provider and metric, report these fractions independently, with integer numerators and denominators:

- **Indexing:** unambiguously matched papers / eligible papers.
- **Metric coverage:** papers with a valid measurement, including zero / eligible papers.
- **Positive coverage:** papers with a strictly positive measurement / eligible papers.
- **Conditional metric coverage:** measured papers / matched papers.
- **Conditional positive coverage:** positive papers / measured papers.

If the denominator is zero, the ratio is unavailable. Keep unresolved and untested counts beside every table. The same breakdown must be available by announcement date, age cohort, mathematics category and submission type. Cross-listed category rows overlap and must not be summed to recover the distinct total.

The requested threshold vocabulary is: excellent at 90% or above, good at 75%, limited at 50%, poor at 25%, and inadequate below 25%. Apply those thresholds to verified **metric coverage**, not metadata coverage. They are descriptive bands, not automatic proof that a ranking is meaningful. An all-zero or identical-value population fails discrimination regardless of coverage.

## Failure and sample interpretation

A transport error establishes only a failed attempt. An authentication error establishes only missing/invalid authorization. Neither establishes that a paper is unindexed. Do not multiply a single failed endpoint probe into thousands of supposed paper-specific results.

If a full population cannot be queried within the allowed budget, select a reproducible stratified sample covering available categories and announcement dates. Report the sample size, eligible total, seed, inclusion procedure and uncertainty. A nonrandom demonstration of a popular paper is not a coverage sample. If the source population itself is incomplete, report coverage only for the observed subset and leave whole-Recent coverage unknown.

## Cost and cadence decision

No subscription or hosted collector is required for the local feeds. External metrics are opt-in. Estimate a proposed collection run from `ceil(candidate_count / effective_batch_size)`, pagination, cold-cache requests and expected retries; do not assume a provider's advertised maximum batch always resolves that many candidates. Multiply only by the intended schedule after permissions, quotas and observed update frequency are known.

For a source that permits retention, one manually executed run produces a dated snapshot; repeated runs can form a time series. Scheduling is a separate explicit operation. A userscript cannot guarantee collection while the browser is closed. No scheduled job, paid service or background deployment is claimed by this documentation.
