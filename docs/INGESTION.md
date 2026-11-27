# arXiv ingestion

The discovery reader parses the displayed mathematics announcement in place. It reads every article list inside the listing container, including repeated `id="articles"` elements. Section headings associate each adjacent `dt` and `dd` pair with new submissions, cross-submissions or replacements. The announcement heading supplies the publication date. Standalone papers use null for both the announcement date and section because their submission history describes a different event.

## Paper records

`parseListing(document, baseUrl)` returns structured paper records in listing order and dispatches `/recent` to the multi-date Recent parser. Today has `population: 'today'` and one `announcementDate`; Recent has `population: 'recent'`, `announcementDate: null`, and an ordered `announcementDates` array. Each paper retains its own announcement date. `findPaperNodes(document, baseUrl)` returns a separate map from each paper ID to its native header and description elements. The parser reads the native DOM without altering it. `parseAbstract(document, baseUrl)` reads classic abstract pages and LaTeXML pages with a `.ltx_document` element. `readerTarget(node)` identifies the supported text region for a dictionary selection.

Records retain the original title, abstract, comments, journal reference, author order and primary and secondary classifications. The 32 mathematics codes use the following equivalents for sampling. Other identifiable arXiv classifications stay in the record.

| Displayed code | Mathematics code |
| --- | --- |
| math-ph | math.MP |
| cs.IT | math.IT |
| cs.NA | math.NA |
| stat.TH | math.ST |

The versionless ID identifies a paper across announcements. An explicit version in an abstract, PDF or HTML link takes precedence. New submissions default to version 1. A cross-list or replacement without an explicit version uses 0 for unknown and keeps the bare ID in `versionedId`. A standalone unversioned abstract can identify its displayed version through its citation metadata. A missing HTML link stays null. The normalized PDF link can use arXiv's standard PDF endpoint. Its availability is established when it is opened or retrieved.

Author-search links retain names and navigation URLs. An author profile URL or a valid ORCID can supply a persistent identifier. Two matching name strings alone do not establish a researcher’s identity. A full HTML conversion can omit structured authors or subjects. The parser leaves those fields empty when it cannot identify them.

## Text and links

Text extraction decodes character entities and preserves Unicode, line breaks, source TeX, and TeX annotations from MathJax or MathML. A pre-rendered expression with no recoverable TeX can supply accessible text. Extracted records contain strings and optional link ranges. `paper.inlineLinks[field]` contains ordered `{start, end, url}` ranges in the corresponding JavaScript string, measured in UTF-16 code units. The interface can reconstruct links with text nodes and anchor elements. Link ranges accept HTTP and HTTPS. Paper download and abstract URLs must identify the same paper on arXiv. Aliases in old-style arXiv IDs resolve to a shared versionless record.

## Pagination and verification

The parser checks advertised daily and section totals against distinct paper records. It reports unpaired rows, repeated IDs, missing identifiers, missing subjects, inconsistent counts and invalid announcement dates. A dated, explicitly empty announcement can be complete. A page missing verifiable totals remains incomplete.

The Today interface filters the original rows already present in the page. On an incomplete daily listing, **Open complete arXiv listing** follows a validated native all-entries link, or requests the same path with `skip=0` and up to 2,000 entries. After navigation, the parser verifies the actual date and counts again. If the native page remains incomplete, daily sampling stays unavailable. Explicit Recent-based feed requests can retrieve additional listing metadata; externally fetched HTML never becomes executable page content.

`loadCompleteListing(initial, {request, parseDocument, onProgress, maxPages})` follows the listing’s own pagination controls on demand for both Today and Recent. It prefers larger pages and skips ranges already completely retrieved. It accepts only validated numeric `skip` and `show` values on the same archive and same `/new` or `/recent` path. It never switches between those populations. Requests are sequential and use the caller’s rate-limited transport. The default parser for a fetched listing uses an inert HTML template.

The loader merges overlapping pages by stable paper ID and checks announcement dates, totals, sections and record versions. A verified complete Today rendering can replace a malformed partial one from the same cycle. Date and total changes halt the load. HTTP 401, 403, 429 and 503 stop further requests in that attempt. An incomplete return retains the available records and a diagnostic. A request permits up to 80 additional pages by default and a response of at most 32 MiB of text. Archived monthly listings are outside this feed population contract.

