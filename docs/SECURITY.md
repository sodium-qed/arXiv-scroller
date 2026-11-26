# Security and privacy

The discovery feed, classifier and interest history run in the userscript. Reading a listing, rating a paper and opening an interest dashboard use local data. Loading missing publication pages makes a request to arXiv. A reader's explicit overview or dictionary request can contact a paired AI bridge after the reader enables a provider.

## Where information goes

| Location | Contents | Access and lifetime |
| --- | --- | --- |
| Tampermonkey storage | Feedback and paper snapshots, bookmarks, reading dates, subscriptions and notes, knowledge, glossary, daily selections, cached AI answers, settings and a bridge pairing token | Private to the userscript through the manager's storage API. Settings provides selective and complete deletion. The browser profile and userscript manager are part of the trust boundary. |
| arXiv-origin IndexedDB | Validated public metadata for a completed listing and its cache time | Website code can read and change this database. The userscript checks the listing date, identity, counts, record shape and a SHA-256 checksum kept in private manager storage before reuse. A changed or expired entry triggers the normal cache-miss path. |
| Added page controls | The private content the reader opens, displayed in closed shadow roots. Public host elements identify the add-on and selected theme. | The userscript runs in its manager's isolated DOM sandbox. Closing a dialog removes that view. Original arXiv removes the add-on controls. |
| JSON, CSV and BibTeX downloads | User-selected personal data, including glossary answers, notes and feedback in a complete JSON backup | The browser saves ordinary, unencrypted files. Download links use detached elements. JSON exports omit pairing and disable AI authorization. |
| Optional bridge and provider | The requested paper, selected term or question, nearby context and up to 64 topics from the explicitly maintained knowledge profile | The reader selects the destination and authorizes transmission. The bridge holds any provider key. Its SQLite ledger contains the UTC date, attempt count and estimated cost. Source caching in the bridge holds public paper text in memory. |

Complete browser deletion clears the userscript's personal state and public listing cache. A downloaded backup, data already delivered to a provider, and the separately operated bridge's usage ledger have their own lifetimes. The add-on maintains opaque change markers for open tabs and separate arXiv request-pacing timestamps.

## Paper and backup content

The parser reads text, mathematical notation and supported hyperlinks. Fetched listings are parsed in an inert template. Private panels construct DOM nodes from text and validated URLs. The bundled math renderer builds native MathML from an allowlist with trust disabled and bounded formula size and expansion. An unsupported expression retains its original delimiters and source text.

Abstract, HTML, PDF and citation links identify the expected paper on arxiv.org. An author identity link uses an arXiv author search or profile, or an ORCID identity. Papers can contain ordinary HTTP or HTTPS citations to other publishers. These links open on reader action with opener and referrer suppression. Generated explanations render as text with separately validated arXiv source links.

All backup collections are checked before the first private write. Validation covers nested author records, dates, identifier consistency, revisions, training windows, URL schemes, bounds, private answer provenance and historical snapshots. Structural keys that can alter object prototypes are rejected. Records are rebuilt from defined fields. Settings imported from a file always require new pairing and consent. CSV output quotes fields and prefixes formula-like cells. BibTeX output escapes TeX metacharacters in research metadata.

Restored titles, notes and explanation text come from the selected backup. A structurally valid file can contain edited prose. The original paper and the recorded citations provide the references for checking its content.

## Paired loopback bridge

The server binds to the numeric IPv4 loopback address. It accepts a bounded JSON POST at the explanation path, verifies the exact host and port, checks a supplied browser Origin against its allowlist and authenticates the pairing token with a constant-time comparison. It omits CORS permission headers. The browser transports the token in the Authorization header for the bridge request. The provider receives only its own configured credentials and an allowlisted message payload.

The server constructs arXiv source paths from a validated identifier and version. Its source host and permitted redirect paths are fixed. Hosted requests use the configured OpenAI service. Local requests use the selected port on the numeric loopback address. The bridge reads and extracts paper text, ignores active markup and runs PDF extraction in a timed subprocess with a reduced environment. It supplies no shell, browser, code execution or other tools to the model. The server checks its own model allowlist, token ceilings, daily attempts and estimated budget in addition to browser limits.

A model can still misread a paper or attach a genuine quotation to an interpretation the quotation does not support. The interface exposes the source, coverage and citations for review. The bridge configuration, grounding checks and data flow are documented in [AI.md](AI.md).

## Corrections, erasure and verification

Feedback corrections form revision chains. Training first selects the current revision, then applies history controls. Permanent paper deletion removes its complete chain. Classifier coefficients live in memory and are recomputed when history or settings change. A private change notification refreshes other tabs. A pending AI operation carries its initiating data generation so an answer arriving after erasure cannot recreate deleted private records. A request already delivered to a provider can still complete there.

The storage tests exercise interrupted restores, interrupted deletions, concurrent corrections, clock rollback, opaque generation changes and stale writes. Security tests exercise malformed records, detached downloads and changed public cache contents. Bridge tests exercise host and caller authentication, fixed destination handling, extraction failures and concurrent budget reservations. Reproduction commands appear in [TESTING.md](TESTING.md).
