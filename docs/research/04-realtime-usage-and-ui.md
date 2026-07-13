# Research: Real Usage Data, Advisor Triggers, and UI Surfaces

> Researched 2026-07-12, prompted by user feedback: "intimation a couple % before the limit", "beautiful monitoring UI", reference screenshot of a VS Code quota popover showing "Real data from Anthropic /usage".

## 1. Real quota data — two sources, layered by invasiveness

### Source A (zero credentials): native statusline `rate_limits`
Recent Claude Code versions pass REAL plan-quota data into every statusline render (official statusline docs):

```json
"rate_limits": {
  "five_hour": {"used_percentage": 23.5, "resets_at": 1738425600},
  "seven_day": {"used_percentage": 41.2, "resets_at": 1738857600}
}
```
- Present "only for Claude.ai subscribers (Pro/Max) after the first API response in the session"; each window independently absent — handle with `// empty` semantics.
- `resets_at` = Unix epoch seconds. This is the same data as `/usage`, delivered free, in-session, no auth. **Primary source for all in-session surfaces.**
- Upstream issues #34074/#36056 requested this; it shipped.

### Source B (opt-in, per-profile): `GET https://api.anthropic.com/api/oauth/usage`
Undocumented endpoint used by Claude Code itself and community tools (ohugonnot/claude-code-statusline, jtbr gist, multiple VS Code extensions). Needed only for **cross-profile** views (the other account's quota while it's not running a session) — the feature nobody else has.

