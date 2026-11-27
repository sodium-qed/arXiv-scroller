# Readership and attention sources

Documentation reviewed on **2026-11-26**. This source investigation is complemented by the [completed OpenAIRE census](../../research/trending/coverage-results.json). Documentation and measurements are distinguished throughout: a provider's documentation alone cannot establish how many current mathematics identifiers it covers.

## Finding and implementation decision

No source has demonstrated sufficient **measured Recent-population readership coverage** for automatic selection as the default Trending provider. The completed OpenAIRE census found exact matches for **6 of 2,555 Recent papers** and **179 of 701 Today papers**, but **no view or download measurement for any matched paper**. Missing fields are not measured zeros. Retain an explicit insufficient-data state until an authorized experiment meets the data-quality gates. Today and the other local feeds do not depend on an external metric service.

Two candidates received priority investigation:

1. **ADS / SciX** has the closest documented aggregate to arXiv readership. Its credential and retention/redistribution conditions must be satisfied before a sustained collection or public dataset is enabled.
2. **OpenAIRE UsageCounts through the Graph API** has separable view/download fields, anonymous access and documented reuse rights. Its measured coverage was insufficient in the frozen current cohorts; its measurement windows also remain unverified.

This ordering is a research priority, not a claim that either provider passed the ranking gate. ADS and Mendeley remain blocked by authentication in this environment; their population coverage is unknown. The [comparison report](provider-comparison.md) records the full census, category/date tables and request budget.

## 1. Official arXiv services

arXiv's [public-statistics FAQ](https://info.arxiv.org/help/faq/statfaq.html) declines to publish individual-paper download/readership statistics because the numbers may be misleading. The [support article](https://arxiv-org.atlassian.net/wiki/spaces/AUS/pages/418971649/Paper+statistics) states directly that paper-level download statistics are not provided. The official metadata API and bulk services provide bibliographic/full-text access, not an established article-level readership counter: [bulk access](https://info.arxiv.org/help/bulk_data.html).

**Conclusion:** no legitimate public endpoint for actual per-paper arXiv PDF download counts was established. This does not mean arXiv possesses no internal logs; it means those logs are not an available application data source. Do not infer usage from PDF file size, identifier order, publication volume or local clicks.

## 2. ADS / NASA SciX

### Metric meaning

