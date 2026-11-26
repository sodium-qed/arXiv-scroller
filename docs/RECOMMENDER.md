# Local recommendations and discovery

Selections use papers from the displayed announcement date. A paper qualifies through its primary or secondary mathematics classification. New submissions qualify by default. Cross-submissions and replacements have independent switches. Duplicate paper IDs are merged before eligible counts or quotas are calculated, preserving their mathematics classifications and the newest observed eligible version. The selected size follows the eligible category counts and cross-list overlap for that date.

## Selection modes

| Mode | How the selection is made |
| --- | --- |
| Pure Random | Calculate square-root quotas, shuffle each category's eligible papers uniformly and fill distinct-paper slots with maximum category coverage first. Ignore ratings, reading history and author preferences. |
| Balanced Exploration | Use the same quotas and matching. For each category, the exploration setting gives the chance of shuffling uniformly (25% by default). Otherwise draw the existing weighted ordering from local model scores. Without ratings or an enabled subscription signal, priorities are uniform. Interests affect priorities within a category, never its quota. |
| Personalized | Draw 50 papers by default, configurable from 1 to 200 and limited by the eligible pool. Use one global weighted permutation without replacement and take the requested number; impose no category quotas. Without eligible preferences, use one global uniform shuffle. |
| Discovery | Keep one slot per nonempty category. Favor topics, techniques, categories, and author labels with fewer previous encounters while maximizing category coverage. An encounter is a manually marked read or an eligible rated paper. A repeated paper has lower novelty. An empty encounter history gives a uniform initial ordering. |
| Subscriptions | Show all eligible papers matching an explicitly followed researcher. Matching stable author identifiers take precedence. Name-only matching requires explicit confirmation and an exact normalized name, including accents and initials. A confirmed name can still refer to several people. |
| Original arXiv | Return to the original listing. The recommendation module produces no entries. |

The optional subscription preference switch doubles the selection weight of a matching paper in Balanced Exploration and Personalized. Other papers retain their weights. A subscription does not generate a synthetic rating. Discovery counts repeated names when stable author IDs are missing, so its author familiarity measure is approximate.

## Adaptive category quotas

For Random and Balanced, let `N_c` be the number of distinct eligible papers whose classifications contain category `c`. Both primary and secondary mathematics classifications count toward eligibility. Define

$$q_c = \lceil\sqrt{N_c}\rceil, \qquad Q = \sum_c q_c.$$

`N_c = 0` gives zero slots. Every nonempty category has at least one slot. The daily target `Q` follows from the distribution; the Personalized size setting does not limit it. A category's growth is sublinear: more active subjects receive more slots while smaller subjects retain representation whenever a distinct-paper assignment makes that possible.

| Eligible papers | Square-root quota |
| ---: | ---: |
| 0 | 0 |
| 1 | 1 |
| 2–4 | 2 |
| 5–9 | 3 |
| 10–16 | 4 |
| 25 | 5 |
| 100 | 10 |
| 400 | 20 |

For disjoint category pools of 1, 9 and 100 papers, the target is `1 + 3 + 10 = 14`, and all quotas can be filled. When two categories both contain the same three papers, each quota is 2, so the target is 4 but only 3 distinct papers exist. The selection represents both categories, fills 3 slots and reports a shortfall of 1. It never adds a duplicate or silently lowers the target.

### Distribution and explanations

New category selections save each category's eligible count, calculated square-root quota, applied quota, actual assigned count and shortage or empty-pool reason. Random and Balanced apply the square-root quota. Discovery displays the calculated square-root value for comparison but applies its existing zero/one quota. The status and **Daily selection → Category distribution** show the automatic target, selected count and shortfall.

An eligible cross-listed paper contributes to several eligible counts but fills only one assigned slot. Actual assigned counts therefore sum to the number of unique selected papers. This differs from the analytics dashboard, where one reviewed paper can contribute to several subject rows. Empty categories have quota zero; an empty-pool explanation is informational and does not add to the shortfall. Disabled-section and incomplete-listing diagnostics remain available. The application requires a complete dated announcement before creating a daily draw.

**Why this paper?** names the applicable quota, pool size, random or weighted priority, and the role of cross-list matching. Balanced explains the exploration branch and model or followed-author influence where applicable. Personalized explains its global draw without category quotas. The saved rationale remains attached to that selection even if the interest profile later changes.

### Matching algorithm and correctness

Conceptually, expand each category `c` into `q_c` identical slots, with an edge from each slot to each of its eligible papers. Papers have capacity one. The algorithm uses augmenting paths in this bipartite graph, with the following priorities:

1. Match one coverage slot per nonempty category, in seeded randomized category order.
2. Add the remaining quota slots and augment the matching to fill as many as possible.
3. Search candidate edges in the applicable seeded random or weighted priority order, allowing reassignment when coverage or total capacity requires it.

