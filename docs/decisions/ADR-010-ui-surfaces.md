# ADR-010: UI surface strategy — core CLI owns the data; statusline + dash TUI now; slim VS Code extension after core ships

**Status:** accepted · 2026-07-12

## Context
User wants a "beautiful monitoring small UI component" (reference: a VS Code statusbar Quota popover — 5h/weekly bars, share %, resets, "real data from /usage") plus cache-TTL countdown, rebuild-cost estimates relative to plan, and handoff intimation. Marketplace survey: ≥10 existing VS Code quota-bar extensions; none do profiles, cache countdowns, switch costs, or actions. Claude Code itself lives in terminals as much as VS Code.

## Decision
Data/presentation split: **all figures come from the core CLI** (`status --json` is the stable contract; statusline writes the usage-cache bridge). Surfaces in priority order:
1. **Statusline v2 (now):** native `rate_limits` + pacing marker + cache-warmth countdown + advisor glyph. Works in every terminal and inside VS Code's integrated terminal.
2. **`lodestone dash` (now):** live full-screen TUI (ANSI, zero deps, 1–2s refresh): per-profile real quota bars with resets and pacing, live sessions' context sizes + 1h-cache countdowns, switch-tax panel, advisor line, keepalive status. This IS the screenshot's popover, terminal-native, and works for both profiles.
3. **VS Code extension (after core + OSS launch):** separate `vscode/` package in-repo; statusbar item `⇄ 5h 24% · wk 25%` + webview popover mirroring dash; "Handoff & Switch" / "Keep warm" buttons shell out to the CLI; reads the same JSON contracts. Slim by design — it must never fork the logic.

## Consequences
- No Electron/menubar app; no web dashboard — rejected as maintenance sinks that duplicate surfaces users already have.
- The extension ships only after the CLI is published (it depends on a global `lodestone` install) — keeps launch scope honest.
- Crowded-market positioning: we enter VS Code as "the switch advisor," not "another quota bar."
