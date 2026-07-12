# ADR-007: Real quota data — native statusline feed first; opt-in OAuth endpoint for cross-profile views

**Status:** accepted · 2026-07-12

## Context
User requires real usage data (5h/weekly %, resets) for the meter, advisor, and UI — "real data from /usage", not estimates. Two sources exist: (A) Claude Code natively passes `rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}` into statusline stdin for subscribers — real, free, zero credential access, but only while that profile has a live session; (B) undocumented `api.anthropic.com/api/oauth/usage` (Bearer token from Keychain/credentials.json + `anthropic-beta: oauth-2025-04-20` + claude-code User-Agent) — works any time, per profile, returns the full schema incl. model-specific weekly caps and extra-usage, but requires reading the OAuth token and is unofficial (aggressive 429s without discipline).

## Decision
1. **In-session surfaces (statusline, advisor hook) use Source A.** Our statusline persists each render's `rate_limits` to `<configDir>/warmswap/usage-cache.json` (a file bridge) so hooks and CLI can reuse fresh real data without any API call.
2. **Cross-profile quota (status/dash/extension) uses Source B, strictly opt-in** (`warmswap config set realUsage on`, per-profile consent messaging). Implementation rules: read token via OS keychain/credentials file for that profile only; token never written anywhere, never sent anywhere except api.anthropic.com over TLS; responses cached ≥180s with file locking; one retry max on 429 then degrade.
3. **JSONL estimation remains the always-available fallback** and the only source for pre-2.1.x versions or API-key auth; every estimated figure stays labeled `est`, real figures labeled from source.

This amends ADR-002's "never touch credentials" to: **never store, copy, migrate, or transmit credentials; read-only local use of the user's own token for the user's own usage endpoint is permitted behind explicit opt-in.** SECURITY.md must state this exactly.

## Consequences
- The flagship differentiator (both accounts' real quotas side-by-side + switch advice) becomes possible; nobody in the surveyed ecosystem does it.
- Endpoint volatility is contained: Source B failures degrade to Source A + estimates, never break commands.
