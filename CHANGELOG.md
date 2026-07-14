# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-07-14

**A release-gate audit of every feature, run the way a new user would hit them. It found two features that had never existed and one bug that hid three of nine real projects.**

### Fixed

- **Project paths with spaces, dots or underscores were invisible to every active command.** Claude Code names transcript directories by replacing *every* character that is not ASCII alphanumeric or `-` with `-`; `mungeCwd` replaced only `/`. So for a project at `~/Desktop/RAIT QA`, session lookup resolved to a directory that does not exist, and `snapshot`, `handoff`, `refresh`, `switch`, `keepalive` and the statusline's cache segment all quietly reported no session — on the machine this was found on, in 3 of 9 real projects. The passive hooks were immune only because Claude Code hands them the transcript path directly. Fixed in the CLI and in the extension's cache-warmth lookup, verified against live `~/.claude/projects` entries, and the research doc that stated the wrong rule is corrected.
- **`keepalive` never existed.** The command printed a credible plan, spawned Node against a scheduler file that had never been written, recorded the dead pid, and announced "Keepalive started". `--status` repeated the claim forever because it never asked the OS whether the pid was alive. The scheduler now exists (`dist/keepalive-scheduler.js`): it waits out each interval, re-checks the 80% guardrail before every ping, resumes the session with `--fork-session` so the ping renews the cache TTL without appending a junk turn to your real transcript, records each ping in the state file, and exits at the cap, the deadline, the guardrail, or `--stop`. `--status` now distinguishes a running scheduler from a finished or dead one. The whole lifecycle is covered by tests that count actual pings through a fake `claude` binary.
- **`switch --keep-warm <duration>` now exists.** The README's feature table had documented it since the beginning; the command's strict parser rejected it with "Unknown option". It schedules keepalive on the profile you are leaving, then launches the target.
- **The `/handoff` skill was never installed.** Only `init --project` copied it, per project; the documented path (`lodestone setup`, `lodestone init`) installed nothing, so the README, the wizard and the advisor all recommended a `/handoff` command that did not exist in anyone's session — including the author's. `init` now installs it into each profile's `skills/` dir, `doctor` verifies it by looking, and the copy reports failure instead of silently skipping. The path resolution also used a naive `file://` strip that broke on Windows and on any install path containing a space; it now uses `fileURLToPath`.
- **`handoff --distill --session <id>` crashed on `require()`.** The command's private session lookup was built on `require()`, which does not exist in an ES module, so the flag combination died with "require is not defined". There is now one shared `findSessionById` in core, used everywhere.
- **The statusline's estimate fallback fabricated a percentage.** With no live data it divided measured burn by an assumed 200k "pro" budget and printed `5h ≈N%` — the exact violation the project's hard rules exist to prevent, on the one surface still doing it. It now prints the measured weighted tokens labeled `est`, or nothing.
- **`refresh --distill` stamped `distilled: true` without distilling.** It now delegates to the real distillation path, with its cost estimate and cold-cache refusal; the metadata only says distilled when it is.
- **`switch --distill` hid the pre-spend cost estimate** by passing `--quiet` through to handoff. The estimate prints before anything spends, as ADR-003 requires.
- **`keepalive` state moved off `$HOME/.config`** to the real lodestone config dir, so it honors `XDG_CONFIG_HOME` and does not require `HOME` to exist. Killing a scheduler also no longer mis-reports "nothing killed" after killing (another ES-module `require()`).
- **`profile rename` refuses to overwrite an existing profile** instead of silently dropping its registration.
- **A typo'd command explains itself** ("unknown command or profile", with both lookups) instead of falling through to the profile launcher's "profile not found: stauts".

### Added

