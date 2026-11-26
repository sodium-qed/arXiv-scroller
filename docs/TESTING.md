# Testing arXiv Discovery

The browser suites use the supplied mathematics announcement and generated, clearly labeled fixtures. They intercept requests before navigation and exercise the production parser or the built userscript. No tests require arXiv availability, a hosted AI account, a pairing credential, or a paid request.

## Verified release 1.1.1

Chromium 152.0.7977.0 with Playwright 1.62.0 passed all 16 userscript integration cases and all 7 parser cases. The tested release file was `dist/arxiv-discovery.user.js`, with SHA-256 `e3dd0186e4275375528af28cf10e0d3939825d47f8b287c72d38902daf67150f`. On the supplied 26 November 2026 listing, all 701 papers had inline tools on first use. A daily selection showed 30 distinct papers in their published order. Choosing **Show all papers** restored all 701 entries.

At a 390 × 844 viewport, the browser test locates **Settings** to the right of the listing heading and above the first paper. It opens the dialog with Enter, closes it with Escape, and checks that focus returns to the button. The dialog fits the viewport without horizontal scrolling.

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
| Userscript in Chromium | Direct paper actions, the page-level Settings button, toggling tools, recommendation modes, finite unique selections, replacing and restoring a paper, daily history, structural preservation and menu restoration, refresh and process restart, explicit feedback and reversal, bookmarks, name-only follows, knowledge, backup import, complete deletion and subsequent saves, dialogs at phone width, inline explanations and recursive dictionary selection, cached responses, provider failures, and native navigation for incomplete listings. |

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
