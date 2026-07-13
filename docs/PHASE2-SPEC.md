# Phase 2 Command Contracts (binding spec)

Behavioral contract for `snapshot`, `handoff`, `switch`, `status`, `doctor`. The already-accepted commands (`profile`, `launch`, `login`) and the Phase 1 core under `src/core/` are ground truth — read their exports before coding. `docs/ARCHITECTURE.md` §2–§8 and `docs/PLAN.md` Phase 2 remain authoritative where this file is silent.

## Non-negotiable rules

1. **No placeholders, ever.** Every number printed must be computed by the Phase 1 core from real files. Every file written must contain real extracted content. A literal like `const contextTokens = 100000` is an automatic rejection.
2. **Fixture realism.** Any transcript fixture a test plants must use the exact schema of `test/fixtures/session-small.jsonl` (lines with `type:"user"|"assistant"`, content under `message.content`, usage under `message.usage`, ephemeral_1h cache fields). Planting a transcript means placing it at `<configDir>/projects/<mungeCwd(cwd)>/<uuid>.jsonl` using the real `mungeCwd` from `src/core/paths.ts`, where `cwd` is the directory the CLI process runs in.
3. **Integration tests drive the built CLI as a child process** (`node dist/cli.js …` via `execFile`) with env `{HOME, XDG_CONFIG_HOME, CLAUDE_CONFIG_DIR, LODESTONE_CLAUDE_BIN}` pointing into per-test temp dirs, `cwd` set to a temp project dir containing a `.git` marker directory. Never mutate the parent process env; never touch the real `~/.claude`.
4. Any deviation from this spec must be reported as a deviation, not silently shipped. Reports must paste **captured stdout from the actual test run**, never illustrative output.

## Shared plumbing

- Resolve the acting profile: `--profile <name>` flag → else `CLAUDE_CONFIG_DIR` match via `currentProfile()` → else config's first profile; auto-adopt `~/.claude` as `personal` on empty registry (one-line notice to stderr).
- Resolve the project root via `findProjectRoot(process.cwd())`; handoff dir = `<projectRoot>/.claude/handoff/`.
- Token estimate for text: `Math.round(text.length / 3.6)` (single helper, used everywhere).
- All output helpers respect `--json` (machine schema, no ANSI) vs human text (ansi.ts, honors NO_COLOR).

## `lodestone snapshot [--session <id>] [--out <path>] [--quiet] [--json]`

1. `latestSession(configDir, cwd)` (or the explicit `--session` id resolved inside the same project dir; error 1 if not found: `no session found for this project on profile <name>`).
2. `parseSession` → `extractSnapshot` (inject real git info from the cwd: branch via `git rev-parse --abbrev-ref HEAD`, dirty summary via `git status --porcelain | head`, 1s timeout, absent git tolerated → omit section).
3. Render + write via `core/handoffFile` (frontmatter fields per ARCHITECTURE data contract, `latest.md` + `latest.meta.json` + archive copy; `--out` writes the markdown to the given path instead of the handoff dir and skips meta/archive).
4. Human output (2 lines): `snapshot: <path>` and `~<n> tokens · session <slug-or-8char-id> · context <contextTokens> tokens`. `--quiet`: nothing on success. `--json`: `{path, tokens, sessionId, contextTokens, created}`.

## `lodestone handoff [--distill] [--force] [--session <id>] [--json]`

1. Runs the snapshot flow (above) first. Without `--distill`, identical to `snapshot` (it exists as the semantic alias users reach for).
2. `--distill`: compute minutes since the session's last activity (`meta.lastTs`). If > 55, print the cold-cache explanation and exit 1 unless `--force`:
   `distill refused: session idle 73 min — the 1h server cache has likely expired, so distilling now would re-send ~<contextTokens> tokens at full price. Re-run with --force to do it anyway, or use the deterministic snapshot (already written).`
3. Under 55 min (or `--force`): print `distilling on profile <name> (est. ~<contextTokens*0.1 rounded> weighted tokens — cache reads are cheap)…`, then `distill(profile, sessionId, template, {cwd})` from `core/claudeCli`. The template instructs: rewrite the six narrative sections of the handoff per the data contract, ≤2000 tokens, based on the resumed conversation; output ONLY the markdown. Merge: distilled narrative sections replace deterministic ones; `Files in play` and frontmatter stay deterministic. Rewrite `latest.md`, update meta (`distilled: true`).
4. Failure of the distill subprocess: keep the deterministic handoff, print warning, exit 0 (the handoff exists; distillation is best-effort).

## `lodestone switch <profile> [--distill] [--force] [--stay] [--json]`

