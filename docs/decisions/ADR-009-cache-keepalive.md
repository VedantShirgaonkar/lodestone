# ADR-009: Switch-back keepalive — explicit-intent TTL refresh pings, never automatic

**Status:** accepted · 2026-07-12

## Context
The only sanctioned cache "manipulation" is TTL refresh: any cache hit resets the clock, free (official docs). Subscription sessions run the 1h tier. When a user switches personal→work intending to return, account A's cache dies after 1h idle and the return turn costs ~2×C. A periodic tiny resume ping on A (~0.1×C weighted each) keeps it warm. Prior art exists for the API 5m tier (claude-code-cache-keepalive plugin, cline-keep-alive).

## Decision
`cchandoff switch <target> --keep-warm <duration>` (and standalone `cchandoff keepalive <profile> [--for <duration>]`):
- Schedules pings on the SOURCE profile at 52-minute intervals for the stated duration, via `claude -p --resume <session> --fork-session --max-turns 1` under that profile's env (discard output; `--no-session-persistence` when supported).
- Hard rules: never enabled by default or by config alone — requires the explicit flag each time; default cap 3 pings; each ping prints its estimated weighted-token cost before running; skipped (with notice) when the source profile's 5h window exceeds a threshold (default 80%) or the weekly cap is the binding constraint; `cchandoff keepalive --stop` cancels.
- Break-even math shown to the user: ping ≈ 0.1×C, cold return ≈ 2×C → worth it whenever return within `duration` is more likely than ~5%.

## Consequences
- Scheduling: v1 uses a detached local process with a pidfile under `~/.config/cchandoff/` (no daemons, no cron edits); survives only while the machine is awake — documented.
- Must be empirically validated in live validation (JSONL: ping turns show `cache_read ≈ C`, tiny writes, 1h tier) before the README may claim it.
- If Anthropic ever bills TTL refreshes or drops the subscription 1h tier, the feature degrades to a no-op with a warning — isolated behind one module.
