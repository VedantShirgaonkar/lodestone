# Contributing to lodestone

## Setup

Prerequisites: Node >= 20, npm, and a local clone of the repo.

```bash
git clone https://github.com/VedantShirgaonkar/lodestone
cd lodestone
npm ci
npm run build
npm test
```

## Directory layout

- `bin/` - CLI entry point
- `src/cli.ts` - main dispatch
- `src/commands/` - subcommands (profile, switch, status, audit, etc.)
- `src/core/` - business logic (profiles, transcripts, usage, handoff extraction)
- `src/util/` - helpers (logging, ANSI, paths, JSONL parsing)
- `test/` - test files (Node's built-in `--test` runner, no vitest/jest)
- `test/fixtures/` - synthetic JSONL transcripts and configs
- `docs/` - user docs, research, ADRs, architecture
- `vscode/` - companion extension source
- `skills/` - Claude skills (handoff/)

## Non-negotiable rules

- **Zero runtime dependencies** (ADR-004). Every feature must work with only TypeScript and Node built-ins. Test with `npm ls --production`. Why: smaller attack surface, auditable supply chain, faster installs.
- **Synthetic fixtures only** (privacy rule). Never copy real transcripts or credentials into `test/fixtures/`. Why: audit trails and real data are sensitive.
- **Hooks exit cleanly** (ADR-002). Hook code paths must always exit 0, finish under 2s, and log errors to `~/.config/lodestone/lodestone.log`, never stderr. Why: a hook failure must never break the user's session.
- **Token spend is opt-in** (ADR-003). Any code path that calls Claude must be behind an explicit flag and print the estimated cost first. Why: users control their API budget.
- **Estimates are labeled** (ADR-007). All usage figures from local heuristics must say `est`. Real figures come from live quota or audit. Why: no broken promises.

## Testing

```bash
npm test              # build + test
npm run build         # build only
```

Tests use Node's `--test` runner. See existing `.test.ts` files for examples. Tests can mock session parsing or build fixture JSON inline.

Integration tests can spawn the CLI against temp directories with fake profiles:

```typescript
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

test("switch command works", async (t) => {
  const tempCfgDir = mkdtempSync(join(tmpdir(), "lodestone-test-"));
  // Set up fake profiles in tempCfgDir
  // Run: CLAUDE_CONFIG_DIR=tempCfgDir node dist/cli.js switch work
  // Assert output
});
```

When spawning Claude in tests, use the `LODESTONE_CLAUDE_BIN=test/fake-claude.sh` env var or injectable I/O mocks. Never run the real `claude` unless explicitly validating real-world behavior.

## Code organization

- `src/core/` - pure functions, no module-level I/O, dependencies injected for file read/CLI calls
- `src/commands/` - CLI handlers, call core logic, format output, handle errors
- `src/util/` - helpers for logging, ANSI colors, path resolution, JSONL parsing

Example:

```typescript
// core/extract.ts: pure logic
export function extractSnapshot(parsed: ParsedSession, { cwd }): SnapshotData {
  return { goal: ..., files: ... };
}

// commands/snapshot.ts: I/O and dispatch
const parsed = await parseSession(sessionPath);
const snapshot = extractSnapshot(parsed, { cwd });
fs.writeFileSync(outputPath, markdown);
```

Error handling: Commands catch, log, and return exit codes (1 for error, 2 for usage). Hooks always exit 0 and log errors. Core logic throws on programming errors or returns Result types for user-facing failures. JSONL parsing never throws on malformed lines; yield `{ error: "...", lineNo: N }`.

## Commits and PRs

Prefer conventional style: `feat: add keepalive scheduler` or `fix: audit off-by-one`. Describe what the commit does (imperative). One logical change per commit. Tests first. Link issues: `Fixes #42` or `Refs ADR-007`.

Example:

```
feat: implement real-usage OAuth bridge

- Add core/realUsage.ts with getQuota() and opt-in token fetch
- Statusline writes usage-cache.json for hook consumption
- Fallback to JSONL estimates if endpoint unavailable
- Tests: fixture endpoint mock, cache round-trip, degrade behavior

Refs ADR-007
```

## PR acceptance criteria

1. `npm test` passes (no skipped tests)
2. No new runtime dependencies (`npm ls --production` unchanged)
3. Fixtures are synthetic (no real transcripts copied)
4. Hook paths exit 0 (test with `--self-test` if applicable)
5. Estimates labeled `est`, real data sourced and cited
6. Commands have `--help` and `--json` support where relevant
7. Integration test added if CLI or filesystem touched
8. Code links to ADR, research, or ARCHITECTURE where decisions are referenced

## Running against your own data

After setup, you can test against your real profiles safely:

```bash
lodestone doctor                    # verify everything is wired
lodestone status                    # see live metrics
lodestone profile list              # check profiles exist
# Now test the specific command you're working on
lodestone switch work --dry-run     # example
```

Before opening a PR, read:
- `docs/ARCHITECTURE.md` for component contracts
- `docs/decisions/ADR-*.md` for design context
- `docs/research/` for verified facts about Claude Code internals

Questions? Open an issue.
