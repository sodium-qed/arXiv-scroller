# Architecture

The installable file is a Tampermonkey userscript. At document idle, it parses the current arXiv page, loads the reader's private state and attaches a collapsed **Discovery tools** disclosure to each native paper entry. The optional Python process on loopback handles paper retrieval for AI and provider credentials.

## Browser components

| Component | Responsibility |
| --- | --- |
| `src/main.js` and `src/app.js` | Start the top-frame application, map paper records to native DOM pairs, register menu commands and mount each paper's disclosure. Apply the selected filter to existing pairs, show explanations inline, and open management dialogs on request. |
| `src/dom.js` and `src/math.js` | Build scoped controls and safe links inside closed shadow roots. Generated explanation text can contain delimited TeX, converted to native MathML with a locally bundled renderer. arXiv owns the paper markup. |
| `src/categories.js` and `src/parser.js` | Normalize categories, arXiv identities, authors, dates, paper fields and links. The node lookup is separate from serializable records. The parser handles repeated article-list IDs. |
| `src/native-list.js` | Filter existing identifier/description pairs by paper ID. Track only the row visibility changes made by the userscript, restore them when the filter clears, and enumerate visible rows in current DOM order for keyboard navigation. |
| `src/network.js` and `src/transport.js` | The ingestion module supports validated pagination and reconciliation of metadata. Tampermonkey's restricted transport carries requests to the paired bridge. The native reading view links to arXiv's complete listing when more rows are needed. |
| `src/sampling.js` | Build the eligible pool, randomize order from the recorded seed, match categories to distinct papers, or draw a mode-specific finite set. Return reasons and known probabilities alongside entries. |
| `src/recommender.js` | Resolve event revisions, apply history filters, encode text and subjects, fit a regularized logistic classifier, score candidates and calculate date-filtered analytics. |
| `src/schema.js` and `src/storage.js` | Validate versioned records, read and write private collections, handle backup import and build a separate IndexedDB cache for public listings. |
| `src/exports.js` | Build reading and feedback CSV, bookmarked-paper BibTeX and downloadable text. JSON import and export use the versioned store. |
| `src/ai.js` | Require enabled settings, provider consent, a paired bridge and an allowed local address. Build a request, reuse a cached answer when appropriate, and validate returned source links. |
| `bridge/server.py` | Authenticate the client, acquire and extract source passages, enforce limits, reserve estimated cost, call a configured model, and ground paper-specific response fields in source quotations. |
| `scripts/build.mjs` | Walk named local ES-module imports, isolate module scope and assemble one userscript with Tampermonkey metadata. The checked-in bundle includes the math renderer and its license notices. |

## From announcement to selection

1. The parser reads the date displayed by arXiv and pairs each article identifier with its description within the correct submission section. It compares recognized records, advertised section counts and the total.
2. The page initially keeps arXiv's complete layout. **More tools** within any paper disclosure and the Tampermonkey menu provide global commands. On a partial daily page, **Open complete arXiv listing** opens the same archive on arXiv so the browser receives genuine paper rows. The daily filter requires a verified single date and complete counts on that page.
3. New submissions are eligible initially. Cross-submissions and replacements have separate switches. The seeded sampler can use primary and secondary mathematics subjects. Randomized maximum matching assigns the greatest possible number of categories without reusing a paper.
4. A daily record pins the original draw and current draw for its archive, date, mode and eligibility settings. Explicit changes append older draws to its revision history. Saved snapshots retain the paper identity and version for links in selection history.
5. Applying the draw filters existing identifier/description pairs in place and preserves their original order. A compact status beside the native pagination exposes **Selection options** and **Show all papers**. Each selected entry has its own rationale and replacement action. Clearing the filter restores the native entries. Refreshing starts with arXiv's full native view. Reapplying the same daily selection uses the pinned record. **Original arXiv** also removes the userscript's UI.
6. Manual reads, ratings, bookmarks and author follows have distinct records. A rating correction references its predecessor. Training resolves the current feedback for each paper, applies the chosen exclusions, and rebuilds from eligible likes and dislikes.

The model encodes words, adjacent retained words, curated mathematical concepts and categorical metadata in a sparse vector. The concept vocabulary can link different expressions for selected ideas. Frequency, title emphasis and regularization influence what a rating transfers to another paper. New concepts outside the vocabulary can share lexical features. A replaceable encoder, training and inference API separates model changes from category matching. [Encoding and statistical details](RECOMMENDER.md)

## Persistence and disclosure boundaries

| Location | Stored data | Lifetime |
| --- | --- | --- |
| Tampermonkey private values | Settings, feedback revisions and feature snapshots, known papers, bookmarks, reading history, subscriptions, topic edits, glossary visits, pinned selections and cached AI answers. The pairing token is a private setting. | Across reloads in the same userscript installation, subject to browser storage and explicit deletion. A JSON backup omits the pairing secret and clears AI consent. |
| arXiv-origin IndexedDB | The public-cache module holds validated listing metadata, including data cached by earlier releases. A digest in private storage checks cache contents before reuse. | Temporary cache with an age check. The current native filter reads the actual page. Complete data deletion also clears this cache. |
| In-memory browser model | Active examples, encoded content and fitted weights for the current training window. | Recomputed from the authoritative feedback history. |
| Bridge process | Acquired public source excerpts for recently requested papers. Hosted API keys are process environment values. | Excerpts have bounded lifetimes in RAM. Stopping the bridge clears this cache. |
| Bridge SQLite ledger | UTC day, provider attempt count and estimated charges or reservations. | Persists across bridge restarts at the operator-configured path. |

The bridge receives a requested paper, the reader's explicit topics and levels, the requested question or term and limited surrounding context. Local selection weights, interest events, author notes, bookmarks and reading history stay outside model requests. The source hierarchy, cost reservation, output evidence checks and policy for incomplete extraction are documented separately. [AI protocol and operating guide](AI.md)

The data-schema guide describes collection keys, revision records, recovery and backup import. The security guide explains the visibility of each storage area, browser grants and treatment of external content. [Data schema](DATA_SCHEMA.md) · [Privacy and security](SECURITY.md)

## Mathematical rendering

The parser preserves source TeX, Unicode and available inline link ranges in serializable paper records. Reading uses arXiv's existing title, abstract and full-text nodes with the site's own typesetting. In an inline explanation, saved glossary answer or saved-paper link, dollar signs and TeX parentheses or brackets can delimit an expression. Each expression gets a fresh macro environment. The rendering adapter limits input length, expansion count, tree size, tree depth and accepted dimensions. It obtains a presentation tree from the vendored Temml release and recreates only allowlisted MathML elements, attributes and bounded styles. All text becomes text nodes. Unknown commands and unsupported presentation nodes retain their original text and delimiters.

The browser supplies the mathematics fonts. The upstream browser build is pinned to Temml v0.14.0 at commit `ac68f15a6e9fa89f9c72e0827a13a6bd0d36f612`. The original 167,881-byte payload has SHA-256 `56b4338176d39170692503b8b7ec630d3edf8e10861895658deb74aefb66af9d`. The repository adds notices and a named ES-module export after the upstream bytes. The adapter uses a pinned tree API, so a renderer update requires rerunning its structure, provenance and fallback tests. [Upstream browser file](https://github.com/ronkok/Temml/blob/ac68f15a6e9fa89f9c72e0827a13a6bd0d36f612/dist/temml.min.js) · [Temml options](https://temml.org/docs/en/administration)
