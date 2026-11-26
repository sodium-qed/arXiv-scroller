# Known limitations

## Coverage of arXiv

- Daily discovery needs a verifiable single announcement date and complete paper counts. A changed date, rejected request or inconsistent section count leaves the panel with a diagnostic. The reader can continue using the original arXiv page. Multi-date archive and recent listings do not produce a combined daily draw.
- A category can receive no eligible paper, and a cross-classified paper can fill only one slot. Uniform priorities within a category before matching do not imply uniform final inclusion under overlapping classifications. Unknown selection probabilities are recorded as null.
- An unversioned replacement or cross-list can lack enough information to recover its exact historical version. A PDF or full HTML version can later become unavailable. A paper's abstract page and the date printed on its saved card help identify what was read.
- Author dashboards use papers that have been loaded locally. A name-only follow can include homonyms or miss spelling variants. Stable identifiers are used when supplied by arXiv. Subscriptions do not perform a historical author crawl or send background notifications.

## Interests, knowledge and rendering

- The classifier uses a bounded sparse representation of words, adjacent word pairs, a finite vocabulary of equivalent mathematical concepts and subject metadata. New terminology, unusual notation, alternate languages and synonyms outside this vocabulary can yield weak matches. Scores reflect the current feedback history. A score is an uncalibrated estimate, and a small sample can move it substantially.
- Category feedback reflects the papers the reader chose to review. The displayed interval measures sampling uncertainty for the observed like share. It cannot correct self-selection or establish the reader's mathematical ability. Cross-classified papers can count toward multiple category rows.
- Discovery uses manual reads and eligible ratings as local evidence of prior encounters. It can estimate familiarity with topics and researcher labels in those records. Activity outside this installation supplies no such evidence.
- In added panels, the bundled TeX renderer supports common inline and display mathematics and uses installed math fonts. Unknown author macros, specialized fonts, unsupported layouts, deliberately oversized expressions and unmatched delimiters remain visible as source. Expressions spanning separate hyperlink and text runs can also remain in source form. Original arXiv notation follows the page's own rendering settings.
- The contextual dictionary operates on selectable text in the supported listing, abstract, HTML paper and explanation views. Browser PDF viewers, scanned images and individual symbols without selectable text can require opening the HTML or abstract view.

## AI and personal data

- AI requires a paired bridge and a compatible, available model with the selected name. Hosted generation can incur charges. Local limits use configured prices and provider reports. Provider billing settings determine actual charges. Bridge setup, including the optional PDF dependency, is documented in the [AI guide](AI.md).
- The bridge can send excerpts when a paper exceeds the configured context size. An image-only or poorly extracted PDF can produce an abstract-only answer. The answer names its analyzed source and coverage. A matching quotation verifies the quoted wording. Readers still need to check the source to assess interpretation or proof status.
- No Spoilers changes source selection and allowed answer fields. A title, the original paper or an unusual piece of generated prose may still reveal a result. A paper-specific setting can override the global default.
- The reader's data belongs to the current browser profile and userscript installation. Browser data removal, extension removal or storage pressure can affect retention. Use the JSON export to move or recover personal records. Importing a backup requires pairing the AI bridge and granting consent again.
- Deletion in the browser acts on this installation. Separately downloaded backup files, a bridge's aggregate usage ledger and a hosted provider's records have their own retention. The bridge guide explains how to locate its ledger and clear its in-memory source cache.

## Verification

The supplied listing and controlled model responses give reproducible parser, recommendation and AI checks. Browser tests using a fixture and a Tampermonkey-API adapter exercise a different boundary from a signed Tampermonkey installation, a live arXiv response or a billed hosted completion. The test guide identifies these boundaries and provides an installed-copy check. [Verification details](TESTING.md)

In a separate headless Chromium 152 check, the renderer produced native MathML for 3,540 of the 3,674 delimited expressions individually identified in the supplied fixture's parsed titles and abstracts. The other 134 retained their original TeX, including author macros such as `\Fp`. A layout check verified the numerator appeared above the denominator in a fraction and found both rows in a rendered matrix. These counts describe this particular fixture and renderer version.


## Compact local AI mode

Quick overviews use abstract-only evidence when unprotected. This trades depth for speed; switch to Detailed for paper excerpts. Streaming reports progress, not unchecked mathematical text. Source quotations can verify wording but cannot detect every misinterpretation of a correct quotation. The local model still needs independent accuracy and latency benchmarking. No hardware changes are required by the software.