- Headers: `Authorization: Bearer <oauth access token>`, `anthropic-beta: oauth-2025-04-20`, and `User-Agent: claude-code/<version>` (without the UA you hit an aggressively rate-limited bucket — persistent 429s; issues #31637, #30930, #31021).
- Response schema (community-verified):
  ```json
  {
    "five_hour":  {"utilization": 0-100, "resets_at": "2026-02-08T04:59:59.000000+00:00"},
    "seven_day":  {"utilization": 0-100, "resets_at": "..."},
    "seven_day_opus": null | {...},
    "seven_day_sonnet": null | {...},
    "extra_usage": {"is_enabled": bool, "monthly_limit": null|n, "used_credits": null|n, "utilization": null|n}
  }
  ```
- Token retrieval: macOS `security find-generic-password -s "Claude Code-credentials" -w | jq -r '.claudeAiOauth.accessToken'`; Linux `<configDir>/.credentials.json` same JSON path. Token must carry `user:profile` scope (GUI OAuth login does; `claude setup-token` does not). Non-default profiles: Keychain entry keyed by hash of `CLAUDE_CONFIG_DIR` — resolve per profile at build time, degrade to estimates when not found.
- Polling discipline: cache to a file, refresh ≥180–300s, file-lock against concurrent fetches, never retry-storm a 429.
- Risk: undocumented → may change/break at any time. Treat as enhancement layer, never a dependency; JSONL estimation remains the fallback.

### Pacing marker (from jtbr gist — adopt)
`target% = elapsed_in_window / window_length`. Marker on the bar shows where linear consumption "should" be; `actual > target` = burning hot. Cheap, intuitive, drives the advisor.

## 2. Advisor ("intimation") mechanics

Trigger data: in-session `rate_limits` (statusline feed) written by our statusline to `<configDir>/lodestone/usage-cache.json` each render (file bridge), or Source B for profiles without live sessions.

Delivery surfaces, in order of reliability:
1. **Statusline segment** — always visible: `5h 87% ⚠ handoff?`.
2. **UserPromptSubmit hook** — when threshold crossed (default: 5h ≥ 85% or weekly ≥ 90%, configurable), emit `systemMessage` ("lodestone: 5-hour window at 87% — cache is warm; `/handoff` now is cheap, `lodestone switch work` after") and optionally `additionalContext` so Claude itself can suggest the handoff. Debounce: warn once per 5%-step per session (state file), never block the prompt.
3. **`lodestone status`/dash** — cross-profile: "personal 87% (resets 14:05) → work 12%: switch now costs ~X, or wait 38m for reset."

Key timing insight: the RIGHT moment to advise is while the session is alive and its cache warm — an in-session `/handoff` (skill) writes the highest-quality state for free, and `--distill` costs ~0.1×C. After the limit hits, only the deterministic snapshot is free. So the advisor's job is to move users to the high-quality path *before* the wall.

## 3. UI landscape (what exists) and our surface strategy

VS Code marketplace is crowded with quota bars: vscode-claude-status, ClaudeProUsage, claude-statusbar (bartosz-warzocha), claude-usage-status-bar, claude-quota-tracker, claude-usage-bar, claude-code-usage-tracker, Gronsten/claude-usage-monitor… All show 5h/7d bars ± cost; the reference screenshot matches this genre. **None** do: multiple accounts/profiles, cache-TTL countdown, switch-cost estimates, handoff actions.

Terminal side: ccusage (analytics), Claude-Code-Usage-Monitor, ccstatusline/claude-powerline (statuslines), oh-my-claudecode HUD. Same gap.

**Our strategy (ADR-010):** core CLI owns all data (status --json is the contract); surfaces are thin consumers:
1. Rich statusline (ship now, upgrade to native rate_limits + pacing + advisor glyph).
2. `lodestone dash` — live TUI (the screenshot's popover, in terminal form): per-profile quota bars + resets, cache-TTL countdowns per live session, switch-tax panel, advisor line. ANSI, 1s refresh, zero deps.
3. VS Code extension (later phase, slim): statusbar `⇄ 5h 24% · wk 25%` + Quota popover with BOTH profiles, cache countdown, "Handoff & Switch" button that runs the CLI. Differentiation, not another quota bar.

## 4. Cache keepalive (the one legitimate "cache manipulation")

Official: "Each request that hits the cache resets the timer" — refresh is free and restores the full TTL (1h on subscription). Prior art proves the pattern for the API 5m tier (yujiachen-y/claude-code-cache-keepalive plugin, cline-keep-alive MCP; ~22%+ savings on idle gaps).

Our variant — **switch-back keepalive**: while working on profile B, ping profile A's session before its 1h TTL lapses so switching back is warm.
- Mechanism: `claude -p --resume <session> --fork-session --max-turns 1 "…"` under profile A's env (fork officially inherits the parent's cache; print-mode; discard output; `--no-session-persistence` if honored — validate at build).
- Cost per ping: ~0.1×C weighted on A (150k ctx ≈ 15k ≈ ~3% of a Pro 5h window). Cold return costs ~2×C (~300k). One ping scheduled at minute ~52 buys a warm return worth ~20 pings.
- Guardrails: NEVER automatic by default — explicit `--keep-warm <duration>` intent (e.g. `lodestone switch work --keep-warm 90m`), hard cap (default 3 pings), every ping printed with its estimated cost, aborts if A's 5h window ≥ threshold. Subagent TTL caveat: subagent requests use 5m TTL even on subscription — a -p ping is a main-loop request, expected 1h; verify empirically in live validation via JSONL (`cache_read ≈ C`, writes tiny, tier 1h).

## Sources
- code.claude.com/docs/en/statusline (rate_limits fields, absence semantics)
- code.claude.com/docs/en/prompt-caching (TTL by auth type, refresh-resets-timer, fork shares cache, cache scope incl. per-machine/dir, subagent 5m TTL)
- github.com/anthropics/claude-code issues #31637, #30930, #31021 (UA + 429s), #34074/#36056 (statusline rate limits)
- gist.github.com/jtbr/4f99671d1cee06b44106456958caba8b (endpoint schema, keychain/credentials retrieval, scopes, pacing math)
- github.com/ohugonnot/claude-code-statusline (headers, polling/flock discipline)
- github.com/yujiachen-y/claude-code-cache-keepalive, github.com/valk/cline-keep-alive (keepalive prior art + economics)
- VS Code marketplace survey links in ecosystem doc 04 + this doc §3
