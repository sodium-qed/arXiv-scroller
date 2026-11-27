# Testing arXiv Discovery

The browser suites use the supplied mathematics announcement and generated, clearly labeled fixtures. They intercept requests before navigation and exercise the production parser or the built userscript. No tests require arXiv availability, a hosted AI account, a pairing credential, or a paid request.

## Verified development build 1.3.0

The feature branch integrates upstream `65802c20f991c8ded25f1567c4fc80fad951d0a2` (version 1.2.5), including Gemini support, protected-answer cache invalidation, stronger spoiler filtering, local structured output and the latest mathematics-rendering fixes. The earlier adaptive-sampling behavior remains covered by its original tests. No merge or release publication is implied by this verification.

| Suite | Final result |
|---|---:|
| Node.js unit and security tests | 136 passed |
| Python bridge tests | 23 passed |
| Existing userscript browser integration | 20 passed |
| Parser browser integration | 12 passed |
| New feed browser integration | 11 passed |
| Total automated cases | **202 passed** |
| Archived readership experiment replay | `verified: true`; 56 response hashes, 2,783 queried IDs and all coverage/ranking results reconciled |

Runtime: Node.js 24.22.3, Python 3.12.14, Playwright 1.62.0 and Chromium 158.0.8127.0. The tested userscript contains **507,551 bytes**, with SHA-256 **`9e72e5c387a94ce249c3dd83556fc7a23c5979f3c50f066834f6eb8fc5721b9b`**. Both userscript browser suites used this final rebased bundle; parser and bridge sources were unchanged by the final upstream math-only update. The bridge schema integration was tested separately through its real loopback transport fixture.

The feed cases check all ten choices, Today navigation, complete Recent pagination, multi-date cohorts, refresh expiry, compatible offline reuse, honest missing-data states, import atomicity, global coverage denominators after filters, ties and keyboard ranking order. Pending requests cannot navigate, write a cache or continue an AI batch after the view or data generation changes. Highlights tests cover candidate evidence, inconclusive decisions, protection changes, duplicate-note removal and cancellation.

Saved regression checks start with a legacy rich version-2 bookmark and a sparse unknown-version Recent entry for the same paper. They verify snapshot migration, original abstract/comments/journal metadata and versioned links, canonical metadata preservation after reading/bookmark actions, restored native rows and controls, bookmark removal through the older management dialog, and restart persistence. Backup tests retain exact existing records while explicitly checking the additive legacy snapshot migration.

The readership unit cases use labelled synthetic values for edge conditions, including genuine zero versus missing counts, identifier ambiguity, provider errors, category coverage, stale timestamps, shared ranks, restricted retention and incomparable growth counters. The separate archived census replay uses actual recorded public responses. It confirms 6/2,555 Recent and 179/701 Today exact metadata matches, with no available views or downloads; it does not fabricate future observations or a usable production ranking.

Desktop and 390-pixel phone-width feed/settings screenshots were inspected. Tests intercept external requests and use a disposable userscript-manager adapter. They do not verify a real Tampermonkey install/update prompt, a live hosted-model answer, a closed-browser scheduler or future provider coverage. Existing installed-copy checks below remain the procedure for those environment-specific behaviors.

## Historical verification: release 1.2.0

Node.js 24.22.3 passed all **85 JavaScript tests**; Python 3.12.14 passed all **16 bridge tests**. Chromium 152.0.7977.0 with Playwright 1.62.0 passed all **20 userscript integration cases** and all **7 parser cases**. These checks include the existing local-AI changes merged at `3770c53fc9661bdce716bee7b1899a51e1c4d2db`; the adaptive-sampling change leaves the AI client, transport, bridge and interest model unchanged from that commit.

The tested release file is `dist/arxiv-discovery.user.js`, 398,414 bytes, with SHA-256 `e3e2c587dbef081dd5378cc8955fa038ed5a6a02d77aadb71af3dbf17d92be44`. It was rebuilt from the merged source and syntax checked before the final browser run. The build uses the same userscript namespace and permissions as the previous release.

