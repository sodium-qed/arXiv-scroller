# arXiv Discovery

Read the usual arXiv listing with a row of actions beneath each abstract. You can rate a paper, bookmark it, mark it as read or request an AI overview directly from that row. Author follow controls appear just below it. Open **Settings** at the upper right to turn paper tools on or off and choose a recommendation mode.

## Feed expansion — development branch

Version 1.3.0 on `feature/trending` adds **Feeds** beside Settings: Today, Trending, Rising, For You, Discovery, Subscriptions, Highlights, Random, Recent and Saved. Today retains the existing adaptive daily sampler. Other research feeds use the complete official Recent population, including every pagination page. Saved keeps bookmarks from any date. Original arXiv rows retain their order; the feed index and keyboard navigation follow the chosen ranking. [Feed guide](docs/FEEDS.md)

[Install the feature/trending build](https://raw.githubusercontent.com/sodium-qed/arXiv-scroller/feature/trending/dist/arxiv-discovery.user.js). This is a branch build, not a published release. Updating the existing userscript retains its storage identity and private data. Tampermonkey may request permission for `arxiv.org` so the selected feed can retrieve missing listing pages; the optional AI bridge remains on numeric loopback. The ordinary installation link below still follows the stable `main` branch.

**Readership investigation:** the live full-population OpenAIRE experiment matched 6 of 2,555 Recent papers and 179 of 701 Today papers on 26 November 2026. It returned no `views` or `downloads` values for either population. Missing measurements were not converted to zero. Consequently, no provider is automatically selected and Trending reports insufficient data until imported observations pass its quality gates. Rising requires a documented cumulative counter and comparable history; none of the investigated counters qualifies. [Results and reproduction](docs/research/experiment-running.md) · [Provider comparison](docs/research/provider-comparison.md)

## Install in Chrome

1. Install **Tampermonkey** for Chrome. On Chrome 138 or later, open **Extensions → Manage Extensions → Tampermonkey → Details** and turn on **Allow User Scripts**. Tampermonkey documents the setting for older Chrome versions as well. [Get Tampermonkey](https://www.tampermonkey.net/) · [Userscript permission instructions](https://www.tampermonkey.net/faq.php?q=Q209)
2. Open the userscript link below and select **Install** in Tampermonkey. If the browser shows the source as text, open the Tampermonkey dashboard, create a new userscript, replace the editor contents with the entire packaged file and save it. [Install arXiv Discovery](https://raw.githubusercontent.com/sodium-qed/arXiv-scroller/main/dist/arxiv-discovery.user.js) · [Packaged file in this repository](dist/arxiv-discovery.user.js)
3. Reload the new mathematics listing. Look for **Like**, **Bookmark** and **Mark as read** under the first paper. Open **More tools** beneath a paper or use the Tampermonkey menu for reading history, saved selections and other commands. [Open the arXiv mathematics listing](https://arxiv.org/list/math/new)

The userscript is the entire browser application. Mathematics rendering runs locally. Python and an AI provider are optional.

## Use the reading tools

| Goal | Where to go |
| --- | --- |
| Read a daily selection | In **Settings**, choose a **Recommendation mode** and click **Show daily selection**. The matching arXiv entries stay in their original order. A small status beside the native pagination shows review progress. Each selected entry has **Why this paper?** and **Replace this paper** beneath it. On a partial page, use **Open complete arXiv listing**, then apply the selection again. |
| Change or revisit a selection | Open **Selection options** beside the status to change mode, regenerate the draw or restore its original members. **Previous selections** lists saved dates, modes and revisions with links back to the original papers. |
| Explore a topic or follow authors | The daily modes are **Pure Random**, **Balanced Exploration**, **Personalized**, **Discovery** and **Subscriptions**. A category filter lets you read the original entries in a particular subject. Settings control eligible sections, exploration, personalized size and optional author signals. |
| Give feedback | **Like** and **Dislike** train a local interest model. **Need background** records a comprehension difficulty. A reason is optional. You can change or clear a response on the paper. |
| Follow a researcher | Use **Follow** next to a name. Under **Authors**, check known publications, unread papers, notes and the saved identity. A name-only follow requires explicit confirmation. |
| Understand your history | **Interests** controls the training window, exclusions, reset, restoration and deletion. **Interests → Analytics** shows sample sizes, uncertainty and trends. **Knowledge** holds editable topic levels and your saved glossary. |
| Save or move data | **Bookmarks** links to the papers you saved and includes reading history and BibTeX export. **Settings** provides JSON backup and import, feedback CSV, and selective or complete deletion. A backup contains personal reading data and AI answers. |
| Return to all papers | **Show all papers** clears the filter and keeps each entry's tools available. To hide the tools as well, turn off **Enable paper tools** in **Settings**. This preference persists across reloads. Reopen **Settings** to turn them back on. |
| Remove all added controls | **Original arXiv** also removes the upper-right **Settings** button. Restore the add-on with **Show arXiv Discovery** in the Tampermonkey menu. |

Pure Random and Balanced Exploration calculate their daily size from the announcement. A category with `N` eligible papers receives `ceil(sqrt(N))` slots; an empty category receives zero. The target is the sum of these quotas across all 32 mathematics categories, with no fixed daily paper limit. A cross-listed paper can fill only one slot. The sampler first represents as many eligible categories as possible, then fills as many quota slots as possible.

| Mode | Daily size | Which papers fill the slots |
| --- | --- | --- |
| Pure Random | Automatically calculated square-root quotas | Uniform random priorities within each category; ratings and author preferences are ignored. |
| Balanced Exploration | The same square-root quotas | Existing interest-weighted priorities within each category, mixed with configurable random exploration (25% by default). Interests do not change quotas. |
| Personalized | 50 by default; configurable from 1 to 200, limited by the eligible pool | One global weighted draw without replacement; no category quotas. With no preference signal, the global draw is uniform. |
| Discovery | One slot per nonempty category | Existing novelty weights favor less familiar topics, categories and author labels. |
| Subscriptions | All eligible matches | Existing confirmed author-subscription matching. |

**Daily selection → Category distribution** shows each category's eligible count, calculated square-root quota, actual assigned count and any shortage reason. Discovery also shows its applied one-paper quota. The status reports the automatic target, selected count and any shortfall. Cross-list conflicts can make the full target impossible even when each category has enough candidates on its own; the same paper is never shown twice. **Why this paper?** explains the applied procedure without inventing inclusion probabilities. [Matching, examples and probability details](docs/RECOMMENDER.md#adaptive-category-quotas)

Changing the mode in **Settings** updates an active daily selection immediately. On the full listing, the choice applies the next time you request a daily selection. Refreshing shows the full listing again. Reopening the selection uses the saved draw for the same archive, announcement and settings. New feedback influences the next generation.

Upgrading preserves existing selections, revisions, ratings and other user data. A saved draw keeps its original membership and explanations until you explicitly regenerate or replace a paper. Older draws without a saved distribution are identified as historical; their quotas are not reconstructed from current data. Existing Personalized size preferences are retained, while new or omitted settings default to 50. Existing JSON backups remain supported.

Navigation uses **Alt+J** and **Alt+K**. On the current paper use **Alt+L** to like, **Alt+D** to dislike, **Alt+B** to toggle a bookmark and **Alt+R** to toggle its read mark.

## Optional AI

Daily selection, feedback, bookmarks, subscriptions and the knowledge editor work with AI disabled. To enable an overview or contextual dictionary, run the included bridge, pair it with the userscript and explicitly authorize a model in Settings. You can run a local OpenAI-compatible model or configure the hosted OpenAI API. Hosted use requires API billing and can incur charges. The bridge keeps the provider credential outside the browser.

Choose **AI overview** inside the paper's tools, or highlight a term in a supported title, abstract, HTML paper or previous answer and choose **Explain selection**. The answer appears with that paper, identifies its source as HTML, PDF or abstract, and links to available evidence. **No Spoilers** is on initially. You can change it globally or for an individual paper. [Bridge setup, disclosure and cost controls](docs/AI.md) · [Windows PowerShell setup](docs/AI.md#windows-powershell)

## Build and verify

The build uses Node.js 20 or later and its standard library. No package installation is needed for the browser bundle.

~~~sh
npm run build
npm test
python -m unittest discover -s tests -p 'test_bridge.py'
node scripts/replay-readership-experiment.mjs
~~~

The build writes `dist/arxiv-discovery.user.js`. The regression input is a lossless gzip copy of the supplied listing. Its manifest records the expected date, counts, size and uncompressed SHA-256. The optional Chromium suites exercise the parser and the built application with fixture responses. [Fixture manifest](fixtures/fixture-metadata.json) · [Test commands and verification scope](docs/TESTING.md)

## Documentation

- [Architecture and component boundaries](docs/ARCHITECTURE.md)
- [Listing ingestion, classification and pagination](docs/INGESTION.md)
- [Recommendation algorithm, sampling and analytics](docs/RECOMMENDER.md)
- [Data schema, backup format and recovery](docs/DATA_SCHEMA.md)
- [Privacy, security and permissions](docs/SECURITY.md)
- [AI provider and bridge configuration](docs/AI.md)
- [Requirements and acceptance coverage](docs/REQUIREMENTS.md)
- [Known limitations](docs/LIMITATIONS.md)
- [Feeds, settings and observation import](docs/FEEDS.md)
- [Provider investigation and complete-population measurements](docs/research/trending-data-sources.md)
- [Reproducible Trending and Rising methodology](docs/research/trending-methodology.md)

Independent project. Thank you to arXiv for use of its open access interoperability.