**Why coverage is maximal.** The first phase is a maximum matching between categories and papers. An augmenting path flips matched and unmatched edges, adding one matched slot without leaving any previously matched slot empty. At the end of the phase, no additional category can be represented: otherwise the symmetric difference with a larger matching would contain an augmenting path.

**Why the total filled count is maximal.** The second phase extends that matching to the full slot graph. The same augmenting-path argument reaches maximum cardinality. Each successful path keeps every previously occupied slot occupied, so the first phase's maximum category breadth is retained. If a final assignment represented more categories, taking one assigned paper from each would contradict the first phase's maximum. Thus the result maximizes breadth and the number of fulfilled quota slots together. It is not necessary to sacrifice category coverage to fill the maximum number of slots.

Slots belonging to one category have identical eligible neighbors. The implementation shares one candidate ranking per category and tracks its assigned papers, rather than materializing every slot-to-paper edge. A search can visit each category at most once: reaching any slot of that category makes the same outgoing candidate set available. This keeps recursive search depth bounded by the 32-category taxonomy, including on unusually large announcements.

One pass over the available slots is sufficient with augmenting paths: after processing any prefix, the current matching is maximum for that prefix. Adding one new slot can increase the optimum by at most one; the augmenting search finds that increase whenever it exists. A failed search is a genuine capacity conflict, not a greedy failure to consider cross-list reassignment.

More generally, a group of categories cannot fill more slots than the number of distinct papers in the union of its eligible pools. Full quota satisfaction is possible exactly when every category group has enough distinct candidates for the sum of its quotas. Individual row counts alone cannot establish that condition. The distribution reports unfilled slots caused by these overlaps.

Candidate priorities guide which maximum assignment is chosen. The algorithm does not claim to minimize a global sum of ranks or to sample uniformly from all feasible maximum matchings. Meeting the first two priorities may move a paper away from the category where it initially ranked highest.

### Randomness and recorded probabilities

The seeded pseudorandom generator starts from a canonical ordering of paper identifiers. Fisher–Yates uses bounded integer draws with rejection sampling. An isolated category with `N` candidates and quota `q` receives a uniform `q`-element subset in Pure Random. Balanced preserves its existing mixture: one branch per category chooses a uniform permutation with probability equal to the configured exploration fraction, otherwise a weighted permutation. The realized fraction of papers attributed to random exploration need not equal the setting exactly in a single finite draw.

Weighted permutations use independent exponential clocks, `-log(U) / weight`, then order by increasing clock time. The existing weight is `exp(5 * (prediction - 0.5))`, with a default prediction of 0.5 where no model estimate exists and an optional factor of 2 for a followed-author match. Discovery retains its existing novelty weight. Personalized applies the same weighted sampling to the complete eligible pool instead of separate categories.

Equal initial priorities and final inclusion probabilities answer different questions. If category A has candidates X and Y while B can use only X, category coverage can force B to receive X regardless of A's random priority. With several slots, overlapping pools create additional constraints. The saved probability is numerical only when directly justified:

- For a uniform draw in an isolated category, inclusion is `q / N`; selecting the entire eligible category gives probability 1.
- For one weighted slot in an isolated category, inclusion equals its uniform/weighted first-choice mixture.
- For a global uniform Personalized draw, inclusion is `selectedCount / eligiblePoolSize`; a full-pool draw gives 1.
- For a single global weighted draw, the normalized weight is available.
- General weighted multi-paper and cross-list matching marginals are unavailable and recorded as `null`.

The exploration percentage and the model score are not final inclusion probabilities. The implementation withholds a number whenever matching or multi-paper weighting makes the simple formula inapplicable.

### Replacement and historical selections

Replacing a paper first looks for an unused eligible candidate for its assigned slot. If no direct candidate exists, a cross-list augmenting path can retain all other selected paper IDs while changing their category assignments and adding one replacement. The same mechanism supports multiple occupied slots in a category. It preserves each category's assigned count and any existing shortfall. Reassigned entries carry an explanation; a direct replacement records its conditional single-draw probability when available. Replacement never duplicates a selected paper or overwrites the original saved draw.

An upgrade does not regenerate historical selections. Saved originals, current draws, revisions, seeds and explanations remain pinned until an explicit change. Distribution statistics are optional generation-time snapshots; the interface identifies older records without reconstructing their quotas from today's pool. Existing JSON backups and explicit Personalized count preferences remain valid. Changing the Personalized count does not create a new Random, Balanced or Discovery selection for a date with a saved draw.

## What the model learns

`src/recommender.js` fits an L2-regularized binary logistic classifier entirely on the device. A like supplies outcome 1 and a dislike supplies 0. Optional feedback reasons remain available to the reader. Background requests, neutral feedback, removals, reading duration, glossary visits, bookmarks, and knowledge levels supply no training labels. With zero active labels, inference returns `null`.