The current [SciX field reference](https://adsabs.github.io/scixhelp/search-scix/comprehensive-solr-term-list) defines `read_count` as aggregate ADS/arXiv accesses over a **rolling 90-day** window. The [ADS results guide](https://adsabs.github.io/help/actions/) explains that recent access statistics include full-text downloads and arXiv reads/downloads. The exposed total does not separate abstract views from PDF requests. It must not be labelled unique people or actual arXiv PDF downloads.

`reader` is a different field, and is not retrievable according to the field reference. `update_timestamp` is a record reindexing timestamp; it does not establish the freshness of each constituent usage event. The exact metric update frequency and the coverage of pure mathematics remain unknown.

### Identity, access and operations

[SciX API documentation](https://adsabs.github.io/scixhelp/api-scix/) states that SciX uses the ADS API and requires an API token for developer access. The [search reference](https://adsabs.github.io/help/search/) supports identifier searches and Boolean queries, allowing bounded batches of normalized arXiv IDs. Query only the frozen candidate list and validate returned identifiers, including merged publication records.

The [rate policy](https://adsabs.github.io/help/policies/rate-limits) documents 5,000 regular requests per day for most request types, subject to endpoint/token limits. The [update policy](https://adsabs.github.io/help/policies/update) describes daily arXiv ingestion, which is not an hourly readership freshness guarantee or a promise that all 32 mathematics categories are represented.

### Retention and sharing

Both [ADS terms](https://adsabs.github.io/help/terms/) and [SciX terms](https://adsabs.github.io/scixhelp/policies-scix/terms) prohibit third-party redistribution and direct developers to contact the service before regularly downloading and storing returned data. An API token alone does not resolve those conditions. No public raw ADS archive, shared service cache or automatic persistent ADS collection is justified by this review. A future authorized integration should record the permission scope separately from credentials and keep private data out of Git.

**Rising:** changes in `read_count` are changes in a rolling total, not exact counts of newly observed reads. Do not enable a readership-velocity label from that subtraction.

## 3. Mendeley

The [catalog API](https://dev.mendeley.com/methods) defines `reader_count` as users who have a document in their library; the demographic fields group those library users, and `group_count` counts groups containing the document. These are **saves**, not proof of reading. [Core resources](https://dev.mendeley.com/overview/core_resources.html) document arXiv identifiers and OAuth client-credentials access to public catalog data. A lookup has the form `GET /catalog?arxiv=ID&view=stats`.

The reviewed documentation does not establish comprehensive recent-mathematics coverage, a maximum indexing delay, metric update frequency, or a stable general batch quota. Missing fields remain unavailable; a documented numeric zero remains zero. A current library-membership count can decrease and must not be treated as a monotone total. Review [Mendeley terms](https://www.elsevier.com/legal/elsevier-mendeley-terms-and-conditions) before a shared integration.

## 4. OpenAIRE UsageCounts

[UsageCounts](https://usagecounts.openaire.eu/) aggregates usage contributed by participating repositories and publishers. It does not assert that every arXiv access is included. The [Graph data model](https://graph.openaire.eu/docs/data-model/entities/other/) exposes separate `usageCounts.views` and `usageCounts.downloads` values. [SUSHI reports](https://usagecounts.openaire.eu/resources) can describe monthly usage; this does not prove that the Graph fields are cumulative or that they share a known observation interval.

The current [v4 query guide](https://graph.openaire.eu/docs/apis/graph-api-v4/quickstart/) and [filter reference](https://graph.openaire.eu/docs/apis/graph-api/filter-based-queries/research-products/filter-syntax/) support arXiv-ID filters and OR lists, for example `filter=ids.arxiv:ID1|ID2`. Follow result pagination and check exact identities. The [API terms](https://graph.openaire.eu/docs/apis/terms/) allow anonymous access at up to 60 requests/hour, authenticated access at up to 7,200/hour, and CC-BY reuse with attribution. Treat stricter response limits as authoritative.

**Measured:** the 2026-11-26 census queried all **2,783 distinct identifiers in the union** of frozen Today and Recent populations. All 56 census requests returned HTTP 200. The effective OR-list limit was 50 identifiers, established by an earlier rejected 100-ID diagnostic; the complete session used 59 requests including three diagnostics, within the documented 60/hour anonymous allowance. Both view and download metric coverage were **0/2,555 Recent** and **0/701 Today**. The absence of fields does not establish zero activity. See the [machine-readable report](../../research/trending/coverage-results.json) and [raw responses](../../research/trending/provider-responses/001.json).

**Pending:** the metric values and their distribution, update delay, contributing repositories, overlap with other counters and the precise metric window. No latency or Rising velocity can be inferred from this single cross-sectional census. Today includes replacements of older papers; 178 of its 179 matches were in that replacement section.

## 5. Other investigated services

| Service | Evidence and available signal | Decision for this project |
|---|---|---|
| **alphaXiv** | [MCP documentation](https://www.alphaxiv.org/docs/mcp) exposes paper views/votes in some research results. OAuth or an API key is required; cross-origin browser requests are unsupported. Its Hot feed is a capped provider-selected feed, not a complete Recent denominator. | Candidate third-party views, pending exact-ID coverage, metric definition, permission and complete lookup validation. Do not substitute its Hot feed for arXiv Recent. |
| **ArcXiv** | [Trending page](https://arcxiv.org/feed/trending) describes views/saves. [Agent API](https://arcxiv.org/docs/agents) documents public paper records, citations and research-assessment signals, with 300 requests/five minutes/IP and a request to contact the operator before sustained bulk use. | No documented raw readership fields established. AI impact/significance fields are inadmissible popularity substitutes. A public page with no qualifying activity is not a zero for every paper. |
| **Emergent Mind** | [API documentation](https://www.emergentmind.com/docs/api) provides exact-paper lookup and separate social/citation counters. API keys are required; Free allows 50 calls/month. Trending returns at most 50 results. | Possible social-attention source. Individual metrics must retain their names; the capped trending endpoint cannot measure whole-population coverage. No account, paid plan or automatic batch was provisioned. |
| **Semantic Scholar** | [Academic Graph API](https://api.semanticscholar.org/api-docs/graphs) accepts `ARXIV:` IDs and batches up to 500 papers. Its documented paper counters include citations. [API license](https://api.semanticscholar.org/license/) governs use. | Useful identity/citation comparison; citation availability is not readership coverage. A cited-paper alternative must be explicitly labelled. |
| **OpenAlex** | [Work attributes](https://help.openalex.org/data/works/attributes/) define `cited_by_count` as matched citing works. [API reference](https://help.openalex.org/api/) documents public queries and optional API keys/budgets. | Bibliographic/citation alternative. No direct readership field established; author impact and rank scores are excluded. |
| **Altmetric** | [Current API access guide](https://help.altmetric.com/en/articles/9806401) requires API keys, with access scope and public display governed by the granted plan/contract. It supplies attention information. | Potential mentions source after authorized access and matching tests. Do not assume older unauthenticated API examples still work. |
| **PlumX** | [API reference](https://dev.elsevier.com/documentation/PlumXMetricsAPI.wadl) requires active Scopus subscription access. [Metric definitions](https://www.elsevier.com/insights/metrics/plumx) distinguish usage, captures, mentions, social media and citations. | Keep per-source metrics separate. No verified recent-mathematics coverage or authorized subscription was established. |
| **Crossref** | [Official retirement notice](https://www.crossref.org/blog/strengthening-support-for-data-citations-and-saying-goodbye-to-event-data/) says Event Data ended on April 23, 2026. Its replacement concerns deposited data citations. | Exclude retired Event Data from live attention collection. Historical event archives cannot rank the current announcement population. |
| **MathOverflow** | [Site search help](https://mathoverflow.net/help/searching) supports URL searches. [Stack Exchange advanced search](https://api.stackexchange.com/docs/advanced-search) supports URL criteria for question search. | Can identify observed scholarly discussions. Search hits are not paper readership; question-search coverage cannot be asserted to include every answer/comment mention. |
| **Bluesky** | [Official search implementation](https://github.com/bluesky-social/atproto/blob/main/packages/bsky/src/api/app/bsky/feed/searchPosts.ts) exposes URL/domain and date filtering, with implementation-dependent authentication. | A potential social-mention stream. Need complete paging, alias handling and query-coverage validation; no match is not proof of no attention across the web. |
| **SciRate** | [About](https://scirate.com/about) and [source repository](https://github.com/scirate/scirate) describe community votes/comments; ingestion can lag arXiv. [User data licence](https://scirate.com/legal) is CC BY-SA 4.0. | Legitimate platform votes, not reads. No current stable bulk API contract established. License compatibility and automated-access policy need verification before collection. |
| **Zenodo / institutional repositories** | [Zenodo usage definitions](https://zenodo.org/help/statistics) distinguish record views, file downloads and hourly unique events; statistics update daily. | Real repository usage only for exactly matched deposited copies. File bundles, versions and non-paper records create identity/denominator risks. No full mathematics coverage established. |
| **Hugging Face Papers** | [Official client documentation](https://huggingface.co/docs/huggingface_hub/main/en/package_reference/hf_api) and [CLI implementation](https://github.com/huggingface/huggingface_hub/blob/main/src/huggingface_hub/cli/papers.py) expose paper information/upvotes. | Platform voting is a possible attention measure; a curated daily feed is not the complete mathematics population. No coverage claim made. |
| **Scholar Feed** | [API documentation](https://www.scholarfeed.org/developers/api) describes CS/AI/ML data, novelty scoring and citation information; its trending score blends rank and citation velocity. | Provider-specific relevance/impact rankings do not meet the requested readership semantics. Do not relabel them as observed reads. |
| **papers.cool and keyword-ranking projects** | [papers.cool project](https://github.com/bojone/papers.cool) describes paper discovery and AI reading; [arXiv Digest](https://isaac-tes.github.io/arxiv-digest/) ranks against personal keywords/authors. | Useful interface precedents, not demonstrated public readership counters. No undocumented private analytics were queried. |

## Reproducibility and evidence scope

The sources above are primary operator documentation, schemas or source code. The documentation sweep identifies candidate contracts and limitations. It does not turn authentication failures, rate limits, network failures or untested papers into failed indexing matches.

The machine-readable [provider evaluations](provider-evaluations.json) retain unknown empirical fields as `null`. See [provider comparison](provider-comparison.md) for the decision rubric and [limitations](trending-limitations.md) for the outstanding observations. Keep real experiment output separate from synthetic regression fixtures.
