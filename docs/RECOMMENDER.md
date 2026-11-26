# Local recommendations and discovery

Discovery uses papers from the displayed announcement date. A paper qualifies through its primary or secondary mathematics classification. New submissions qualify by default. Cross-submissions and replacements have independent switches. A date with fewer eligible subjects yields a shorter category feed.

## Selection modes

| Mode | How the selection is made |
| --- | --- |
| Pure Random | Shuffle each category's eligible papers with equal initial priority. Randomize category order and find a maximum matching between categories and distinct papers. |
| Balanced Exploration | Use the same matching. For each category, the exploration setting gives the chance of shuffling uniformly. Otherwise draw a weighted ordering from local model scores. Without ratings or an enabled subscription signal, priorities are uniform. |
| Personalized | Draw the requested number of distinct papers, between 1 and 32, from the available pool using learned weights. Without eligible preferences, cover as many categories as possible, randomly subsample those assignments when the requested count is smaller, and uniformly fill spare slots when it is larger. |
| Discovery | Favor topics, techniques, categories, and author labels with fewer previous encounters while maximizing category coverage. An encounter is a manually marked read or an eligible rated paper. A repeated paper has lower novelty. An empty encounter history gives a uniform initial ordering. |
| Subscriptions | Show all eligible papers matching an explicitly followed researcher. Matching stable author identifiers take precedence. Name-only matching requires explicit confirmation and an exact normalized name, including accents and initials. A confirmed name can still refer to several people. |
| Original arXiv | Return to the original listing. The recommendation module produces no entries. |

The optional subscription preference switch doubles the selection weight of a matching paper in Balanced Exploration and Personalized. Other papers retain their weights. A subscription does not generate a synthetic rating. Discovery counts repeated names when stable author IDs are missing, so its author familiarity measure is approximate.

### Matching and probabilities

The seeded pseudorandom generator shuffles a canonical ordering of paper identifiers. Fisher–Yates uses bounded integer draws with rejection sampling. A randomized augmenting-path search finds the maximum number of represented categories. If two categories share one eligible paper, only one can receive it. If one category has an exclusive alternative, the search can reassign papers to represent both. The missing-category reason identifies an empty pool, a disabled section, or a matching conflict.

Equal initial priorities and final inclusion probabilities answer different questions. Suppose category A has candidates X and Y while B can use only X. A must receive Y and B must receive X to represent both categories, regardless of the first draw. The feed records a numerical probability when the mechanism gives a directly computable inclusion probability. For a weighted draw of one paper in an isolated category, this equals the mixture of its uniform and weighted first-choice probabilities. Unknown inclusion probabilities, including cross-list matching and general weighted multi-paper draws, are recorded as `null`.

Replacing a paper first looks for an unused eligible candidate for its slot. A cross-list reassignment can preserve all other selected paper IDs and category coverage when a direct replacement is impossible. Reassigned entries carry an explanation. A replacement draw records its conditional probability when available. The original selection and its revisions belong to the storage layer.

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

Run `node --test tests/recommender.test.js tests/sampling.test.js` from the repository root. The suite includes semantic generalization within one subject, history boundaries and correction semantics, 2,400 seeded uniform draws and exhaustive comparison with the true maximum on every three-category, three-paper eligibility graph.
