# Changelog

## 1.3.1

- Reduce work on long listings by sharing the paper controls' stylesheet and creating the contents of **More tools** only when opened.
- Retain the Gemini bridge, mathematical rendering, feeds and saved data from earlier versions.

## 1.3.0

The research feeds were merged into `main`, building on adaptive category sampling and version 1.2.5's Gemini and math-rendering support.

- Add all ten feed choices within the existing additive arXiv interface, reusing native rows, paper actions, the interest model, subscriptions and bookmarks.
- Add complete multi-date Recent ingestion, validated source positions and cohort boundaries, normalized deduplication and restart-safe public population caching.
- Preserve Today’s pinned selections and square-root quotas from version 1.2.0.
- Add independent single-metric Trending, explicit quality gates, shared ranking ties, evidence disclosures and a cumulative-only Rising boundary.
- Add normalized provider adapters, reproducible full-population experiments, separate snapshot history and offline hash-verified replay.
- Record the live OpenAIRE census: 6/2,555 Recent and 179/701 Today metadata matches, with zero available views/downloads in either population. No provider is selected automatically.
- Add explicit AI Highlight assessment with source evidence and existing consent, spending and spoiler controls.
- Retain upstream Gemini support, protected-answer cache invalidation, stronger spoiler filtering and math rendering; extend the local structured-output schema for Highlight decisions.
- Preserve bookmarked paper versions and rich metadata independently of sparse Recent listings, with legacy migration, backup compatibility and original-row restoration.
- Extend settings, private backup compatibility, data deletion, diagnostics and tests. Add `arxiv.org` permission solely for requested listing pagination; retain the numeric-loopback AI bridge.

## 1.2.5 — integrated upstream baseline

Gemini provider support, strengthened protected-answer filtering and cache invalidation, local structured-output constraints and improved mathematical rendering, including bare equations with derivative notation. Retained from upstream commits `13387d6f8ed529d2a422951dcda1ab513cc5072e` and `65802c20f991c8ded25f1567c4fc80fad951d0a2`.

## 1.2.0 — original baseline

Adaptive square-root category quotas for Pure Random and Balanced Exploration; global Personalized draw; saved distribution metadata and backward-compatible pinned selection history. See the baseline commit and existing sampling documentation.