- **`lodestone uninstall`**: the inverse of `init`. Removes the hooks, the statusline (only when it is lodestone's own), and the `/handoff` skill from every profile, and stops running keepalive schedulers first, so no scheduler keeps spending on behalf of a tool being removed. It never deletes profile config dirs, handoff files, or the profile registry, and it prints what it left in place and how to remove that too. `--project` does the same for a single project.
- **Per-model weekly quota rows.** The usage endpoint returns model-specific weekly buckets (`seven_day_opus`, `seven_day_sonnet`) on plans that meter them; they were captured and shown nowhere. `dash` and the extension panel now render a row per bucket the endpoint actually returns, handled generically, so if Anthropic adds a bucket for another model it appears without a code change. Buckets the endpoint returns as null render nothing: most plans have no per-model caps, and a row for an unmetered model would be an invention.
- `--help` now lists `config`, `trail` and `refresh` — three commands the README pointed at that the CLI never mentioned — and `lodestone help <cmd>` exists for `init`, `config`, `trail`, `refresh` and documents `switch --keep-warm`.
- `lodestone config get/set autoSnapshot` and `maxAgeDays`: the hooks always honored both settings; now something can set them.
- The advisor hook has direct tests: the 85% warning, silence below thresholds, and the 95% recovery snapshot verified on disk. The keepalive lifecycle, the skill install, the munge rule, and the no-percentage statusline are all under test. 205 tests.

## [0.3.2] - 2026-07-14

### Fixed

- **The setup wizard's closing panel drew a broken box.** A row of the panel is `│` + space + content + space + `│`, four columns wider than its content, but the frame was sized at two, so every row rendered one column wider than the border above it and the right edge came apart into a column of stray bars. The frame also clamped itself to 80 columns without clamping the content to match, so a long line pushed its row out even further. Every row is now built from one shared content width, and content that cannot fit is truncated with an ellipsis rather than allowed to break the box. The panel tests previously asserted only that the title and the corner characters appeared somewhere, which a ragged box satisfies; they now assert every row is exactly as wide as the border.

## [0.3.1] - 2026-07-14

**The setup wizard never listened to a single answer.**

### Fixed

- **Every question in `lodestone setup` returned its default, whatever you typed.** `rl.close()` emits `close` synchronously, and the line handler closed the readline *before* resolving, so the close listener's `resolve(default)` always landed first and the typed answer was discarded on an already-settled promise. The close listener exists for one case, stdin ending without an answer, and it was deciding every question instead.

  The three questions that default to yes and the one that defaults to no all looked correct, because agreeing with a default is indistinguishable from being ignored by it. The bug only became visible on the fifth question, where answering `y` to trail mode reported "skipped".

  The serious case is the third: answering **`n`** to "Enable real usage?" turned it on anyway. That is the only feature in the product that makes a network call, and it is meant to be opt-in. An opt-in that cannot be declined is not an opt-in. `ask()` had the identical defect, so the second-account name prompt ignored what you typed too.

- **`status` named projects by trying to reverse the munge.** It took the last dash-separated component of `~/.claude/projects/<munged>`, which is guesswork the project's own notes describe as impossible: `~/code/my-app` and `~/code/my/app` munge identically, and a space becomes a dash as well. On the author's machine three of six projects displayed under the wrong name (`FY Project` as "Project", `RAIT QA` as "QA", `rait-qa-agent` as "agent"). It only ever looked right on single-word directory names. The name now comes from the transcript's `cwd`, which `status` was already reading.

### Added

- Prompts take an injectable input stream, so a question can be driven and its answer checked without a terminal. Nothing could do that before, which is why the wizard shipped deaf.
- `status` is covered against the real on-disk layout: project naming, and the cross-project session list.

## [0.3.0] - 2026-07-14

**The advisor had never run. Neither had the hook tests that were supposed to prove it did.**

### Fixed

- **The advisor was never installed.** `hook user-prompt-submit` is implemented in full: the 85% nudge, the 95% recovery snapshot, trail mode's staleness reminder. Nothing in the codebase ever wired it into `settings.json`, and `installHooks` did not even accept the option. Every user who ran `lodestone init` got three hooks and a dead advisor. It is now installed with the rest. **Existing users must re-run `lodestone init` to get it.**
- **`doctor` certified hooks it had not found.** It tested `settings.json` for the substring `lodestone hook` and, on a match, printed a hardcoded list of all four hook names. A profile carrying one hook was reported as carrying four, which is how the missing advisor stayed invisible. It now reports the hooks that are actually registered and fails, naming the missing ones, when the set is incomplete.
- **Auto-snapshots recorded provenance that was wrong in three fields at once.** They stored `sourceProfile: "auto"` (the directory the file lands in, not an account), the session's display slug where the session id belongs, and the git branch in the `project` field. Each one broke something real: `audit` reported boundary crossings *from* an account named `auto` that does not exist; `handoff --distill` fed the slug to `claude --resume`, which resumes nothing; and every snapshot was filed under a project named after a branch. `snapshot` had the same two field bugs. Fixed at all three writers, and `audit` now drops any record whose source is not a profile it can actually see rather than inventing a crossing from it.
- **The banner was unreadable on the default macOS terminal.** It emitted a 24-bit truecolor escape for each of its 462 characters. Apple's Terminal.app advertises `xterm-256color`, has never supported 24-bit color, and does not ignore an escape it cannot parse: it reads `38;2;124;108;186` as a run of separate SGR codes and paints the result. The TUI now asks the terminal what it supports and degrades honestly, with a smooth gradient at 24-bit, the same gradient quantized to the color cube at 256, and one flat color at 16. The wizard's question labels used the same escape and were equally affected. As a side effect the banner costs 929 bytes of ANSI instead of ~9,200.
- **`NO_COLOR` silently disabled the setup wizard's questions.** Color capability and interactivity were the same flag, so `NO_COLOR=1 lodestone setup` accepted every default without ever asking. `NO_COLOR` means do not paint, not do not ask.
- **The banner vanished on terminals that report a width of zero.** Some ptys answer `0` rather than declining to answer, and `columns ?? 80` takes that literally, because zero is not nullish.

### Changed

- **The hook test suite now invokes hooks.** Every test in it used to build a fixture, declare stdin "complex to mock", never call the hook, and assert that a file it had just written existed. Five green ticks over a passive layer that no test had ever executed, and three of the bugs above rode in underneath it. Hooks are now driven as child processes with the event payload on stdin, exactly as Claude Code drives them, and the suite covers injection, consumption, the age gate, the source gate, both snapshot events, and the rule that a hook can never fail a session.
- `doctor` exits non-zero on a partial hook install. It previously reported such a profile as healthy.

## [0.2.1] - 2026-07-13

**`audit` and `dash` were reporting nothing. Both are fixed, and the cause was the same in each.**

### Fixed

- **`audit` never reported a single event.** Three defects, stacked:
  1. It looked for handoffs under `~/.claude/projects/<munged>/.claude/handoff/`, a path that exists on no machine. Handoffs live in the project's working directory (ADR-005). It now takes the real project root from the transcript's `cwd` field, which is the only reliable route: the munged name cannot be reversed, because a directory called `my-app` and a nested `my/app` munge identically, and a space becomes a dash.
  2. Its session scan called `latestSession(configDir, projectPath)`, but that function takes a *working directory* and munges it. Passing an already-munged path munged it twice, so the scan resolved to nothing and both detectors ran on an empty map.
  3. It reported one event per profile pair, not one per crossing, so even a working detector could only ever have shown you the first.
- **Consumption records were destroyed by the next handoff.** `saveHandoff` archived the markdown but overwrote `latest.meta.json`, which is where the record of who consumed a handoff, and what the context cost, actually lives. Every new handoff erased the measurement of the one before it. Handoff metas are now archived beside their markdown and rotate with them, so the audit trail outlives the handoff that produced it.
- **`dash` never listed a live session**, from the same double-munge bug in its project scan.
- **Session timestamps were often missing.** `parseSession` read `firstTs`/`lastTs` from the literal first and last lines of a transcript, but those are commonly an `ai-title` and a `file-history-snapshot`, neither of which carries a timestamp. Every staleness check downstream then failed open: `dash` would have listed month-old sessions as live, and audit's gap detector skipped the pair. It now takes the outermost lines that actually have a time.
- **`--since` was ignored** by the explicit detector.
- **`init` could install the same hook many times over.** The "is this already installed?" check keyed on the literal substring `lodestone hook`, so any command that did not contain it (an absolute path, a local build, anything set via `LODESTONE_HOOK_CMD`) was never recognized as present, and every run appended another identical copy. An exact copy of the command being installed is now never added twice, and `init` collapses duplicates left behind by older versions instead of merely declining to add more. Hooks belonging to other tools are left untouched.
- **The test suite wrote hooks into the developer's real `~/.claude/settings.json`.** One test called `init` in-process with no environment isolation, so it resolved the real config, found the real profiles, and edited the real settings file on every `npm test`. It asserted nothing beyond "did not throw", so it passed while doing this. It now runs in a child process against a scratch `HOME`, and the suite is verified not to touch the real settings file. A companion test claiming to prove idempotency was a tautology (it read the same file twice and asserted the two reads matched); it now counts hooks.

### Changed

- Repo prepared for public use: internal build documents removed, docs indexed and cross-linked, contributor and security process documented.

## [0.2.0] - 2026-07-13

- Renamed to lodestone. Setup TUI, live quota in the statusline and the editor extension, real-usage endpoint, trail mode. See the git history for the full detail.

## [0.1.0] - 2026-07-12

**Initial release: Core CLI, profiles, handoffs, advisor, audit, and dashboard.**

### Added

#### Core Features
- **Profiles**: Isolated per-account configuration via `CLAUDE_CONFIG_DIR` environment variable. Auto-adopt existing `~/.claude` as `personal`.
- **Handoff workflow**: Three-tier quality ladder:
  1. In-session `/handoff` skill (Tier 1, recommended)
  2. `lodestone handoff --distill` (Tier 2, cold-cache guard)
  3. Auto-snapshot from transcripts (Tier 3, always available)
- **Rehydration hooks**: Automatic handoff injection on `SessionStart` across all profiles.
- **Switch command**: One-command account handoff: `lodestone switch <target> [--distill] [--stay]` with cost comparison printout.
- **Advisor**: Watches usage quota, nudges `/handoff` while cache is warm (≥85% 5h window, ≥90% weekly), no blocking. At ≥95% (critical threshold), fires deterministic snapshot inline with wall-imminent message.
- **Refresh flow**: `/refresh` skill in-session (compose handoff → instruct user to `/clear`) + `lodestone refresh` CLI for outside-session use. Handles B2 (cold cache) and B4 (voluntary shed) within the same account.
- **Trail mode**: `lodestone trail on/off/status` installs bounded capture rules + skill that continuously maintain `.claude/handoff/trail.md` (~1.5k tokens, fixed sections overwritten in place). Optional wall insurance; cost ≈10-40k weighted/session (opt-in, documented honestly).
- **Measurement**: `lodestone audit` scans profile history for handoff events and heuristic boundaries; reports per-switch cost deltas (naive vs. handoff). Event classes: `switch` (different profile), `refresh` (same profile, <5h gap), `post-reset` (same profile, ≥5h gap after quota boundary). Totals per class in JSON and human output.
- **Dashboard**: `lodestone dash` live full-screen TUI (ANSI, zero deps): per-profile quota bars, live sessions with cache countdown, switch-tax panel, advisor line, keepalive status.
- **Keepalive**: `lodestone switch <target> --keep-warm <duration>` schedules periodic TTL-refresh pings on the source profile to keep cache warm while on the target. Configurable `keepalive.maxWindowPct` ceiling (default 80): skips pings at/above that 5h window usage to preserve headroom.
- **Real usage data**:
  - Layer A (native): Captures Claude Code's native `rate_limits` from statusline into local cache; powers advisor, dashboard, status without any API call.
  - Layer B (opt-in OAuth): `lodestone config set realUsage on` for cross-profile quota via undocumented endpoint, cached ≥180s, gracefully degrades to JSONL estimates if unavailable.

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
- `audit [--since <period>] [--json]`: Analyze past handoff events and switches; per-class breakdown (switch/refresh/post-reset).
- `trail on|off|status [--json]`: Enable/disable/check trail mode for the current project.
- `doctor`: Diagnose setup issues (profile registry, login state, hook installation, Claude binary).
- `init [--project] [--statusline] [--force]`: Install hooks into all profiles; optional project-level setup.
- `config get|set`: Inspect and modify lodestone settings (plan, advisor thresholds, keepalive defaults, `realUsage` opt-in).
- `help`: Show command help; `<command> --help` for subcommand help.

#### Automation & Hooks
- **Hook: `session-start`.** Inject the latest handoff into a fresh session (via `SessionStart` hook).
- **Hook: `session-end`** / **`pre-compact`.** Auto-snapshot to `auto/` slot (respects `settings.autoSnapshot`).
- **Hook: `user-prompt-submit`.** Advisor nudge when quota threshold crossed (once per 5%-step per session); at 95% critical threshold, inlines deterministic snapshot + wall-imminent message.
- **Statusline v2.** Renders: real `rate_limits` (or estimates), pacing marker, cache-warmth countdown, advisor glyph.
- `/handoff` skill. In-session context extraction (Tier 1); installed by `init --project`.
- `/refresh` skill. In-session refresh flow (Tier 1 same-account): compose handoff + instruct user to `/clear`.
- `/trail` skill. Trail mode update directive; works with `lodestone trail on` installation.

#### VS Code Companion Extension
- **Status bar item**: Shows current profile, 5h quota %, weekly quota %; click for menu.
- **QuickPick menu**: Actions include Handoff & Switch, **Refresh In Place**, **Trail Mode: toggle**, Keep Warm, Dashboard, Refresh Status, Enable Real Usage.
- **Popover tooltip**: Per-profile quota bars with reset countdowns; per-project cache TTL countdowns; savings totals with **per-class breakdown** (switch/refresh/post-reset); advisor warning line.
- **Cache expiry toast**: Optional warning when a project's cache is within N minutes of expiry (configurable `lodestone.expiryToastMinutes`, default 0 = off); "Keep warm" button wires to keepalive flow.
- **package.json contributions**: Configuration setting `lodestone.expiryToastMinutes` (number, default 0).
- **Requirements**: lodestone CLI installed; VS Code 1.85+.

#### Output & UX
- `--json` flag for machine-readable output (status, audit, handoff metadata).
- Deterministic, scannable human output: progress bars, colored warnings, token estimates labeled `est`.
- Completeness score on handoff output (0-5 across goal/state/decisions/files/next-steps).
- "Thin handoff" warning when deterministic extraction scores low.

#### Configuration
- `~/.config/lodestone/config.json`: Profile registry, settings (plan, advisor thresholds, autoSnapshot, distillModel, realUsage opt-in).
- Per-profile settings via `settings.json` (hooks, custom models, etc.).
- Hook self-test: `lodestone hook session-start --self-test`.

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
- **docs/research/04**: Real usage data sources, advisor mechanics, UI strategy, cache keepalive.
- **docs/decisions/ADR-001 through ADR-010**: Decision records on handoff strategy, profiles, deps, features, quality ladder, usage data, keepalive, UI surfaces.

#### Testing
- **128 tests** across unit (core logic, extraction, hooks) and integration (CLI commands, fixture transcripts).
- Test fixtures: synthetic JSONL transcripts (small, compact-summary, sidechain variants), settings configs.
- Child-process tests: `LODESTONE_CLAUDE_BIN` env var for fake-claude.sh (scripted responses, no real API).
- Zero-dep verification: `npm ls --production` in CI.

#### CI/CD
- `.github/workflows/ci.yml`: Matrix test on ubuntu-latest × (Node 20, 22) and macos-latest × (Node 20, 22); Windows build-only (npm ci + npm run build).
- Cache npm between runs.
- No publish workflow yet (Phase 7 decision after live validation).

#### Package & Distribution
- **package.json**: Zero runtime dependencies (dev: typescript, @types/node).
- **Keywords**: claude, claude-code, handoff, context, usage-limits, prompt-cache, multi-account, cli.
- **Bin**: `lodestone` and `cch` (alias).
- **Files field**: bin, dist, skills, README.md, LICENSE (verified via `npm pack --dry-run`).
- **Repository**: Placeholder GitHub URL (to be filled on publish per TODO comment).

### Known Limitations

- **Keepalive empirical validation pending**: Keepalive feature (ADR-009) must be live-tested in Phase 7 to confirm fork-session TTL behavior matches expectations before README may claim it.
- **Windows best-effort**: Native Windows support is best-effort (Credentials.json path works; hooks via PowerShell/WSL tested). Report concrete issues.
- **Undocumented endpoint risk**: Real-usage OAuth endpoint is undocumented (like community tools); graceful degradation to estimates if Anthropic changes it.
- **Single-machine keepalive**: Keepalive uses a local pidfile scheduler (no daemons, no cron edits); survives only while the machine is awake.
- **Deterministic extraction quality**: Thin handoffs on atypical sessions; mitigated by advisor-driven Tier 1/2 paths and completeness scoring.

### Not Included (Phase 7+)

- VS Code Marketplace publish (Phase 7, pending CLI npm publish + user confirmation)
- Blog post & launch announcement (Phase 7, with real measurement results)

---

## [Unreleased]

(Roadmap for v0.2+)

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
