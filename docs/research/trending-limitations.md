# Trending feasibility, limitations and pending evidence

Review date: **2026-11-26**. This document separates source facts, implementation policy and measurements still needed. Source references are collected in [trending-data-sources.md](trending-data-sources.md); evaluation state is in [provider-evaluations.json](provider-evaluations.json).

## Questions answered by this investigation

| Question | Supported conclusion |
|---|---|
| Are actual per-paper arXiv PDF download counts publicly accessible? | No public official mechanism was established; arXiv's [FAQ](https://info.arxiv.org/help/faq/statfaq.html) declines to provide individual-paper statistics. |
| What are the closest legitimate alternatives? | ADS/SciX aggregate accesses, OpenAIRE contributed views/downloads and Mendeley library saves. They measure different activities and require separate labels. |
| What fraction of Today and Recent is indexed? | OpenAIRE returned exact matches for 179/701 Today (25.535%) and 6/2,555 Recent (0.235%) in the completed census. Other providers remain unknown. These are query-match rates at the recorded time. |
| What fraction has metrics or positive metrics? | OpenAIRE view and download coverage were both 0/701 Today and 0/2,555 Recent. Matched records omitted both metrics; these are unavailable values, not genuine zeros. Other providers remain unknown. |
| How does coverage vary across categories and dates? | The OpenAIRE census covers all 32 mathematics categories and five Recent announcement dates; every category/date cohort had zero available metrics. Today matches were dominated by replacements (178/179). Detailed tables are in the comparison report and archived coverage output. |
| How quickly do useful measurements arrive? | No longitudinal cohort results were established. Metadata update policies do not establish first metric availability or positive activity. |
| Which provider has the strongest empirically supported coverage? | None has passed the complete-population selection gate. Research priority and demonstrated coverage are distinct. |
| Is Trending feasible? | The ranking and failure-handling architecture is feasible; a meaningful live readership ranking remains conditional on authorized, sufficiently complete and informative observations. |
| Is Rising feasible? | Only with comparable historical measurements of a verified cumulative counter, with corrections/resets accounted for. No live counter was validated for that role in this review. |
| What infrastructure is needed? | On-demand local collection is sufficient for a single snapshot. Reliable periodic collection needs an explicitly configured scheduler and a source whose retention terms allow it. |
| What are expected operating costs? | No paid infrastructure is necessary for local feeds. A supported provider's actual request budget and any licence must be evaluated before proposing a paid deployment. |

## Candidate population must remain authoritative

Today is the latest `/list/math/new` announcement. Recent is the complete `/list/math/recent` result set. A wall-clock seven-day query, provider publication date, or search engine's indexed page cannot replace either population. Replacements can concern older papers; their announcement age and original-publication age differ. Do not pretend a replacement's old accumulated count measures activity since the latest announcement.

An uploaded HTML capture may contain only the first page. Its file size does not establish completeness. Capture pagination, advertised totals, date headings, normalized IDs and a retrieval timestamp. A successful parser run on an attachment is a fixture result, not proof of a successful live fetch. Cached snapshots must be labelled with their actual observation times.

## Important source-specific boundaries

- **ADS/SciX:** a rolling 90-day total combines activities and cannot isolate arXiv PDF downloads. Source [terms](https://adsabs.github.io/scixhelp/policies-scix/terms) also restrict redistribution and require contact before regular archival. Do not publish a cached raw dataset on the strength of possessing a token.
- **OpenAIRE:** participating repositories contribute usage. Graph field names alone do not establish the time window, freshness or coverage of the arXiv copies. Unknown windows block exact velocity.
- **Mendeley:** saving a record is observable interest, not demonstrated reading; current library membership can be corrected or removed.
- **Views, saves, mentions and citations:** no justified conversion factor turns one into another. Their audience populations can overlap, so adding them can double-count activity.
- **Platform-selected feeds:** a top-50 or top-200 endpoint omits the rest of the population. The omission cannot be interpreted as a measured zero, and the returned rank cannot establish the application's full Recent denominator.

## Ranking safeguards

Every eligible paper should retain an explicit outcome: unambiguous match with positive metric, genuine zero, missing metric, no match, ambiguous match, auth failure, rate limit, network failure or untested. Only validated available measurements participate in a ranking. A value without provenance/window metadata is not interchangeable with another snapshot of a similarly named field.

Trending should use one explicitly chosen source/metric, remain independent of personal feedback, and show its coverage and timestamps. Equal measurements are ties; a deterministic identifier tie-break is for reproducible display and should not imply greater popularity. A same-announcement-date filter can make age comparisons clearer, but its denominator is that labelled subset. Avoid inventing a per-day velocity by dividing a cumulative or rolling counter by paper age.

If the data-quality gate fails, show **“Insufficient readership data to establish a meaningful trending ranking.”** Give the observed cause: missing access, failed retrieval, partial population, stale/unknown freshness, inadequate coverage or too little discriminatory activity. Do not fill the empty state with recommendations under a Trending label.

For Rising, comparable observations require the same normalized paper, provider, metric, definition version and window semantics. Reject nonpositive time intervals, negative/corrected differences, resets, stale pairs and unsupported rolling/current-membership counters. Unit tests using synthetic cumulative counters demonstrate the algorithm; they do not validate any real service's metric.

## Longitudinal work still needed

Freeze a complete announcement cohort, then repeat authorized observations near announcement and approximately 1, 3, 6, 12, 24, 48, 72 hours and seven days later where the source cadence and quota permit. Record four distinct milestones: first index match, first metric field, first positive value and subsequent changes. A cross-sectional comparison of older/newer papers cannot measure those waiting times.

Failures leave gaps in the time series. Preserve the gap and source error; do not interpolate invented reads. Deduplicate unchanged observations where permitted, set a retention policy, and record timezone-aware timestamps. Do not claim that these future observations have already occurred or install a schedule merely because this design describes one.

## Remaining biases and uncertainty

Coverage bias can favor fields whose authors use a platform, countries/languages with greater platform participation, papers with matched DOIs, older/replacement records and communities accustomed to public sharing. Bot filtering and repeated-user filtering differ by provider. A popular paper is not necessarily correct, accessible, important or useful to this reader. These are reasons to preserve separate Trending, Highlights, Discovery and personalized feeds.

The completed [OpenAIRE census](../../research/trending/coverage-results.json) establishes that this accessible source did not supply usable metrics for these frozen populations. The decisive next evidence is a successful authorized coverage run for another candidate over the **complete Recent population**, followed by repeated measurements where allowed. This one-provider, one-time negative result does not prove that a legitimate provider can never support the feature.
