# Research feeds

Open **Feeds** beside **Settings** at the upper right. Choose a feed, then **Open selected feed**. The default landing preference is Today. Changing it applies when opening the mathematics new-listing page; abstract and full-text pages remain where the reader navigated. The Tampermonkey **Research feeds** menu provides the same controls.

## Source and behavior

| Feed | Population | Behavior |
|---|---|---|
| Today | Official `/list/math/new` announcement | Existing pinned daily selection, regeneration, replacement and category distribution. Random and Balanced retain `ceil(sqrt(N))` quotas; the newer adaptive-sampling decision takes precedence over the earlier one-paper-per-category brief. |
| Trending | Complete official `/list/math/recent` | One observed provider metric, with explicit quality gates and shared ranks for ties. No personal preference enters the ranking. |
| Rising | Complete Recent | Comparable cumulative-counter increases per elapsed hour, only after the metric definition and history support that interpretation. Current investigated providers do not qualify. |
| For You | Complete Recent | Existing local interest model, ranked by predicted relevance. With no usable feedback, a labelled category-balanced random fallback. |
| Discovery | Complete Recent | Existing novelty weights for prior topic, category and author-label encounters. Its strength is adjustable; unfamiliarity is not a dislike or a judgment of ability. |
| Subscriptions | Complete Recent | Existing stable author identities or deliberately confirmed name-only subscriptions. Entries indicate read/unread status. |
| Highlights | Complete Recent | Explicitly requested, source-grounded AI candidate assessments. Author claims and assessments remain unverified; an inconclusive assessment does not establish a highlight. |
| Random | Complete Recent | Adaptive category quotas by default, or an optional uniform global draw. Both ignore interests, subscriptions and external attention. |
| Recent | Complete Recent | Original chronological order and announcement-date cohorts. No personalization is applied. |
| Saved | Local bookmarks | All saved papers, including papers outside Recent, with search, filtering, ordering and BibTeX export. Original saved versions and rich metadata survive later sparse listings. |

Recent is the list arXiv publishes, not a rolling seven-day or thirty-day query. The parser records the dates and counts present in the source, follows pagination and deduplicates normalized identifiers. Where Recent omits submission-type labels, the type remains unknown. Known cross-submission and replacement switches cannot infer the type of an unknown row.

The original arXiv page remains the reading interface. On explicit feed selection, missing papers from later pages are added as safely constructed native-style identifier/description pairs. Original nodes, order, links and typography are retained. **Show all papers**, disabling tools or **Original arXiv** restores the original rows and removes fetched additions. Popularity ranks appear beside the paper; **Feed order** and **Alt+J / Alt+K** follow the ranked result while native rows retain their original order.

Saved displays the metadata captured when the bookmark was created, including its known version, abstract, comments and source links. If that version differs from a paper on the current page, Saved uses a removable row for the saved version. Returning to all papers restores the original live row and its controls. Legacy bookmarks acquire their snapshots before newer listing metadata is cached.

## Settings

**Feed settings** controls the landing feed, multiple mathematical categories, text/author search, announcement date within the source, read status, bookmark status and submission type. An empty category selection includes all 32 mathematics categories. The maximum displayed count is a presentation limit: zero shows every match, and it never changes the Today quota target or the full-population readership denominator.

Popularity filters apply after computing the unpersonalized ranks and quality assessment. A category filter can therefore begin at rank 12, for example. It cannot turn sparse all-mathematics coverage into adequate coverage. Saved can order its index by bookmark time, announcement date or title.

The source refresh interval is a cache lifetime checked when visiting a feed. A complete verified snapshot is reused while fresh, including across browser restarts. Expiry triggers a new first-page check and complete pagination. Source changes trigger native navigation to the new population instead of combining different announcements. Network failure can reuse a compatible cached snapshot with an explicit offline label; a stale population cannot establish a current Trending or Rising ranking. No collection runs while the browser is closed.

## Observed attention

No provider is selected automatically in this build. The complete live experiment established zero available view/download measurements for OpenAIRE in both frozen source populations. Other investigated providers had access, semantic, coverage or retention limitations. This does not say that the papers had no readers. [Source investigation](research/trending-data-sources.md) · [Census and raw evidence](research/experiment-running.md)

The browser imports the reproducible collector's JSON under **Feed settings → External observation files**. Select the corresponding provider/metric and save the settings. Import validates all observations before writing and preserves distinct outcomes for unindexed papers, missing metrics, genuine zeros, positive activity, ambiguity, authentication failures, rate limits, network failures and untested papers. Successful ADS observations are not archived by this browser build because a separate authorized storage integration is required.

The default Trending gates require at least 75% recently retrieved metric coverage, five measured papers, three papers with positive activity, more than one distinct value, and at least 25% coverage in each represented mathematical category. Settings can raise or lower the overall coverage minimum within 25–100%; the remaining gates still apply. A recently retrieved value does not prove a fresh underlying counter. The UI separately exposes observation time, provider update time (or unknown), measurement window and the metric's limitations.

**Why is this trending?** provides the raw evidence, provider, window, availability status and tie rule. Raw counts are not divided by paper age: no empirical evidence justified that model. Older papers may have had more time to accumulate activity. Rolling counts, current library membership, citations and unknown windows cannot establish exact new-readership velocity.

External observations are independent of personal feedback. Interest reset leaves them intact. They have a separate export and clear operation, and retain at most 50,000 records from 30 days. **Delete all local data** erases both personal state and external data. No provider credentials, private interests or reading histories are sent to attention services by the userscript.

## AI Highlights

Open Highlights, then **Assess selected Recent papers**. Select the papers explicitly and request the assessment. The per-batch maximum defaults to one and can be set from one to ten. Existing AI consent, pairing, provider allowlists, daily request limits and spending limits still apply. Nothing scans thousands of papers automatically.

A candidate decision needs source evidence for an allowed basis: an open problem, a bound, a method, a connection, a generalization or a computational contribution. The decision does not independently verify the mathematics or historical priority. Missing or invalid evidence yields an inconclusive decision. No Spoilers prevents result-based candidate classification. Changing protection hides incompatible prior assessments; unknown-version assessments expire rather than persisting indefinitely.

The same paper controls remain available: ratings, Need background, bookmarks, reading marks, author follows, AI overview and contextual definitions. Feedback recorded in Random follows the existing option controlling whether Random feedback trains future recommendations. Other feed labels are retained as collection provenance without creating a second interest model.

## Research collection

The collector, population freezer and offline replay are documented in [Reproducing the experiment](research/experiment-running.md). They run locally with explicit request limits and credentials when a provider requires them. Historical collection is a one-shot command suitable for an operator-managed scheduler. No hosting account, paid service or recurring job was provisioned, and no future measurements are claimed.
