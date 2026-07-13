# ADR-004: TypeScript, Node ≥ 20, zero runtime dependencies, node:test

**Status:** accepted · 2026-07-10

## Context
The tool reads config directories adjacent to credentials and installs hooks that run on every session. Users must be able to trust it at a glance. Target users already run Node (Claude Code requires it). The cc* ecosystem (ccusage, ccstatusline) is TypeScript/npm.

## Decision
- **TypeScript**, compiled with `tsc` to ESM in `dist/`; published to npm as `lodestone` with bins `lodestone` and `cch`.
- **Zero runtime dependencies.** `util.parseArgs` for CLI, `node:readline` for JSONL streaming, `node:child_process` for spawning `claude`, `node:test`/`node:assert` for tests. devDeps: `typescript`, `@types/node` only.
- Node ≥ 20 (18 is EOL; user has 22).

## Consequences
- Supply-chain surface ≈ 0 — a genuine security feature for a hooks-installing tool, and a selling point in the README.
- No commander/chalk conveniences: hand-rolled dispatch table and minimal ANSI helpers (~100 LOC) — acceptable for ~10 subcommands.
- `npx lodestone` works out of the box; no build step for users.

## Alternatives rejected
- Bash+jq (not cross-platform, unreadable at this scope), Go/Rust (distribution friction vs npm-native audience), Bun (extra runtime requirement).
