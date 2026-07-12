# Research: VS Code Marketplace + npm discoverability

> 2026-07-13. Goal: maximum honest footfall for the extension and package. Reality check first: Microsoft does not disclose the marketplace ranking algorithm (microsoft/vscode-discussions #99 — authors asked, team deflected). Everything below is the stable practitioner consensus + documented mechanics, not gospel.

## What is actually known

- Searched/weighted fields: extension `name`, `displayName`, `description`, `keywords` (tags), and contributed `commands` titles. Default "relevance" sort blends text match with install count and rating; users can re-sort by installs/rating/recency. Categories and tags are filterable facets.
- Install count + average rating dominate visibility once past the text-match stage → early reviews matter more than any metadata tweak.
- Marketplace caps package.json `keywords` at 30; only the first few carry visible weight in the listing UI.

## The playbook we apply (all honest, no keyword stuffing)

1. **displayName carries the top search phrase**: users type "claude code usage", "claude quota", "claude limits". Pattern: `<Name> — Claude Code usage, cache & account switching`. The product name alone is undiscoverable; the suffix is the SEO.
2. **First sentence of `description` = the search snippet**: one sentence, plain, containing "Claude Code", "usage limits", "5-hour", "cache", "switch accounts". No marketing fluff — the snippet is also what the results list shows.
3. **Keywords (~10, deduplicated with name/description)**: claude, claude-code, anthropic, usage, quota, rate-limit, 5-hour, prompt-cache, handoff, account-switch.
4. **Command titles are searchable**: keep them descriptive ("warmswap: Handoff & Switch Account") — already done.
5. **Listing visuals decide click-through**: 128×128 icon (required for non-default branding), gallery banner color, and at least one screenshot/GIF of the popover + statusbar in the README top. Marketplace renders README as the listing page — the first screenful must show the popover image, the one-line value, install command, and the "works with the official Claude Code extension" line.
6. **Trust signals**: repository/homepage/bugs links present, LICENSE bundled, Q&A enabled (default), CHANGELOG maintained, no `preview: true`. Verified-publisher domain later if the user has one (optional).
7. **Badges** (shields.io installs/rating/version) at README top — social proof once numbers exist.
8. **Category**: "Other" (+"Visualization" debatable; stay with Other — miscategorization hurts trust).
9. **Pre-release channel**: use `vsce publish --pre-release` for early iterations (odd minor versions), promoting to release when validated — documented mechanism, keeps ratings clean during churn.
10. **npm side**: same first-sentence discipline in `description`; keywords already set; README top mirrors the listing structure. npm search weights name/description/keywords + download momentum; nothing else controllable.

## Launch-footfall reality (beyond metadata)

Metadata gets you found for exact queries; distribution gets you installs: the launch post (explainer + measured 96% number), Show HN, r/ClaudeAI, the awesome-claude-code list (PR after publish), and cross-linking npm ↔ marketplace ↔ repo. The measured-savings screenshot is the single best asset for all of these.

## Name-gate note

All listing copy is written around a placeholder token so the user's final name choice (shortlist verified free on npm + marketplace 2026-07-13: warmswap · batonpass · contextcarry; ccswap dropped — existing juanmackie/ccswap project) drops in with one sweep. Nothing publishes before explicit user confirmation of the name.
