# Contributing to cchandoff

Thank you for your interest in contributing! This document covers development setup, testing expectations, and the design philosophy behind the codebase.

## Philosophy

- **Zero runtime dependencies** — every new feature must not introduce an npm dependency (ADR-004). Test this with `npm ls --production`.
- **No credentials in tests** — fixtures must be synthetic, never copy-pasted from real transcripts (privacy rule).
- **Hooks must fail safely** — hook code paths must always exit 0 and finish <2s, even on errors (errors logged, not printed).
- **All token spend is opt-in** — any code path that calls the Claude API must be behind an explicit flag and print its estimated cost first (ADR-003).
- **Tests drive acceptance** — new features are proven by integration tests, not just unit tests; use the real JSONL schema and fixture transcripts.

## Development setup

### Prerequisites
- Node ≥20
- npm (comes with Node)
- macOS, Linux, or WSL (native Windows may work but is best-effort)
- A local clone of this repo

### Install & build
```bash
git clone https://github.com/TODO(owner)/cchandoff
cd cchandoff
npm ci                # clean install
npm run build         # tsc to dist/
npm test              # run all tests
```

### Directory layout
```
bin/                  CLI entry point
src/
  cli.ts              main dispatch
  commands/           cchandoff subcommands (profile, switch, status, etc.)
  core/               business logic (profiles, transcripts, usage, handoff extraction)
  util/               helpers (logging, ANSI colors, paths, JSONL parsing)
test/
  *.test.ts           test files (one per module)
  fixtures/           synthetic JSONL transcripts and configs
dist/                 compiled JavaScript (gitignored)
dist-test/            test build with fixtures copied (gitignored)
docs/                 user docs, research, ADRs, architecture
skills/               Claude skills (handoff/)
scripts/              utility scripts (smoke-real.mjs, measure-switch.ts)
```

## Testing

### Run tests
```bash
npm test              # build + test
npm run build         # build only
```

Tests use Node's built-in `--test` runner (no vitest/jest dependencies). See `.test.ts` files for examples.

### Test fixtures: the privacy rule

**NEVER copy real transcripts into fixtures.** Fixtures must be synthetic:

- Use `test/fixtures/session-small.jsonl` as a template: hand-built, small, covers the schema
- If you need a specific edge case (compact summary, sidechain, certain usage patterns), extend an existing fixture
- Never paste a real `~/.claude/projects/*/session*.jsonl` into the repo
- Comment why each fixture exists (`// Tests X behavior with Y tokens`)

Tools to generate fixtures:
```bash
# View the real JSONL schema (private; for reference)
jq . ~/.claude/projects/*/session*.jsonl | head -50

# In tests, you can mock session parsing or build fixture JSON inline
```

### Integration tests
Some tests need to run the CLI against temp directories with fake setups. Pattern:

```typescript
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";

test("switch command orchestrates handoff", async (t) => {
  const tempCfgDir = mkdtempSync(join(tmpdir(), "cchandoff-test-"));
  // Set up fake profiles in tempCfgDir
  // Run: CLAUDE_CONFIG_DIR=tempCfgDir node dist/cli.js switch work
  // Assert output and side effects
});
```

### Child-process stdin rule
When spawning Claude (`launcher`, `distill`, etc.) in tests, use `CCHANDOFF_CLAUDE_BIN=test/fake-claude.sh` env var (or mock via `claudeCli` injectable I/O). Never actually run `claude` in tests unless explicitly validating real-world behavior.

`test/fake-claude.sh` can be environment-scripted (e.g., `FAKE_CLAUDE_EXIT=0 FAKE_CLAUDE_OUTPUT="..."`) for controlled responses.

### Snapshot & golden-file tests
Use for deterministic output (e.g., handoff markdown, status JSON):

```typescript
test("extract produces stable output", async (t) => {
  const result = extractSnapshot(parsed, { cwd });
  t.match(result.markdown, /Goal:/);  // regex match
  // Or: golden file with t.matchSnapshot() or explicit assertion
});
```

Update snapshots only when intentional (e.g., feature change). Include snapshot files in commits so reviewers can see diffs.

## Code organization

### Pure logic vs. I/O
- `src/core/` — pure functions, no I/O at module level, dependency injection for file read/CLI calls
- `src/commands/` — CLI handlers; call core logic, handle errors, format output
- `src/util/` — helpers; logging, ANSI, path munging

