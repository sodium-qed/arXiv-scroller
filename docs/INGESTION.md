# arXiv ingestion

The discovery reader parses the displayed mathematics announcement in place. It reads every article list inside the listing container, including repeated `id="articles"` elements. Section headings associate each adjacent `dt` and `dd` pair with new submissions, cross-submissions or replacements. The announcement heading supplies the publication date. Standalone papers use null for both the announcement date and section because their submission history describes a different event.

## Paper records

`parseListing(document, baseUrl)` returns structured paper records in listing order. `findPaperNodes(document, baseUrl)` returns a separate map from each paper ID to its native header and description elements. The parser reads the native DOM without altering it. `parseAbstract(document, baseUrl)` reads classic abstract pages and LaTeXML pages with a `.ltx_document` element. `readerTarget(node)` identifies the supported text region for a dictionary selection.

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

`loadCompleteListing(initial, {request, parseDocument, onProgress, maxPages})` follows the listing’s own pagination controls on demand. It prefers the advertised all-entries view, then a larger page, then ordinary page links. It accepts validated numeric `skip` and `show` values on the same archive and daily-list path. Requests are sequential and use the caller’s rate-limited transport. The default parser for a fetched listing uses an inert HTML template.

The loader merges overlapping pages by stable paper ID and checks the announcement, totals, sections and record versions. A verified complete page can replace a malformed partial one from the same cycle. Date and total changes halt the load. HTTP 401, 403, 429 and 503 stop further requests in that attempt. An incomplete return retains the available records and a diagnostic. A request permits up to 80 additional pages by default and a response of at most 32 MiB of text. Archived monthly or recent listings require a separate multi-date ingestion design.

## Regression tests

Run the taxonomy and pagination unit tests with `node --test tests/parser_categories.test.js`. For browser DOM coverage, install Python Playwright and Chromium, then run `python tests/parser_browser.py`. Set `CHROMIUM_BIN` to select a browser executable. The browser suite serves application modules through intercepted local responses and reads the unchanged supplied HTML fixture. It checks all 701 papers, including 379 new submissions, 61 cross-submissions and 261 replacements, and the displayed date of November 26, 2026. Smaller inputs exercise malformed pairs, absent formats, legacy IDs, ORCID, mathematical text, safe URLs, mixed dates and failed pagination.

The taxonomy, identifier formats and HTML availability follow arXiv’s published reference material. [Category taxonomy](https://arxiv.org/category_taxonomy) · [arXiv identifiers](https://info.arxiv.org/help/arxiv_identifier.html) · [HTML paper availability](https://info.arxiv.org/about/accessible_HTML.html)
