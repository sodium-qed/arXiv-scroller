# Reproducing the readership experiment

The archived run queried every distinct ID in the complete Recent and Today populations on **2026-11-26**, using exact OpenAIRE Graph identifiers. The collector made **56 successful HTTP 200 requests** over the **2,783 distinct IDs** in their union. Recent contained 2,555 papers and Today contained 701; 473 occurred in both populations. Three earlier connectivity/schema probes bring this session's OpenAIRE total to **59 requests**, within the documented anonymous limit of 60/hour. [OpenAIRE API terms](https://graph.openaire.eu/docs/apis/terms/)

Recent indexing was **6 / 2,555 = 0.2348%**; Today indexing was **179 / 701 = 25.5350%**. Neither `views` nor `downloads` was present for any matched record. Consequently, metric coverage and positive-activity coverage are **0 / 2,555** and **0 / 701**, respectively. These are counts of available measurements, not assertions that readership itself was zero. No census query was unresolved. The Today total includes older replacements; that explains why its metadata indexing percentage must not be interpreted as same-day indexing latency. [Recorded reports](../../research/trending/coverage-results.json)

## Files and provenance

| Artifact | Contents |
|---|---|
| `research/trending/populations/recent.json` and `today.json` | Frozen complete populations with production-parser output, dates, distinct identifiers, source hashes and retrieval times |
| Population `*-manifest.json` and referenced gzip directories | Exact source HTML for offline parser replay |
| `research/trending/coverage-results.json` | Experiment period, denominator hashes, request ledger, five coverage fractions, category/date/age/submission-type breakdowns and conservative unresolved bounds |
| `research/trending/observations.json` | Importable normalized snapshot; one record per provider, metric and queried paper |
| `research/trending/coverage-results.csv` | Paper-level tabular measurements with both population memberships preserved |
| `research/trending/provider-responses/*.json` | Exact public OpenAIRE response bytes; hashes and actual batch query URLs are in the report |
| `research/trending/provider-probes.json` | Separate nonrandom connectivity probes; not a coverage sample |

`sourceUrl` on an observation is a direct one-paper lookup link. The actual batched request, IDs, response hash and retrieval timestamp are recorded in the report. Observation time records receipt of the response. A paper's bibliographic update date is never substituted for a usage counter's update time.

OpenAIRE data are retained with attribution under its documented CC-BY API terms. The arXiv source pages retain their own notices. This archive contains public paper metadata and public provider results; no credentials, feedback history, private notes, subscriptions or reading history are included. ADS data are not part of the archive.

## Replay the recorded experiment without network access

From the repository root, Node.js 20 or later can validate all raw response hashes, reapply the exact-identifier adapters, recalculate every coverage table and rerun the ranking gates:

```sh
node scripts/replay-readership-experiment.mjs
```

The expected result is `verified: true`, 56 requests, 2,783 queried IDs, the counts above, and unavailable Trending/Rising rankings. This checks an archived observation; it does not assert that a provider's live state never changes.

To replay the original arXiv HTML through the production parser, install Python Playwright and Chromium as described in the existing test documentation, then run:

```sh
python scripts/freeze-readership-population.py --population recent --replay-manifest research/trending/populations/recent-manifest.json --output /tmp/replayed-recent.json
python scripts/freeze-readership-population.py --population today --replay-manifest research/trending/populations/today-manifest.json --output /tmp/replayed-today.json
```

Set `CHROMIUM_BIN` when Chromium is installed at a custom path. These commands perform no external requests. They revalidate complete pagination, dates, order, identity normalization and advertised totals.

## Collect a new observation

First freeze the authoritative populations; neither command substitutes a calendar window for arXiv's announcement cycle:

```sh
python scripts/freeze-readership-population.py --population recent --output /tmp/recent.json
python scripts/freeze-readership-population.py --population today --output /tmp/today.json
```

Then run one provider at a time, reusing overlapping paper IDs:

```sh
node scripts/measure-indexing-coverage.mjs --population-json /tmp/recent.json --population-json /tmp/today.json --provider openaire --max-requests 60 --output /tmp/readership-run
```

The OpenAIRE batch limit was empirically verified as **50 IDs per OR filter**. A 100-ID query returned HTTP 400 with the explicit limit; it is retained as a failed schema probe rather than 100 unindexed papers. The collector validates actual pagination page numbers, advertised totals and repeated records. It stops on authentication, rate-limit, malformed-response or network failures, and leaves the remaining IDs untested.

