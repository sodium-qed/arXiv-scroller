# Testing arXiv Discovery

The browser suites use the supplied mathematics announcement and generated, clearly labeled fixtures. They intercept requests before navigation and exercise the production parser or the built userscript. No tests require arXiv availability, a hosted AI account, a pairing credential, or a paid request.

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
```

The optional PDF extraction test runs when `pypdf` is installed. On a machine with Chrome or Chromium already installed, set `CHROMIUM_BIN` to its executable to use that browser. The integration suite reads `dist/arxiv-discovery.user.js`. Rebuild after changing source files.

## What the suites exercise

| Suite | Checks |
| --- | --- |
| Node unit tests | Taxonomy, sampling and matching, rationale and recorded probabilities, feedback revisions and training windows, distinct interest and knowledge data, learning and analytics, private storage, and AI request construction and provenance. |
| Python bridge tests | Provider configuration, budget and request limits, source extraction and fallback, safe source handling, cache behavior and provider errors using local test doubles. |
| Parser in Chromium | Every article list in the supplied fixture, 379 new submissions, 61 cross-submissions and 261 replacements, 701 distinct papers on 26 November 2026, bibliography and mathematical text, malformed records, missing formats, and pagination integrity. |
| Userscript in Chromium | First use, finite unique selections, mode changes, replacing and restoring a paper, daily history, structural preservation and menu restoration, refresh and process restart, explicit feedback and reversal, bookmarks, name-only follows, knowledge, backup import, complete deletion and subsequent saves, dialogs at phone width, recursive dictionary selection, cached responses, and recoverable network failures. |

The full-fixture DOM check compares the original document markup after removing the add-on hosts from a detached clone. It also verifies that each original element remains connected to its original parent. The original-mode check removes the actual hosts, refreshes the page, and opens the add-on again through the registered menu callback.

Most integration cases open only the add-on's shadow roots for Playwright inspection. The startup and focused-input keyboard cases retain the production closed roots. Clicks, keys, and dictionary double-clicks use browser input. Persistent storage is a test double backed by local storage in a disposable profile. Browser restarts exercise this profile with a fresh browser process. Package-manager updates, the Tampermonkey installation prompt, its permission UI, persistence through a Tampermonkey upgrade, real arXiv serving behavior, and live model output need their respective environments for verification.

Browser tests use a restrictive content security policy and intercept every route. They block the fixture's original remote styles, fonts, scripts, and images. The phone-width check verifies the add-on dialog fits its viewport. Live arXiv typography and remote MathJax presentation require a browser installation on the site.

## Verified browser run

Chromium 152.0.7977.0 with Python Playwright 1.62.0 passed all seven parser cases and all fourteen packaged-userscript cases. The reference announcement yielded 701 papers and a default selection of 30 distinct papers. The browser rendered `x^2` with a native MathML superscript and retained the TeX annotation. A 390 × 844 viewport produced a 374-pixel-wide settings dialog with no horizontal content overflow. The dictionary selection tests exercised both an original arXiv title and a selection within an already-open explanation dialog. After a complete deletion, the recovery test opened an existing native paper, created a fresh bookmark, then verified its saved title and link after a different announcement loaded.

The tested release userscript has SHA-256 `8387313cf8ce685f97458596fb1a3842f17fee27507adaed234ec5a3c9112d43`.

## Check an installed copy

1. Install the release userscript in Tampermonkey, then open the mathematics new-listing page. Check the normal paper links, pager, keyboard focus and original page order.
2. Open **Daily selection**, record a few paper identifiers, refresh, and compare. Make one bookmark and one feedback entry. Restart the browser and check both records.
3. Choose **Original arXiv** and confirm the added controls disappear. Reopen through **Show arXiv Discovery** in the Tampermonkey menu.
4. When verifying an upgrade, export a backup, update the installed userscript in place, and compare the retained selection and records. Record the browser, Tampermonkey and userscript versions.