## Recent cohorts and completeness

Recent is defined by the native `/list/math/recent` listing, including every date listed there. No clock-based seven-day or other publication window replaces this population. The native date-navigation links provide ordered cohort dates and first-row positions. These establish a frozen `cohortSignature`, `dateStarts`, and `dateTotals` across pagination. Date headings corroborate the totals, including native headings such as `(continued, showing last 151 of 352 entries)`. Weekend and holiday gaps remain exactly as published.

Every raw row receives a validated global source index. `sourceEntries` records the index, normalized paper ID, announcement date, explicit submission section if supplied, and version. `entryCount` counts distinct source positions and `advertisedTotal` is arXiv's raw row count. The `papers` collection is deduplicated by normalized, versionless ID in first-appearance order, so `counts.total` and the final `distinctTotal` can legitimately be smaller than the advertised raw entry total. Coverage experiments use the complete distinct-paper denominator, never the displayed first-page count. A repeated ID does not excuse a missing source position.

Completeness requires every position from 1 through the advertised total, consistent cohort totals, chronological cohort order, stable overlapping row identities and metadata, and no parsing-integrity warnings. A cohort or count change during pagination fails closed. A source with no explicit new/cross/replacement labels leaves `paper.section` null. Primary categories and version numbers are not used to invent submission types. Explicit labels are retained when present; every source occurrence remains in `sourceEntries` even when papers deduplicate.

`validatePopulationSnapshot(raw)` verifies the complete population envelope again before cached data is reused. It recomputes counts and checks dates, source positions, cohort boundaries, signatures, and first-occurrence correspondence. Its caller must validate paper contents through the existing `checkedPaper` schema before calling it. Personal reading data and external readership observations remain outside this public-metadata envelope.

## Reproduce a population freeze

Install Python Playwright and a Chromium browser, then run:

```sh
python scripts/freeze-readership-population.py --population recent --output recent-population.json
python scripts/freeze-readership-population.py --population today --output today-population.json
```

Set `CHROMIUM_BIN` when the executable is installed separately. The script runs the production JavaScript parser and paginator in an inert Chromium document, spaces network requests by at least three seconds, and saves the complete population, retrieval timestamps, a population hash, a source manifest, and hashed gzip copies of every response. The default request size is 2,000, which is a page size rather than a cap on the final population. `--max-pages`, `--delay`, `--timeout`, and `--raw-dir` configure bounded collection. No AI or readership provider is called.

Replay the same observations without network requests:

```sh
python scripts/freeze-readership-population.py --population recent \
  --replay-manifest recent-population-manifest.json --output replayed-recent.json
```

A replay retains the original source-retrieval timestamps, identifies itself as a replay, and records a separate parse time. User-supplied snapshots with unknown retrieval times do not gain fabricated timestamps. Incomplete retrieval writes its warnings and exits with status 2; it cannot be used as a complete-population denominator.

## Regression tests

Run the taxonomy and pagination unit tests with `node --test tests/parser_categories.test.js`. For browser DOM coverage, install Python Playwright and Chromium, then run `python tests/parser_browser.py`. Set `CHROMIUM_BIN` to select a browser executable. The browser suite serves application modules through intercepted local responses and reads the unchanged supplied HTML fixtures. Today checks all 701 papers, including 379 new submissions, 61 cross-submissions and 261 replacements, on November 26, 2026. The supplied Recent fixture contains only 50 of 2,555 advertised entries and declares five date cohorts; it is deliberately tested as incomplete. Clearly synthetic fixtures exercise multi-page continuation across dates, weekend gaps, normalized-ID deduplication, explicit and unknown sections, malformed pairs, missing positions, cohort rollovers, legacy IDs, ORCID, mathematical text, safe URLs, cache tampering and failed pagination.

The taxonomy, identifier formats and HTML availability follow arXiv’s published reference material. [Category taxonomy](https://arxiv.org/category_taxonomy) · [arXiv identifiers](https://info.arxiv.org/help/arxiv_identifier.html) · [HTML paper availability](https://info.arxiv.org/about/accessible_HTML.html)
