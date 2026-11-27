# Trending and Rising methodology

## Eligibility and denominators

The full official mathematics Recent listing is frozen before any provider result is examined. The population is determined by source rows and announcement cohorts, including every pagination page. Identifier normalization removes version suffixes while preserving separately observed versions. Duplicate source rows do not inflate the distinct-paper denominator. Today is frozen separately as a diagnostic population. Neither calendar arithmetic nor provider search results determine eligibility.

The recorded experiment contains 2,555 Recent and 701 Today papers. Its union contains 2,783 identifiers; each is looked up once per provider and reused across the two denominators. [Exact inputs, outputs and replay](experiment-running.md)

## Identity and availability

A successful match requires an exact normalized arXiv identifier in the provider response. Title similarity, author fame, an ambiguous hit or a provider-selected Hot list does not establish identity or complete coverage. Each metric remains a separate observation stream with provider, field, definition version, measurement window, observation time, provider update time when actually provided, and an availability outcome.

Coverage reports show five independent fractions: matched / eligible, measured / eligible, positive / eligible, measured / matched, and positive / measured. A genuine zero counts as measured. Missing values do not. Auth failures, rate limits, transport failures, ambiguity and untested papers remain unresolved instead of becoming not indexed. Each report includes category, date, announcement-age and source-type breakdowns, with unknown source types retained.

## Trending order

Only a complete verified Recent population can establish a ranking. The selected provider and metric define one stream; incompatible counts are never summed. Latest failed observations suppress previously successful values. Conflicting observations with identical timestamps become ambiguous. Observations outside Recent cannot enter the rank.

The default quality thresholds are 75% sufficiently recent observation coverage, five measured papers, three positive measurements, two distinct values and 25% observation coverage in every nonempty mathematical category. A known stale provider update also fails freshness checks. Unknown provider update time is explicitly disclosed and is not proof of recent underlying activity. A retrieval-age gate controls the age of the observation itself.

These thresholds are conservative product policy, not statistically estimated guarantees of a representative or unbiased ranking. The census supplies no usable readership values with which to calibrate them. Passing the gates would still require the reader to interpret provider coverage, metric meaning and publication-age bias; the gates only prevent several clearly inadequate ranking states.

Passing measurements are sorted by decreasing raw value. Equal values share competition ranks: `1, 1, 3`, for example. Normalized arXiv identifiers resolve the order within a tied group without pretending that one value is greater. The app keeps native arXiv rows in their existing order and exposes ranked navigation in its feed index and keyboard controls.

No paper-age correction or composite popularity formula was empirically justified. Announcement date and age are disclosed, with the explicit limitation that older papers may accumulate more activity. This ranking is independent of interests, knowledge, ratings, reading history, bookmarks and followed authors. Optional category/date/author/read/bookmark filters run afterward and retain the global ranks and full Recent coverage denominator.

If a gate fails, the result has no ranked entries and gives the observed reason. It never silently falls back to AI significance, author reputation, recommendations or random order under a Trending label.

## Rising order

A Rising adapter must first establish a documented genuinely cumulative readership counter. Current investigated readership counters are rolling, current membership or unknown-window values, so they do not satisfy this condition. The production registry deliberately keeps their Rising gate closed.

For a qualifying future counter, two exact-identity observations must share provider, field, definition version, counter epoch and cumulative-window start. Corrections, negative differences, resets, incomparable windows and invalid times are rejected. The supported observation interval is bounded (one to 168 hours by default). The candidate velocity is `(current - previous) / elapsed hours`; coverage, enough positive growth and discriminating values are still required. Ties follow the same deterministic shared-rank rule.

This pure calculation is tested with explicitly synthetic fixtures. Those fixtures are not research data. The current session contains no claimed longitudinal measurements, exact indexing latency or fabricated growth.

## Reproduction and current decision

Run `node scripts/replay-readership-experiment.mjs` to check every archived population and response hash, normalize the exact replies again, recompute all reported coverage tables and evaluate the ranking gates. The live OpenAIRE observations establish zero metric coverage for both populations. ADS/Mendeley authentication failures and the Semantic Scholar rate limit are documented separately, with no inferred coverage.

No automatic provider was selected. The functional ranking implementation remains available for lawful, sufficiently complete imported observations, while the delivered current-data state is unavailable. [Provider evidence and rubric](provider-comparison.md) · [Limitations and pending observations](trending-limitations.md)
