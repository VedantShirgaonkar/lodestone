# ADR-006: Name `warmswap`, npm distribution, MIT license, no telemetry

**Status:** accepted · 2026-07-10

## Context
Registry check (2026-07-10): `ccbaton`, `ccswitch`, `ccrelay`, `claude-baton` taken on npm; **`warmswap` free** (`batonpass` also free but non-descriptive). The cc* prefix is the recognized Claude-Code-tooling convention (ccusage, ccstatusline). "Handoff" is the exact term the community already uses for this pattern (multiple GitHub projects, feature request #11455).

## Decision
- npm package **`warmswap`**, bin `warmswap`. GitHub repo `warmswap` under the user's account.
- **MIT license** (ecosystem default, maximizes reuse).
- **No telemetry, no network calls.** Stated in README and SECURITY.md.
- Not an Anthropic product: README carries a clear "community tool, not affiliated" line, and avoids trademark-styled naming ("Claude" only descriptively).
- Release: `npm version` tags + GitHub Actions publishing on tag (provenance enabled); CHANGELOG.md kept by hand.

## Consequences
- Publishing requires the user's npm account + `gh repo create` — prepared by the assistant, executed by the user (outward-facing actions stay human-approved).

**2026-07-12:** renamed to `warmswap` at the user's direction (npm and VS Code marketplace names verified free); mechanics unchanged.
