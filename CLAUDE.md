# warmswap

Open-source CLI (npm: `warmswap`) solving the Claude Code cross-account "cache tax": per-account profiles via `CLAUDE_CONFIG_DIR` + automated context handoffs + switch-cost measurement. TypeScript, ESM, Node ≥20, **zero runtime dependencies** (dev-only: typescript, @types/node). Tests: `node --test` (no vitest/jest).

## Commands
- `npm run build` — tsc to `dist/`
- `npm test` — build + `node --test test/`

## Source of truth (read before changing anything)
- `docs/PLAN.md` — phased implementation spec with acceptance criteria; current phase status lives here
- `docs/ARCHITECTURE.md` — component design and data contracts
- `docs/decisions/ADR-*.md` — settled decisions; don't relitigate silently
- `docs/research/` — verified facts about Claude Code internals (JSONL schema, hooks, caching); cite these, don't guess

## Hard rules
- No runtime dependencies, ever (ADR-004). No telemetry, no network calls.
- Never read/write/copy credentials or Keychain items; never delete a profile's config dir (ADR-002).
- Hook code paths must always exit 0 and finish <2s; failures go to the log file, never the session.
- Anything that spends API tokens is opt-in behind an explicit flag and prints its estimated cost first (ADR-003).
- All usage/burn figures are estimates and must be labeled as such in output.
- Test fixtures must be synthetic — never copy real transcripts (privacy).

## Layout
`src/cli.ts` dispatch → `src/commands/*` → `src/core/*` (pure logic, injectable I/O) + `src/util/*`. Fixtures in `test/fixtures/`. Skill in `skills/handoff/SKILL.md`.
