# ADR-002: Account profiles = per-account CLAUDE_CONFIG_DIR, adopted in place; never touch credentials

**Status:** accepted · 2026-07-10

## Context
Two ways to switch accounts: `/login` inside one config dir (what the user did — shared history, but each switch orphans the other org's cache mid-conversation and invites accidental mid-session switches), or separate config dirs via `CLAUDE_CONFIG_DIR` (community-standard). Keychain entries are keyed by sha256(config dir) on macOS; `.credentials.json` lives inside the dir on Linux/Windows — so config-dir separation isolates auth completely.

## Decision
- One profile = one config dir. Registry in `~/.config/warmswap/config.json`.
- **Adopt the existing `~/.claude` as the first profile without moving it** — years of transcripts/settings stay valid; zero-risk onboarding.
- New profiles under `~/.claude-profiles/<name>/`. Login happens by launching `claude /login` under that env — **warmswap never reads, writes, copies, or migrates credentials or Keychain items.**
- Launching is `exec claude` with env set; everything else passes through.

## Consequences
- Each profile has separate settings/hooks → `warmswap init` must install hooks per profile (and re-run after adding profiles; doctor checks this).
- Auto memory is per config dir → optional `link-memory` feature sets a shared `autoMemoryDirectory` in each profile's settings so learnings cross accounts.
- `/login`-style mid-session switching becomes unnecessary; docs teach "one terminal = one profile".

## Alternatives rejected
- Keychain token juggling (fortunto2-style swap of credential items): fragile, security-sensitive, unnecessary given native env-var support.
- Symlinked shared `projects/` between profiles: entangles transcripts with the wrong org's usage math; breaks audit.