On the supplied 26 November 2026 listing, all 701 papers had inline tools on first use. Its 379 eligible new submissions produced an automatic square-root target of **127 papers**, with **127 distinct papers selected**, **zero shortfall**, and all **30 nonempty categories represented**. Selected entries retained their published order. Choosing **Show all papers** restored all 701 entries. Example rows from the saved distribution were:

| Category | Eligible papers | Square-root quota | Selected |
| --- | ---: | ---: | ---: |
| `math.AP` | 56 | 8 | 8 |
| `math.CO` | 46 | 7 | 7 |
| `math.AG` | 30 | 6 | 6 |
| `math.KT` | 2 | 2 | 2 |
| `math.SG` | 1 | 1 | 1 |

The empty eligible pools for `math.GN` and `math.HO` had quota zero and identified their disabled replacement sections. This fixture demonstrates that the adaptive target is determined by the category distribution and is independent of the Personalized default of 50.

At a 390 × 844 viewport, the browser test locates **Settings** to the right of the listing heading and above the first paper. It opens the dialog with Enter, closes it with Escape, and checks that focus returns to the button. The dialog fits the viewport without horizontal scrolling.

The expanded category-distribution table was also inspected at desktop and 390-pixel phone width. Its own container scrolls horizontally while the page remains within the viewport. A conflict fixture with two papers cross-listed into three categories displays target 6, selected 2 and shortfall 4, with reasons for all unfulfilled category quotas. Native DOM preservation checks pass with the reversible filter applied.

### Mathematical and statistical checks

The sampler suite contains 26 tests. An independent oracle enumerates paper-to-category assignments directly, without using the production augmenting-path method. It checks the lexicographic objective of maximum represented categories followed by maximum filled quota slots on **all 4,096 graphs with three categories and four papers**. Discovery's one-slot behavior is separately checked on **all 512 three-by-three graphs**. Larger adversarial graphs test bottlenecks, forced reallocations, severe overlap and multi-hop replacements with several occupied slots per category. The matching argument is documented in [the recommender guide](RECOMMENDER.md#matching-algorithm-and-correctness).

Fixed-seed empirical checks cover uniform quota-sized subsets, Pure Random's independence from preferences, Balanced's configurable uniform/weighted mixture and global weighted Personalized sampling. Two-paper weighted inclusion frequencies are compared with independently enumerated expectations. Unsupported weighted multi-slot and cross-list marginals remain `null` rather than reusing first-draw probabilities. All modes are checked for reproducibility under input reordering.

| Large synthetic announcement | Target | Unique selected | Shortfall |
| --- | ---: | ---: | ---: |
| 100,000 papers spread across 32 disjoint category pools | 1,792 | 1,792 | 0 |
| 10,000 papers each cross-listed in all 32 categories; 320,000 eligibility edges | 3,200 | 3,200 | 0 |

These Node cases completed sampling in about 1.09 and 0.93 seconds respectively in the final combined run. Timings are observations from this container, not browser performance guarantees. The algorithm shares category adjacency lists and has search depth bounded by the number of categories, avoiding a recursion stack proportional to the number of selected slots.

Storage tests round-trip adaptive selections above the old 32-paper cap, full distribution snapshots, legacy originals and revisions, and a 200-paper Personalized selection. They reject contradictory quota metadata before import writes. Browser tests reopen a legacy count-32 selection under the new default of 50, change the unrelated Personalized size to 200, and verify the saved draw remains byte-for-byte unchanged until explicit regeneration. Restoring the historical original returns its original papers and absence of distribution metadata.

## Run the suites

From the repository root, with Node.js 20 or later and Python 3.10 or later:

```sh
npm run build
npm test
python -m pip install -r bridge/requirements.txt
python -m unittest discover -s tests -p 'test_bridge.py'
python -m pip install playwright
python -m playwright install chromium
python tests/parser_browser.py
python tests/browser_integration.py
python tests/feed_browser.py
node scripts/replay-readership-experiment.mjs
```

The optional PDF extraction test runs when `pypdf` is installed. On a machine with Chrome or Chromium already installed, set `CHROMIUM_BIN` to its executable to use that browser. The integration suite reads `dist/arxiv-discovery.user.js`. Rebuild after changing source files.

