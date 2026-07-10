# ADR-005: Handoff state lives in the project (`.claude/handoff/`), gitignored by default

**Status:** accepted · 2026-07-10

## Context
The handoff must be found by a SessionStart hook running under *either* profile, for the right project. Candidate homes: inside a config dir (wrong — profile-scoped), a global cchandoff dir keyed by project path (works, but invisible to users and to git), or in the project itself.

## Decision
`<project>/.claude/handoff/` — `latest.md` + `latest.meta.json` + `archive/` + `auto/`. Profile-agnostic by construction (both profiles see the same cwd), transparent (it's markdown next to your code), and optionally committable: teams/cross-device users can commit the directory and get antonwing77-style git relay for free. `cchandoff init` adds `.claude/handoff/` to `.gitignore` by default (handoffs can contain conversation fragments — private by default; opting into committing is one deleted gitignore line, documented).

## Consequences
- Non-project sessions (cwd without write access / throwaway dirs) can't persist handoffs → v1 documents this; global-fallback dir is a possible v1.1.
- Consumed-flag lives in `latest.meta.json`, so "inject once" works even when two sessions start concurrently (best-effort; a stale double-injection is harmless and visible).
