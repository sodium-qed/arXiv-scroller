# Local data and backup schema

The portable JSON envelope contains `format` equal to `arxiv-discovery`, numeric `schemaVersion` equal to `1`, an ISO export time and a `state` object. Import accepts this schema and fills omitted collections with empty defaults. The import merges supplied record keys and replaces settings. A future schema is refused before any write.

## Personal collections

| State field | Key | Record |
| --- | --- | --- |
| `settings` | One object | Recommendation mode, eligibility, exploration fraction, personalized count, training controls, theme, added controls, global and per-paper spoiler settings, and optional AI configuration. |
| `papers` | Versionless arXiv ID | Current metadata with observed version, canonical links, title, abstract, author identities, subjects, comments, journal reference, announcement date and submission section. |
| `events` | Array of unique `eventId` values | Paper ID and version, timestamp, value, reason, collection mode, selection probability when known, previous revision ID, individual exclusion, paper snapshot and optional versioned sparse feature vector. |
| `bookmarks` | Versionless paper ID | Time the bookmark was saved. |
| `reading` | Versionless paper ID | Time the reader explicitly marked the paper as read. |
| `subscriptions` | Array of unique `id` values | Author name, identity URL, optional stable identifier, creation time, private notes and explicit name-only confirmation. |
| `knowledge` | Topic text | Current level and update time, with an optional chronological list of explicit level changes. |
| `glossary` | Versioned paper ID and normalized selected term | Original term, paper ID, contextual answer, optional source, understanding status, visit count, last update and optional visit timestamps. |
| `selections` | Announcement date, mode, eligibility settings and listing archive | Original and current draws, prior revisions, creation time and optional paper snapshots for history and source links. Earlier records can have a key without an archive. |
| `explanations` | Paper ID, version and SHA-256 request fingerprint | Text, source kind and URL, disclosure, citations, saved time and optional reported usage. |

Papers use modern or legacy arXiv identifiers. A known version is a positive integer. Zero denotes an unknown version, so its versioned display identifier remains the bare ID. Standalone abstract and HTML pages can have a null announcement date or section. A dated listing records `new`, `cross` or `replacement`. Optional inline hyperlinks give UTF-16 start and end offsets into the corresponding text field. Link targets are validated independently of linked text.

Each draw records its date, mode, seed, unique paper entries and missing categories with reasons. An entry includes its paper, assigned category if applicable, explanation and an optional probability. Null represents an unavailable probability. The original draw stays available when regenerating or replacing one paper. Distinguishing listing archives gives the overall mathematics listing and subject-specific listings separate saved draws on the same date.

Release 1.2 adds optional sampling metadata to newly generated Random, Balanced and Discovery draws without changing the backup envelope or storage namespace. `samplingVersion: 2` identifies the new sampler. `targetSize` is the sum of applied quotas and `shortfall` is the target minus the number of distinct selected papers. `categoryDistribution` contains one row for each mathematics category:

| Field | Meaning |
| --- | --- |
| `category` | Canonical mathematics category code. |
| `eligibleCount` | Distinct eligible papers in that category at generation time. A cross-listed paper contributes to each of its eligible pools. |
| `squareRootQuota` | `ceil(sqrt(eligibleCount))`, including zero for an empty category. |
| `quota` | Applied quota: the square-root value in Random/Balanced, or zero/one in Discovery. |
| `selectedCount` | Papers assigned to this category's slots. Each selected paper is counted once across the distribution. |
| `reason` | An unmet-quota or empty-pool explanation; `null` when the nonempty quota is fulfilled. |

The schema validates the quota formula, row identities, assigned counts and aggregate totals. This metadata is a generation-time snapshot, not a live calculation from subsequently changed papers or preferences. Legacy selections without these optional fields remain valid and are not backfilled. Their current draw, original draw and revisions round-trip without changing membership or historical reasons. Personalized and Subscriptions do not gain category quotas.