The default budget is 50 requests; `--max-requests` can lower it. Anonymous OpenAIRE runs cannot request more than 60, and a local hourly ledger at the system temporary directory prevents repeated collector runs from silently exceeding that limit. `--rate-state FILE` selects a shared ledger location. Record any separate manual probes in the same ledger and run only one collector at a time; the file is not a distributed lock. A `Retry-After` response ends the current run; do not immediately rerun it. With a corporate HTTP proxy on Node.js 24, the optional `--use-env-proxy` runtime flag may be needed. The archive records that flag for this environment, not as a browser requirement.

## Sampling and uncertainty

The default is a census. If request limits make that impractical, `--sample-size N --seed TEXT` selects a reproducible stratified sample separately for each principal population, then reuses duplicate IDs across the samples. Each stratum combines primary category, the complete category set and announcement date. A nonempty stratum receives at least one paper, which retains both primary and secondary mathematical-category coverage. Remaining slots follow proportional deficits; paper priorities use SHA-256 of the recorded seed and identifier, without provider information.

The sampler requires at least 100 papers per population where feasible and refuses a size too small to represent every stratum. It records population/sample sizes and inclusion probabilities per stratum. Overlapping-population reuse can add observations beyond an original sample. Therefore the report does not mislabel the combined observed ratio as an unbiased whole-population estimate. It reports exact observed lower bounds and upper bounds including unresolved cases; the original design permits an analyst to calculate design-based estimates and sampling uncertainty separately. No sampling uncertainty applies to the archived complete census.

`--category math.NT` measures a clearly identified category subset of the frozen official population. It does not redefine the arXiv publication window or establish all-mathematics coverage. Do not import a category-only experiment as evidence that unqueried categories are covered.

## Other providers and credentials

Supported CLI adapters are `openaire`, `ads`, `mendeley`, `semantic-scholar` and `arcxiv`. Their normalized metrics remain distinct: OpenAIRE network views/downloads, ADS rolling 90-day combined accesses, Mendeley library saves, and citations. ArcXiv AI quality fields are never imported as popularity. Credentials are read only from the applicable process variable:

| Provider | Variable |
|---|---|
| OpenAIRE | `OPENAIRE_TOKEN` |
| ADS / SciX | `ADS_API_TOKEN` |
| Mendeley | `MENDELEY_TOKEN` |
| Semantic Scholar | `SEMANTIC_SCHOLAR_API_KEY` |

Missing credentials can establish an authentication failure only; they cannot establish indexing or coverage. A key does not by itself authorize ongoing retention or redistribution. In particular, the ADS adapter refuses authenticated collection unless `--allow-provider-storage` is provided after the operator obtains the necessary provider permission. Do not publicly commit ADS output under that flag. The browser rejects restricted ADS imports. Review each provider's [documented terms and metric semantics](trending-data-sources.md) before using the optional adapters.

## Historical snapshots

For a provider permitting storage, a one-shot collector can append to an explicitly chosen local history:

```sh
node scripts/collect-readership-snapshots.mjs --population-json /tmp/recent.json --provider openaire --output /tmp/readership-run --history /tmp/readership-history.json
```

The history is separate from personal feedback and retains up to 50,000 deduplicated observations from the last 30 days. Conflicting simultaneous observations remain distinguishable and are marked ambiguous by the ranking resolver. Updates use a temporary file and rename. Repeated execution is an operator action; no scheduler, paid host or automated account was provisioned. A userscript cannot collect while the browser is closed.

Repeated observations alone do not make a counter cumulative. Current investigated readership definitions are rolling, stock or unknown-window metrics, so Rising remains unavailable. The pure cumulative-difference calculation is regression-tested using explicitly synthetic data for a future documented provider; no synthetic values enter the delivered experiment. Exact indexing latency, metric onset and update frequency still require repeated observations of the same frozen cohort at actual elapsed times.

## Regression checks

```sh
node --test tests/readership.test.js
```

These tests use labelled synthetic inputs to exercise missing versus zero values, identity ambiguity, category gaps, publication-age disclosure, stale timestamps, contradictory observations, ties, provider independence, unsupported rolling-window growth, counter resets, history bounds, rate-limit handling and incomplete provider pagination. The offline replay above separately checks the actual recorded replies.
