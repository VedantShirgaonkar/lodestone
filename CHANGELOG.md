# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-07-12

**Initial release: Core CLI, profiles, handoffs, advisor, audit, and dashboard.**

### Added

#### Core Features
- **Profiles**: Isolated per-account configuration via `CLAUDE_CONFIG_DIR` environment variable. Auto-adopt existing `~/.claude` as `personal`.
- **Handoff workflow**: Three-tier quality ladder:
  1. In-session `/handoff` skill (Tier 1, recommended)
  2. `warmswap handoff --distill` (Tier 2, cold-cache guard)
  3. Auto-snapshot from transcripts (Tier 3, always available)
- **Rehydration hooks**: Automatic handoff injection on `SessionStart` across all profiles.
- **Switch command**: One-command account handoff: `warmswap switch <target> [--distill] [--stay]` with cost comparison printout.
- **Advisor**: Watches usage quota, nudges `/handoff` while cache is warm (≥85% 5h window, ≥90% weekly), no blocking.
- **Measurement**: `warmswap audit` scans profile history for handoff events and heuristic boundaries; reports per-switch cost deltas (naive vs. handoff).
- **Dashboard**: `warmswap dash` live full-screen TUI (ANSI, zero deps): per-profile quota bars, live sessions with cache countdown, switch-tax panel, advisor line, keepalive status.
- **Keepalive**: `warmswap switch <target> --keep-warm <duration>` schedules periodic TTL-refresh pings on the source profile to keep cache warm while on the target.
- **Real usage data**:
  - Layer A (native): Captures Claude Code's native `rate_limits` from statusline into local cache — powers advisor, dashboard, status without any API call.
  - Layer B (opt-in OAuth): `warmswap config set realUsage on` for cross-profile quota via undocumented endpoint, cached ≥180s, gracefully degrades to JSONL estimates if unavailable.

#### Commands
- `profile add|list|remove|rename|adopt`: Manage profiles, auto-adopt `~/.claude` on first run.
- `launch <profile> [args]` / `<profile> [args]` (bare): Launch Claude on a specific profile.
- `login <profile>`: Authenticate via `/login` flow.
- `snapshot [--session id] [--out path] [--quiet]`: Snapshot current session to handoff file.
- `handoff [--distill] [--force] [--session id]`: Snapshot with optional distillation (Tier 2).
- `switch <profile> [--distill] [--stay] [--keep-warm <duration>]`: Switch accounts with handoff injection, optional keepalive.
- `status [--json]`: Per-profile burn status, active sessions, current-project switch cost.
- `dash [--once]`: Live TUI dashboard; `--once` for single frame (test/CI use).
- `keepalive <profile> [--for <duration>] / --stop`: Standalone keepalive scheduler.
- `audit [--since <period>] [--json]`: Analyze past handoff events and switches.
- `doctor`: Diagnose setup issues (profile registry, login state, hook installation, Claude binary).
- `init [--project] [--statusline] [--force]`: Install hooks into all profiles; optional project-level setup.
- `config get|set`: Inspect and modify warmswap settings (plan, advisor thresholds, keepalive defaults, `realUsage` opt-in).
- `help`: Show command help; `<command> --help` for subcommand help.

#### Automation & Hooks
- **Hook: `session-start`** — Inject the latest handoff into a fresh session (via `SessionStart` hook).
- **Hook: `session-end`** / **`pre-compact`** — Auto-snapshot to `auto/` slot (respects `settings.autoSnapshot`).
- **Hook: `user-prompt-submit`** — Advisor nudge when quota threshold crossed (once per 5%-step per session).
- **Statusline v2** — Renders: real `rate_limits` (or estimates), pacing marker, cache-warmth countdown, advisor glyph.
- `/handoff` skill — In-session context extraction (Tier 1); installed by `init --project`.

#### Output & UX
- `--json` flag for machine-readable output (status, audit, handoff metadata).
- Deterministic, scannable human output: progress bars, colored warnings, token estimates labeled `est`.
- Completeness score on handoff output (0–5 across goal/state/decisions/files/next-steps).
- "Thin handoff" warning when deterministic extraction scores low.

#### Configuration
- `~/.config/warmswap/config.json`: Profile registry, settings (plan, advisor thresholds, autoSnapshot, distillModel, realUsage opt-in).
- Per-profile settings via `settings.json` (hooks, custom models, etc.).
- Hook self-test: `warmswap hook session-start --self-test`.