The 1.0 release stored daily selections without their listing archive. Those records remain available under **Previous daily selections**, including their original draws and revisions. Version 1.1 creates a fresh first draw for each archive-specific key. Simultaneous first requests share the first saved draw. Reopening that draw reads the existing record without issuing a change notification to other tabs. An edit checks the current draw and revision count under the same lock before appending to the saved history. A reader whose tab holds an older revision can reopen the current selection and retry the change.

Version 1.2 uses an automatic-size key for new non-Personalized draws and reuses existing archive-specific records whose older key included a Personalized count. Changing the Personalized size therefore does not create a different Random, Balanced or Discovery draw for the same date, archive and eligibility settings. Personalized keys continue to distinguish configured sizes. Stored size preferences such as 32 remain intact; only missing settings receive the new default of 50.

## Revisions and learning

The event values are `like`, `dislike`, `background`, `neutral` and `removed`. Corrections append a new event whose `revisionOf` points to the current event for that paper. Explicit ancestry determines which revision wins even when the system clock moves backwards. For independent legacy branches, timestamp and deterministic event order resolve the current tip. A rating's content snapshot allows training to be rebuilt even if a later arXiv version changes its abstract.

Before filtering the history, the learner resolves one current event per paper. Only a current, eligible positive or negative event trains the classifier. Resetting interests records a cutoff. Restoring interests removes temporary exclusions. Permanent deletion removes every revision for the selected paper. Weights are derived in memory. The separately stored mathematical knowledge and personal reading collections retain their own deletion controls.

An import validates feedback references against the merged event set and rejects cycles, wrong-paper edges, conflicting paper identities and duplicate identifiers. Previously damaged local records are left in place and omitted from the running state with a warning in Settings. If an identifiable paper has a damaged revision chain, its whole history is excluded so an earlier rating cannot reappear.

## Persistence and recovery

Version 1 stores each personal record under a script-private manager key prefixed with `arxiv-discovery:v1:`. Settings and schema metadata use separate keys in the same namespace. Chrome Web Locks serialize cooperating tabs during storage operations. Distinct record keys prevent unrelated feedback events from overwriting each other. A revision notification prompts open instances to reload and rebuild their models.

Import checks the complete file before merging keyed records and replacing settings. A private recovery journal preserves overwritten data during the merge. On interruption, recovery restores the previous contents before a later operation reads them. Deletion records an intent with the keys to remove and finishes that intent before later reads. The journal is removed after successful recovery or commit. Complete erasure retains only fresh, opaque coordination markers in the personal namespace. A new AI write must match the data generation captured when its request started.

Public IndexedDB listing records contain a cache time and allowlisted public metadata. Only the checksum enters private manager storage. The public database is limited to validated listing fields. The bridge maintains an independent aggregate usage ledger and an in-memory source cache.

## Backup and import behavior

- The JSON file contains the personal collections, including free-text notes and saved explanations. The AI pairing token is blank, and AI generation and consent flags are false.
- Backup data is validated recursively, including archived and feedback paper snapshots. Unknown fields are discarded. Invalid supported fields, excessive nesting, unsafe keys and unsupported schema versions reject the import before writes.
- The file limit is 50,000,000 bytes. The maximum nesting depth is 30 and each top-level collection accepts up to 100,000 records. Calendar dates use real UTC calendar days. Personal timestamps include a timezone.
- Numeric settings are bounded. Exploration ranges from 0 to 1 and personalized selection size ranges from 1 to 200 papers, with a default of 50. Random and Balanced have no predetermined daily selection cap; their validated entries are bounded only by the existing record-safety limit and their calculated quotas. A per-paper spoiler override accepts a boolean. AI endpoints use `http://127.0.0.1` with an optional port. Browser and server ceilings both apply to live AI requests.
- Import merges records by key. Re-importing the same backup replaces the same keys. A revision can reference an existing event for that paper, so a partial backup can complete an existing chain. Missing collections contribute no new records.
- The transfer formats for reading and feedback are CSV. Bookmarks export as BibTeX. Those formats support external reading and reference tools. The JSON backup is the format used for restoration.