## What the suites exercise

| Suite | Checks |
| --- | --- |
| Node unit tests | Taxonomy, adaptive quotas, both matching objectives, global sampling, rationale and justified recorded probabilities, large announcements, feedback revisions and training windows, distinct interest and knowledge data, learning and analytics, private storage, legacy backup preservation, and AI request construction and provenance. |
| Python bridge tests | Provider configuration, budget and request limits, source extraction and fallback, safe source handling, cache behavior and provider errors using local test doubles. |
| Parser in Chromium | Every article list in the supplied fixture, 379 new submissions, 61 cross-submissions and 261 replacements, 701 distinct papers on 26 November 2026, bibliography and mathematical text, malformed records, missing formats, and pagination integrity. |
| Userscript in Chromium | Direct paper actions, Settings, toggling tools, mode changes, adaptive distribution tables and shortfalls, Personalized default 50 and boundaries 1/200, legacy draw pinning, finite unique selections, replacing and restoring a paper, daily history, structural preservation and menu restoration, refresh and process restart, explicit feedback and reversal, bookmarks, name-only follows, knowledge, backup import, complete deletion and subsequent saves, dialogs and contained table scrolling at phone width, inline explanations and recursive dictionary selection, cached responses, provider failures, and native navigation for incomplete listings. |

The full-fixture case finds one **Paper tools** group at the end of each native paper description. It scrolls to the first and last papers and checks that their feedback, bookmark, reading and AI actions are visible before any click. It opens a daily selection through **More tools** and verifies that the visible `dt` and `dd` pairs stay in their original order.

The Settings cases change the recommendation mode on the full listing and during a daily selection. Turning off **Enable paper tools** while filtering restores every native entry and disables keyboard feedback and the dictionary prompt. Settings stays available to turn the tools back on. A fresh browser process reopens the same disposable profile and checks the saved preference, mode, daily paper identifiers and bookmark.

The DOM comparison removes the add-on's own hosts from a detached clone and compares the remaining markup to the exact original. During a filter it permits the temporary `hidden` attributes on native paper rows. It checks the original elements' identity, parentage and sample typography throughout. Restoring the listing must restore prior attribute values, including `hidden="until-found"`. The full removal check refreshes the page and reopens the add-on through its registered menu.

Most integration cases open only the add-on's shadow roots for Playwright inspection. The startup and focused-input keyboard cases retain the production closed roots. Clicks, keys, and dictionary double-clicks use browser input. Persistent storage is a test double backed by local storage in a disposable profile. Browser restarts exercise this profile with a fresh browser process. Package-manager updates, the Tampermonkey installation prompt, its permission UI, persistence through a Tampermonkey upgrade, real arXiv serving behavior, and live model output need their respective environments for verification.

Browser tests use a restrictive content security policy and intercept every route. They block the fixture's original remote styles, fonts, scripts, and images. The phone-width check verifies the add-on dialog fits its viewport. Live arXiv typography and remote MathJax presentation require a browser installation on the site.

## Check an installed copy

1. Install the release userscript in Tampermonkey, then open the mathematics new-listing page. Check the normal paper links, pager, keyboard focus and original page order.
2. Bookmark a paper directly beneath its abstract and record feedback there. Open **Settings** at the upper right, choose a recommendation mode and select **Show daily selection**. Record a few identifiers from the native listing.
3. Turn off **Enable paper tools** while the selection is active. Check that the full listing returns and that **Settings** stays available. Refresh, reopen Settings, check the saved mode and turn the tools back on. Reopen the daily selection and compare its paper identifiers.
4. Restart the browser and check the bookmark and feedback through the Tampermonkey menu. With AI configured, highlight a term and confirm the explanation appears beneath that paper.
5. Choose **Original arXiv** and confirm that the paper controls and Settings button disappear. Reopen through **Show arXiv Discovery** in the Tampermonkey menu.
6. When verifying an upgrade, export a backup, update the installed userscript in place, and compare the retained selection and records. Record the browser, Tampermonkey and userscript versions.
