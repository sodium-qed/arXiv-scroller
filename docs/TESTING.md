# Testing arXiv Discovery

The browser suites use the supplied mathematics announcement and generated, clearly labeled fixtures. They intercept requests before navigation and exercise the production parser or the built userscript. No tests require arXiv availability, a hosted AI account, a pairing credential, or a paid request.

## Verified release 1.1.0

Chromium 152.0.7977.0 with Playwright 1.62.0 passed all 15 userscript integration cases and all 7 parser cases. The tested release file was `dist/arxiv-discovery.user.js`, with SHA-256 `9e225b440f61eae184c12156759002283158e4926856a3283f11f5f97d588d65`. On the supplied 26 November 2026 listing, the script attached 701 collapsed disclosures, filtered the original list to 30 distinct papers, and restored all 701 entries.

Separate visual checks used a locally served arXiv stylesheet and MathJax 2.7.3 with the same supplied HTML. Captures at 1440 × 750 and 390 × 844 showed the collapsed disclosures, the expanded paper actions, the daily filter, and an example AI answer beneath its paper. At phone width the inline answer and Settings dialog each fit without horizontal scrolling.

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
| Userscript in Chromium | First use, finite unique selections, mode changes, replacing and restoring a paper, daily history, structural preservation and menu restoration, refresh and process restart, explicit feedback and reversal, bookmarks, name-only follows, knowledge, backup import, complete deletion and subsequent saves, dialogs at phone width, inline explanations and recursive dictionary selection, cached responses, provider failures, and native navigation for incomplete listings. |

The full-fixture case first checks that the add-on puts one collapsed **Discovery tools** disclosure at the end of each native paper description. It checks for the absence of a toolbar, duplicated paper cards, a startup dialog, and a filter on first use. It opens the daily selection from a paper's own controls and verifies that the visible `dt` and `dd` pairs stay in their original order.

The DOM comparison removes the add-on's own hosts from a detached clone and compares the remaining markup to the exact original. During a filter it permits the temporary `hidden` attributes on native paper rows. It checks the original elements' identity, parentage and sample typography throughout. Restoring the listing must restore prior attribute values, including `hidden="until-found"`. The full removal check refreshes the page and reopens the add-on through its registered menu.

Most integration cases open only the add-on's shadow roots for Playwright inspection. The startup and focused-input keyboard cases retain the production closed roots. Clicks, keys, and dictionary double-clicks use browser input. Persistent storage is a test double backed by local storage in a disposable profile. Browser restarts exercise this profile with a fresh browser process. Package-manager updates, the Tampermonkey installation prompt, its permission UI, persistence through a Tampermonkey upgrade, real arXiv serving behavior, and live model output need their respective environments for verification.

Browser tests use a restrictive content security policy and intercept every route. They block the fixture's original remote styles, fonts, scripts, and images. The phone-width check verifies the add-on dialog fits its viewport. Live arXiv typography and remote MathJax presentation require a browser installation on the site.

## Check an installed copy

1. Install the release userscript in Tampermonkey, then open the mathematics new-listing page. Check the normal paper links, pager, keyboard focus and original page order.
2. Expand **Discovery tools** under a paper, open **More tools**, and choose **Daily selection**. Record a few identifiers from the native listing. Choose **Show all papers**, refresh, and reopen the daily selection. Compare the visible paper identifiers.
3. Use the controls under one paper to bookmark it and record feedback. Restart the browser and check both records through the Tampermonkey menu. With AI configured, highlight a term and confirm the explanation appears underneath that paper.
4. Choose **Original arXiv** and confirm the added controls disappear. Reopen through **Show arXiv Discovery** in the Tampermonkey menu.
5. When verifying an upgrade, export a backup, update the installed userscript in place, and compare the retained selection and records. Record the browser, Tampermonkey and userscript versions.