#### Documentation
- **README.md**: Problem story, feature tour, quickstart, how-it-works, comparison table, FAQ.
- **SECURITY.md**: Threat model, credential handling (never stored/copied), OAuth opt-in policy, audit transparency.
- **CONTRIBUTING.md**: Dev setup, testing rules (fixture privacy, zero deps, hook safety), commit style, acceptance criteria.
- **CHANGELOG.md** (this file).
- **docs/DIRECTION.md**: Strategic context and design decisions post-Phase-3.
- **docs/ARCHITECTURE.md**: Component contracts and data flow.
- **docs/PLAN.md**: Full phased implementation roadmap (PLAN v2 updated for ADR-007..010).
- **docs/EVALUATION.md**: Methodology for measuring handoff savings; live-protocol section for Phase 7 validation.
- **docs/explainer/how-claude-code-memory-works.md**: The physics of Claude Code layers, cache TTLs, and switch tax.
- **docs/research/01**: Prompt caching mechanism, TTL tiers, org/workspace isolation (verified, final verdict).
- **docs/research/06**: Real usage data sources, advisor mechanics, UI strategy, cache keepalive.
- **docs/decisions/ADR-001 through ADR-010**: Decision records on handoff strategy, profiles, deps, features, quality ladder, usage data, keepalive, UI surfaces.

#### Testing
- **128 tests** across unit (core logic, extraction, hooks) and integration (CLI commands, fixture transcripts).
- Test fixtures: synthetic JSONL transcripts (small, compact-summary, sidechain variants), settings configs.
- Child-process tests: `WARMSWAP_CLAUDE_BIN` env var for fake-claude.sh (scripted responses, no real API).
- Zero-dep verification: `npm ls --production` in CI.

#### CI/CD
- `.github/workflows/ci.yml`: Matrix test on ubuntu-latest × (Node 20, 22) and macos-latest × (Node 20, 22); Windows build-only (npm ci + npm run build).
- Cache npm between runs.
- No publish workflow yet (Phase 7 decision after live validation).

#### Package & Distribution
- **package.json**: Zero runtime dependencies (dev: typescript, @types/node).
- **Keywords**: claude, claude-code, handoff, context, usage-limits, prompt-cache, multi-account, cli.
- **Bin**: `warmswap` and `cch` (alias).
- **Files field**: bin, dist, skills, README.md, LICENSE (verified via `npm pack --dry-run`).
- **Repository**: Placeholder GitHub URL (to be filled on publish per TODO comment).

### Known Limitations

- **Keepalive empirical validation pending**: Keepalive feature (ADR-009) must be live-tested in Phase 7 to confirm fork-session TTL behavior matches expectations before README may claim it.
- **Windows best-effort**: Native Windows support is best-effort (Credentials.json path works; hooks via PowerShell/WSL tested). Report concrete issues.
- **Undocumented endpoint risk**: Real-usage OAuth endpoint is undocumented (like community tools) — graceful degradation to estimates if Anthropic changes it.
- **Single-machine keepalive**: Keepalive uses a local pidfile scheduler (no daemons, no cron edits) — survives only while the machine is awake.
- **Deterministic extraction quality**: Thin handoffs on atypical sessions — mitigated by advisor-driven Tier 1/2 paths and completeness scoring.

### Not Included (Phase 7+)

- VS Code extension (planned after CLI OSS launch)
- npm registry publish (Phase 7, user-controlled)
- Blog post & launch announcement (Phase 7, with real measurement results)

---

## [Unreleased]

(Roadmap for v0.2+)

- [ ] VS Code extension (statusbar + webview popover; shell out to CLI)
- [ ] Enhanced OAuth caching (per-profile token refresh strategy)
- [ ] Performance monitoring (profile hook execution, transcript parsing speed)
- [ ] Community plugins API (extensible handoff format, custom extraction)
- [ ] Measurement dashboard (replay and visualize past switches)

---

## Versioning

This project follows [Semantic Versioning](https://semver.org/):
- **MAJOR**: Breaking changes to CLI interface or hook contracts
- **MINOR**: New features (commands, hooks, config options)
- **PATCH**: Bug fixes, docs, non-breaking internal changes

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and submitting changes.

## License

MIT License. See [LICENSE](LICENSE) for details.

## Credits

- Built by Rahul (+ Claude).
- Research and design informed by the Claude Code community and Anthropic's official documentation.
- Not affiliated with or endorsed by Anthropic.