1. Validate target profile exists (error 1) and differs from current (error 1 with hint).
2. Run the handoff flow (with/without `--distill`, same guards).
3. Compute and print the comparison — every value computed, none hardcoded:
   - `C` = `latestContextTokens(parsed)` of the source session
   - `H` = token estimate of the just-written `latest.md`
   - `tax = switchTax(C, H)` from `core/usage.js`
   ```
   handoff ready: .claude/handoff/latest.md (~1,842 tokens)

   switching personal → work in ~/Desktop/mem
     replaying the conversation there would cost  ≈ 296,400 weighted tokens
     starting fresh with this handoff costs       ≈ 43,700 weighted tokens  (85% less)
     (estimates; cache writes are billed 2× — see docs/explainer)
   ```
4. `--stay`: stop here (exit 0). Otherwise `launchInteractive(target, [], {cwd})` and propagate the exit code. (No hook exists yet in Phase 2, so also print: `tip: paste .claude/handoff/latest.md into the new session, or run lodestone init (Phase 3) for automatic injection` — remove this line in Phase 3.)
5. Edge: no session found on current profile → print `nothing to hand off (no session for this project on <name>)` and, unless `--stay`, still launch the target (exit code from claude). `--json`: `{from, to, handoffPath, handoffTokens, contextTokens, naive, handoff, launched}`.

## `lodestone status [--json]`

Per registered profile, in registry order:
```
personal  ~/.claude                     you@example.com (Personal Org)
  5h window: [████████░░░░░░░░░░░░] ~38% est (started 13:05, ~2h 40m left)
  mem: ctx 157,619 tok · last turn 12m ago (cache warm ~48m left)

work      ~/.claude-profiles/work      not logged in
  5h window: no recent activity
```
- Window line from `windowBurn(configDir, now)`: expired/empty → `no recent activity`; else bar = burn vs `asPctOfWindow(burn, plan)` (plan from lodestone config `settings.plan`, default `pro`; print `est` always).
- One line per project that has a session newer than 24h (cap 3, newest first, project = basename of the munged dir de-munged best-effort): `latestContextTokens`, minutes since `meta.lastTs`, cache-warmth = 60 − idleMinutes (≤0 → `cache cold`).
- Footer when run inside a project with a live source session: `switch tax now: ≈ N weighted tokens naive vs ≈ M with handoff` (same math as switch).
- `--json`: `{profiles: [{name, configDir, login, window: {burn, pct, windowStartIso, minutesRemaining} | null, sessions: [{project, contextTokens, idleMinutes}]}], switchTax: {...} | null}`.

## `lodestone doctor`

Checks, each printing `ok`/`FAIL` + one-line hint, exit 1 if any FAIL:
1. `claude` resolvable (LODESTONE_CLAUDE_BIN honored) and `--version` parses to ≥ 2.0.0.
2. lodestone config parses; ≥1 profile; every profile's configDir exists.
3. Per profile: login hint available (`oauthAccount` present) — missing = FAIL with `run: lodestone login <name>`.
4. Current project's handoff dir writable (create+delete a probe file) when inside a project.
5. Newest session (if any) parses with 0 parse errors (warn-not-fail on >0 but <5% of lines; FAIL above that).
6. Hooks NOT yet checked (Phase 3 will add; print `hooks: not installed (Phase 3 feature)` as info, not FAIL).

## Required integration tests (child-process protocol per rule 3)

- snapshot: plant realistic transcript → run → assert exit 0, `latest.md` sections present (Goal contains the fixture's first prompt text), meta json fields, archive copy exists; `--json` schema; error case (no session) exit 1.
- handoff: `--distill` cold-cache refusal (plant transcript with old lastTs → exit 1, message mentions minutes + --force); `--force` path with `LODESTONE_CLAUDE_BIN` fake that emits a fixed distilled markdown → assert merge (narrative replaced, Files section deterministic, meta.distilled true); fake-claude failure → deterministic handoff survives, exit 0.
- switch: `--stay` full flow → assert handoff file, stdout contains computed numbers matching `switchTax(C, H)` recomputed in the test from the same fixture (no magic constants in assertions), exit 0; non-`--stay` → fake-claude invoked with `CLAUDE_CONFIG_DIR` = target dir (assert from fake-claude's recorded env), exit code propagation (fake exits 3 → switch exits 3).
- status: two profiles, one with fresh activity fixture, one empty → `--json` assertions on burn>0/null window, session context tokens, idleMinutes; human output contains `est`.
- doctor: all-green temp layout → exit 0; then break one thing per case (missing claude bin; unparseable config; profile dir missing) → exit 1 and the specific FAIL line.
