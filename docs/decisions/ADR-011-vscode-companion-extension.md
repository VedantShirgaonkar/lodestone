# ADR-011: warmswap VS Code companion extension — one status-bar item, markdown popover, QuickPick actions, zero webviews

**Status:** accepted · 2026-07-12

## Context
The official Claude Code VS Code extension runs the same engine (hooks, skills, advisor all work there) but **does not execute custom statuslines** (anthropics/claude-code #55643, #20207, #11165, #21265) — so inside VS Code, users get no live quota/cache visibility from us. Community tools bridge this via a cache file written by the CLI statusline and read by a VS Code extension — the exact file bridge warmswap already has (`usage-cache.json`). The user requires the monitoring features (handoff intimation, cache-TTL countdown, savings) to be present in the VS Code UX, one-click usable, and shippable to other users.

## Decision
A companion extension living in `vscode/` in the same repo, deliberately thin (one brain — the CLI; several faces):
- **UI = one StatusBarItem** (right side): `⇄ <profile> 5h 24% · wk 25%`, warning background when any profile crosses advisor thresholds; **tooltip = MarkdownString popover** with per-profile quota bars (live/est labeled), reset countdowns, per-project cache-TTL countdowns, total savings from `audit --json`, and the advisor line. **Click = QuickPick** menu: Handoff & Switch (target picker → runs `warmswap switch <t>` in the integrated terminal), Keep Warm, Open Dash, Refresh, Toggle real usage. No webview in v1 — native theming, tiny surface, marketplace-friendly.
- **Data**: reads warmswap's config + per-profile `usage-cache.json` (fs.watch + 30s fallback timer); shells `warmswap status --json` / `audit --json` at most once per 60s; all real-vs-estimate labels passed through. If the CLI is missing, the item degrades to an install hint.
- **Packaging**: tsc-only build, zero runtime deps (`@types/vscode`, `typescript` devDeps), `engines.vscode ^1.85`, `vsce package` → `.vsix` (manual install works immediately); marketplace publish is the user's action with their publisher account, same as npm.
- **Tests**: the tooltip/model builder is a pure module unit-tested with node:test; the VS Code shell is thin enough to review by hand. CI gains a compile job.

## Consequences
- In official-extension sessions the statusline never runs, so the bridge file isn't refreshed by those sessions; real data there comes from the (opt-in) OAuth layer or estimates — the extension states which it is showing.
- The extension must never fork logic from the CLI; any figure it can't get from JSON contracts is a CLI feature request first.