Example:
```typescript
// core/extract.ts — pure
export function extractSnapshot(parsed: ParsedSession, { cwd }): SnapshotData {
  return { goal: ..., files: ... };
}

// commands/snapshot.ts — I/O and dispatch
const parsed = await parseSession(sessionPath);
const snapshot = extractSnapshot(parsed, { cwd });
fs.writeFileSync(outputPath, markdown);
```

### Error handling
- Commands: catch, log, return exit code (1 error, 2 usage)
- Hooks: always exit 0, log errors to cchandoff.log (never print to stderr in a hook context)
- Core logic: throw on programming errors; return Result type (or maybe-null) for user-facing failures
- JSONL parsing: never throw on malformed lines; yield `{ error: "...", lineNo: N }`

## Commit style

- **Conventional** (preferred): `feat: add keepalive scheduler` / `fix: audit heuristic off-by-one`
- **Imperative**: describe what the commit does, not what it did
- **Atomic**: one logical change per commit (can be multiple files)
- **Tests first**: add test(s) before or with the feature
- **Sign-off optional** but link issues: `Fixes #42`

Example:
```
feat: implement real-usage OAuth bridge

- Add core/realUsage.ts with getQuota() and opt-in token fetch
- Statusline writes usage-cache.json for hook consumption
- Fallback to JSONL estimates if endpoint unavailable or 429
- Tests: fixture endpoint mock, cache round-trip, degrade behavior

Refs ADR-007
```

## Acceptance criteria for PRs

1. ✅ `npm test` 100% green (no skipped tests)
2. ✅ No new runtime dependencies (verify `npm ls --production`)
3. ✅ Fixture privacy: no real transcripts copied
4. ✅ Hook paths exit 0 (test with `hook --self-test` if applicable)
5. ✅ All estimates labeled `est` / all real data sourced
6. ✅ Commands have `--help` and `--json` support where relevant
7. ✅ Integration test if the feature touches CLI or filesystem
8. ✅ Doc link in code (ADR, research, ARCHITECTURE) where decisions are referenced

## Running against real data (after v0.1)

The `scripts/smoke-real.mjs` script and Phase 7's `measure-switch.ts` protocol allow running the tool against your own accounts for validation. These are **not** required in CI or in dev testing; they're a separate, user-initiated step for live validation.

If you're testing a fix against real data:
```bash
cchandoff doctor                      # sanity check your setup
cchandoff status                      # see live metrics
cchandoff profile list                # verify profiles
# Now test the specific command
cchandoff switch work --stay          # example test command
```

## Performance & resource use

- **Startup**: `cchandoff --version` should respond <100ms
- **Hooks**: <2s (hard limit; monitor via `cchandoff.log`)
- **CLI commands**: <5s for status/audit (network wait may apply if fetching real usage)
- **Dashboard refresh**: 2s (configurable)
- **Log rotation**: 1MB max, one backup (2MB total on disk)

Profile with:
```bash
time cchandoff status                # wall-clock time
strace -c node bin/cchandoff.js ...  # syscall breakdown (Linux)
```

## Feature checklist

Before proposing a major feature:

1. **Is it a clear win for one of the core flows?** (handoff quality, cross-account workflow, measurement)
2. **Can it be implemented with zero new dependencies?** (yes → proceed; no → request exception)
3. **Does it need a hook?** If yes, design with <2s execution and 0-exit.
4. **Is there an ADR for it?** Check `docs/decisions/` first; if no, ADR is required before code.
5. **Can it be tested without hitting the real Claude API?** (fixtures, mocks, etc.)
6. **Is the cost model clear?** (free, or behind `--opt-in` with printed estimate)

## Reporting bugs

Include:
- `cchandoff doctor` output
- `claude --version` output
- Your OS and Node version
- Exact steps to reproduce
- Relevant transcript excerpt or fixture data (no real credentials)

## Questions?

- Read `docs/ARCHITECTURE.md` for component contracts
- Read `docs/decisions/ADR-*.md` for design context
- Check `docs/research/` for ground truth (on Claude Code internals, API behavior)
- Open an issue for clarification

Thank you for contributing! 🙏