The content embedding has four sparse coordinate groups.

| Group | Representation | L2 scale |
| --- | --- | --- |
| Words | Normalized title and abstract words with logarithmic frequency weighting | 1.35 |
| Phrases | Consecutive pairs of retained words | 0.95 |
| Mathematical concepts | Shared coordinates for recognized mathematical expressions, including AM–GM and the arithmetic–geometric mean inequality | 1.85 |
| Subjects | Normalized mathematics classifications | 0.45 |

Each nonempty group is independently normalized. Title occurrences have triple the raw frequency weight of abstract occurrences. The lexical encoder uses up to 96 retained title words and 576 retained abstract words. Concept matching examines up to 2,000 title characters and 16,000 abstract characters. These limits apply to the embedding only. The interface keeps the original paper text.

The semantic vocabulary covers selected concepts and techniques across mathematical fields. Words and phrases supply features for additional topics. Unknown title phrases also appear in topic counts. The encoder does not understand every mathematical synonym, symbol, language, or claim. Two papers sharing a subject code can receive different scores because their text and concept coordinates differ.

The fit minimizes average logistic loss with weight penalty coefficient 0.22 and intercept penalty coefficient 1.25. Batch gradient descent performs up to 72 iterations with a norm-based step size. Rebuilding uses a stable order of active paper identifiers. Inference applies the sigmoid to the learned linear score. Model scores influence ordering through an exponential weight, and weighted sampling uses independent exponential clocks. A score is an uncalibrated interest estimate. A few examples or a single outcome class can move scores without establishing reliable preferences.

Content embeddings are memoized by paper object and checked against its current text and categories. The serializable `paperFeatures(paper)` result includes an embedding schema and coordinate-weight pairs. A model rebuild encodes each stored paper snapshot itself so imported feature payloads cannot override the meaning of its rating. Learned weights stay in memory. The encoder, fitter and inference functions can be replaced together behind `trainModel`, `predict`, `paperFeatures` and `conceptTerms`. The sampler consumes model scores independently of the classifier's implementation.

## Which ratings count

Resolve the latest revision per paper before applying any exclusion. A revision supersedes the event it names, including when the device clock moves backward. Independent branches use timestamp order and then append order for ties. Editing, removing, or excluding the latest event cannot revive an older rating.

| History setting | Eligible times |
| --- | --- |
| All | Every current like or dislike that passes the other controls |
| None | No ratings |
| Last X days | The trailing X periods of 24 hours through the current instant, including the cutoff |
| Ignore last X days | Times strictly before that cutoff |
| Ignore before a date | The selected UTC day and later |
| Ignore after a date | The selected UTC day and earlier |
| Exclude a date range | Times outside both inclusive UTC day boundaries |
| Reset interests | Feedback strictly newer than the reset instant |

Individual event exclusions and the Pure Random training switch also apply. Active and excluded counts refer to current likes and dislikes with these filters applied. Neutral, background, removed, and superseded events do not contribute to either example count. Restoring the profile re-enables retained data under the selected settings. Permanent deletion removes a paper's revisions and a fresh fit removes their contribution from the active model.

## Reading the analytics

- **Reviewed** counts distinct papers with a manual read or a current nonremoved rating, including neutral and background responses. A paper cross-listed in two categories contributes to both category rows and once to the overall count.
- **Observed like share** is likes divided by likes plus dislikes for the category in the chosen period. It uses recorded current ratings, including temporarily excluded examples. The dashboard withholds this estimate below three outcomes. The 95% Wilson interval summarizes binomial sampling uncertainty. The reader's self-selected reviews can still differ from a representative sample of the field.
- **Model score** averages current predictions on locally known papers announced in the chosen range. Reporting requires at least three active examples globally and both outcome classes. The number of scored papers is distinct from the number of labels. The displayed date range restricts observations and papers. The training-history controls determine the model.
- **History** groups current ratings and manual reads by UTC month, with a subject breakdown. Reviewed papers are counted once per month. A later correction replaces the older rating in historical charts. Reviewing the same paper in another month can place it in both monthly review counts.
- **Liked concepts** count a label once per liked paper. **Investigated terms** count dated glossary visits and combine the same normalized term across papers. For a legacy counter without individual visit dates, a date-limited report can credit only its last recorded visit.
- **Knowledge changes** use explicit level edits within the selected period. Reading records, followed publications, and glossary investigations describe activity independently of the interest classifier.

Run `npm test` from the repository root. Sampler regressions check the two matching objectives against independent exhaustive optima on small eligibility graphs, uniform and weighted multi-slot behavior, duplicate prevention, empty and uneven pools, replacements, stable seeds and unusually large announcements. Model regressions cover semantic generalization within one subject, history boundaries and correction semantics. See [testing and verification](TESTING.md) for the complete release evidence.
