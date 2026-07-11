# cchandoff — Implementation Plan

Source of reference for all implementation. Read `docs/ARCHITECTURE.md` and `docs/decisions/ADR-*.md` first; research facts live in `docs/research/`. Rules for every phase: zero runtime deps (ADR-004), never touch credentials (ADR-002), hooks always exit 0, token-spending paths opt-in only (ADR-003), all estimates labeled as estimates. Phase N+1 starts only when phase N's acceptance criteria pass via `npm test`.

> Status (2026-07-11): P0 ✅ · P1 ✅ (committed e5d81c7; real-transcript validated) · P2 in review loop (see docs/PHASE2-SPEC.md — binding command contracts added after first attempt shipped placeholder facades) · P3+ pending.

## Phase 0 — Scaffold ✅ (done in planning session)
package.json / tsconfig / .gitignore / LICENSE / README stub / CLAUDE.md / .claude/settings.json / docs corpus.

## Phase 1 — Core library (`src/core/`, `src/util/`) + unit tests

Modules (all ESM TS, no I/O at import time, every module unit-tested against fixtures in `test/fixtures/`):

1. `util/jsonl.ts` — `async function* readJsonlLines(path): AsyncGenerator<{value?: unknown, error?: string, lineNo: number}>` — streaming, never throws on bad lines.
2. `util/log.ts` — append-only logger to `~/.config/cchandoff/cchandoff.log` (size-capped 1MB, rotate once), `logError/logInfo`; silent on logging failure.
3. `util/ansi.ts` — tiny color/bar helpers, honors `NO_COLOR` and non-TTY.
4. `core/paths.ts` — `mungeCwd(cwd)` (`/`→`-`, matches Claude Code's projects naming; verify against fixture from real dir listing), `projectsDirFor(configDir)`, `handoffDirFor(projectRoot)` (`.claude/handoff`), `cchandoffConfigPath()` (`$XDG_CONFIG_HOME/cchandoff/config.json` fallback `~/.config/cchandoff/`), `expandTilde`, `findProjectRoot(cwd)` (nearest ancestor with `.git`, else cwd).
5. `core/config.ts` — load/save cchandoff config `{schema:1, profiles: Record<name,{configDir,label?}>, settings: {maxAgeDays:7, injectOn:["startup","clear"], autoSnapshot:true, distillModel?: string}}`; atomic write (tmp+rename); schema-migration stub.
6. `core/profiles.ts` — `addProfile(name, {configDir?})` (default `~/.claude-profiles/<name>`, mkdir -p; reject if name exists / dir is another profile), `adoptDefault()` (register `~/.claude` as `personal` if unregistered — only when it exists), `removeProfile` (registry only; NEVER deletes the dir), `currentProfile()` (match `process.env.CLAUDE_CONFIG_DIR` against registry; default-profile fallback), `loggedInHint(profile)` (read `<dir>/.claude.json` → `oauthAccount.emailAddress`+`organizationName` if present; missing file/key → "not logged in"; never read credential stores).
7. `core/transcript.ts` — types `TranscriptLine`, `Turn`, `SessionMeta`; `parseSession(path)` → `{meta, turns, toolUses, usageByTurn, compactSummaries, parseErrors}` per ARCHITECTURE §2 (dedupe assistant lines by `message.id` keep-last; skip `isSidechain`; capture `isCompactSummary` user lines; meta: sessionId, slug, model of last assistant, gitBranch, cwd, version, firstTs, lastTs). `latestSession(configDir, cwd)` → newest .jsonl by mtime in the munged project dir. `contextTokensOf(lastAssistantUsage)` = input + cache_read + cache_creation.
8. `core/usage.ts` — weight table `{input:1, cacheCreation:2, cacheRead:0.1, output:5}`; per-model price ratios (static: opus 5, sonnet 1, haiku 0.25, fable per pricing; overridable via config); `weightedBurn(usage, model)`; `windowBurn(configDir, now)` → scan all projects' sessions' assistant usage in current 5h window (window start = first message after last ≥5h idle gap across that profile; document approximation); `switchTax(contextTokens)` → `{naive: 2*C, handoff: 2*(S+H)}` with S=20k default, H measured from actual handoff file; format helpers (`asPctOfWindow` using plan presets pro/max5/max20/team with token-equivalent budgets marked "rough community estimates, configurable").
9. `core/handoffFile.ts` — render handoff markdown (sections per ARCHITECTURE data contract; ≤2500 target/4000 hard-cap tokens via `estimateTokens = chars/3.6`), frontmatter, `latest.meta.json` read/write, archive rotation (keep 20), `auto/` slot, `markConsumed(by)`, `freshest(projectRoot)` → explicit `latest.md` else newest `auto/`.
10. `core/extract.ts` — `extractSnapshot(parsed, {cwd})` per ARCHITECTURE §3: goal (first substantive user prompt = first non-isMeta, non-slash text >20 chars; truncate 600 chars) + last 3 user prompts (300 chars each); latest TodoWrite todos; files: edits ranked by count (cap 15), reads top 10; final assistant text (1500 chars) ; latest compact summary (2000 chars); git branch/dirty (spawn `git` in cwd, 1s timeout, absent-git tolerated); metrics. Pure function over parsed transcript + injected `gitInfo` for testability.
11. `core/claudeCli.ts` — `claudePath()` (PATH probe), `versionOf()`, `launchInteractive(profile, args, {cwd})` (spawn inherit-stdio with `CLAUDE_CONFIG_DIR`, exec-like exit-code passthrough), `distill(profile, sessionId, template, {cwd})` → runs `claude --resume <id> --fork-session -p <prompt> --output-format json --max-turns 1` with 120s timeout, parses result text; cold-cache guard is caller's job (needs lastTs).
12. `core/settingsEdit.ts` — `installHooks(configDirOrProjectClaudeDir, {sessionStartCmd, sessionEndCmd, preCompactCmd})`: read settings.json (create if absent), strict JSON.parse (reject with clear error on comments/trailing commas), no-op if our commands already present (idempotent, match by substring `cchandoff hook`), else append matcher-appropriate entries preserving existing hooks; write `settings.json.bak` first; `uninstallHooks` symmetric.

Fixtures: `test/fixtures/session-small.jsonl` (hand-built: 2 user turns, 3 assistant lines w/ one streamed duplicate id, one TodoWrite, Edit+Read tool_uses, realistic usage numbers incl. ephemeral_1h), `session-compacted.jsonl` (compact_boundary + isCompactSummary), `session-sidechain.jsonl`, `settings-existing-hooks.json`. Base shapes on docs/research/03+05 — do NOT copy real transcripts (privacy).

**Acceptance:** `npm test` green on macOS; parser handles all fixtures incl. malformed lines; extract output snapshot-tested; settingsEdit idempotence proven by double-install test; `npm run build` emits runnable ESM; no runtime deps in package.json.

## Phase 2 — CLI + user commands

`src/cli.ts`: hand-rolled dispatch (`util.parseArgs` per-command), global `--json` for machine output, `--profile <name>` override, exit codes (0 ok / 1 error / 2 usage). Commands:
- `profile add|list|remove|rename` (+ `profile adopt` internal on first run: auto-adopt `~/.claude` as `personal` with a printed notice); `list` shows configDir, login hint, sessions count, ★ current.
- `<profileName> [args…]` bare-launch sugar + explicit `launch <profile> [args…]` (bare form only when name ∉ command names).
- `login <profile>` → `launchInteractive(profile, ["/login"])`.
- `snapshot [--session id] [--out path] [--quiet]` — deterministic snapshot of current project on current profile → handoff files; prints location + est. tokens.
- `handoff [--distill] [--force] [--session id]` — snapshot + distill flow w/ cold-cache guard (>55min → refuse unless --force; prints reasoning either way).
- `switch <profile> [--distill] [--stay] [--no-launch]` — orchestration per ARCHITECTURE §6 incl. the printed tax comparison.
- `status [--json]` — per-profile: login hint, 5h-window burn bar + est. %, freshest session per project (context tokens, minutes-since-last-turn vs 60m TTL), current project switch-tax line.
- `doctor` — checks per ARCHITECTURE §8.
- `help`, `--version`.

**Acceptance:** integration tests drive the CLI via `node dist/cli.js` against temp dirs with fake `CLAUDE_CONFIG_DIR` layouts + fixture transcripts (no real `claude` needed: `claudeCli` injectable/mocked via env `CCHANDOFF_CLAUDE_BIN=test/fake-claude.sh`); `switch --stay` produces correct files + math; `status --json` schema-stable; commands never write outside temp dirs in tests.

## Phase 3 — Automation: hooks, init, skill, statusline

- `hook session-start` — stdin JSON per docs/research/03 §3; injection rules per ARCHITECTURE §5 (fresh unconsumed handoff → additionalContext with framing wrapper + systemMessage; then markConsumed). Framing wrapper text: brief "Restored handoff from <profile>/<age> — verify file and git state before relying on details" + full handoff body.
- `hook session-end` / `hook pre-compact` — auto-snapshot to `auto/` (respect `settings.autoSnapshot`); total budget 2s (internal deadline; on overrun log+exit 0).
- `init [--project]` — default: install hooks into EVERY registered profile's `settings.json` (settingsEdit), create `~/.config/cchandoff/`, print summary; `--project`: write `.claude/settings.json` hooks + `.gitignore` entry `.claude/handoff/` + copy `/handoff` skill to `.claude/skills/handoff/SKILL.md`; both idempotent; `init --statusline` wires `statusLine` command into profile settings (backup + refuse-if-custom-existing without `--force`).
- `statusline` — read stdin JSON, one line out: `⇄ <profile> · ctx <used_pct>% · 5h ≈<burn>% · switch ≈<tax>%` (graceful when fields missing; <150ms).
- `skills/handoff/SKILL.md` — skill instructing Claude to write `.claude/handoff/latest.md` per the data contract from live conversation knowledge, update meta json, and tell the user the `cchandoff switch` command to run next. No API calls beyond the turn itself.
- Hook self-test: `cchandoff hook session-start --self-test` feeding synthetic stdin (doctor uses it).

**Acceptance:** integration tests pipe recorded hook-input JSON into `hook` commands and assert JSON output + file effects + consumed-flag flip + exit 0 on induced failures (unreadable transcript etc.); `init` idempotence double-run test; skill file lints (frontmatter parses).

## Phase 4 — Audit + evaluation harness

- `audit [--since 7d] [--json]` — per ARCHITECTURE §7: explicit handoff records (meta jsons incl. consumedBy) + heuristic boundary detection across all profiles (same project, A ends → B starts <30min); per event report: context abandoned on A, actual first-turn `cache_creation` on B, naive-estimate, saved-estimate; totals line.
- `scripts/measure-switch.md` + `scripts/measure-switch.ts` — the LIVE evaluation protocol (documented + automated readout): (1) build a controlled session on profile A (scripted prompts reading a few files, target ~40–60k context, uses real tokens — protocol says so and requires explicit run), (2a) naive arm: continue it after `/login`-style switch — measured historically instead from user's past data when available, (2b) handoff arm: `switch` and record first-turn usage on B; readout compares from JSONLs only.
- `docs/EVALUATION.md` — methodology, expected numbers table (from research), threats to validity (window accounting opacity, model mix), and a section for real measured results to be filled after the live run.

**Acceptance:** audit unit-tested on constructed two-profile fixture layouts (one explicit handoff event, one heuristic event, one false-positive rejected); measure-switch readout runs against fixtures; EVALUATION.md complete except live-results section.

## Phase 5 — OSS polish

- `README.md` full rewrite: the problem story (with the 40–80% number), the physics ("what this can't do" — ADR-001 honesty up top), quickstart (`npm i -g cchandoff && cchandoff profile add work && cchandoff init`), command reference, how-it-works link to explainer, comparison table (ccusage / cc-switch / handoff-skills — complementary), FAQ (Team-plan etiquette note, Windows status, privacy: gitignored by default), badges.
- `CONTRIBUTING.md` (build/test/fixture-privacy rules), `SECURITY.md` (no credential access by design; report channel), `CHANGELOG.md` (0.1.0), `.github/workflows/ci.yml` (Node 20+22 × ubuntu+macos: build+test; windows: build only), `.github/workflows/release.yml` (publish on tag, npm provenance), issue templates.
- package.json final: keywords, repository/homepage/bugs, `files: [dist, skills, README, LICENSE]`, engines `>=20`, bins `cchandoff`+`cch`; `npm pack` dry-run audit.

**Acceptance:** `npm pack` tarball contains exactly the intended files; README renders (no broken links among docs); CI yaml validates (actionlint if available, else careful review); fresh-clone `npm ci && npm run build && npm test` green.

## Phase 6 — Live validation & release (with the user)

1. `cchandoff doctor` on the real machine; `profile add work` + login with the Team account; `init`.
2. Run the measure-switch protocol once for real (user-approved token spend, est. <5% of one 5h window on A, ~2% on B); fill EVALUATION.md.
3. User publishes: `gh repo create` + push + `npm publish` (commands prepared, human executes — ADR-006).

**Definition of done:** a stranger with two accounts can `npm i -g cchandoff`, follow the README for 5 minutes, switch accounts mid-project, and see a measured first-turn cost an order of magnitude below a naive switch — with every claim in the README backed by docs/research or their own `cchandoff audit` output.
