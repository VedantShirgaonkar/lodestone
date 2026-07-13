# ADR-012: Generalize to all context-carry boundaries — trail mode, refresh flow, advisor escalation, audit classes

**Status:** accepted · 2026-07-12 · Basis: docs/research/07-context-carry-economics.md (user + user's-friend input, verified economics)

## Context
The product handled one boundary well (account switch) while the same machinery — capture → small handoff → fresh-context injection — is what every Claude Code user needs at *every* boundary: cache expiry, 5h/weekly walls, voluntary context shed, machine moves. The friend's "running session log" pattern exposed our one real hole: all our quality capture paths require a live, un-throttled session, so a wall that lands mid-work degrades us to the dumb snapshot.

## Decisions
1. **Trail mode (opt-in capture tier T0):** `lodestone trail on` installs, per project, a rules file + skill instructing Claude to maintain `.claude/handoff/trail.md` — fixed sections overwritten in place, hard cap ~1.5k tokens, terse. The advisor hook measures staleness (file mtime vs session activity) and injects at most one terse update-reminder per threshold crossing. Trail, when fresh, outranks the deterministic snapshot as `freshest()` handoff source (explicit `/handoff` output still outranks the trail). Cost stated honestly in docs: ≈10–40k weighted per session; positioned as wall insurance, default OFF.
2. **Refresh flow (same-account carry):** `/refresh` skill (write handoff → instruct user to `/clear`; the existing clear-matcher injection completes it) + `lodestone refresh` CLI variant for outside-session use. Advisor and docs route users honestly: warm cache + no wall → native `/compact`; cold cache, wall, or cross-account → our refresh/switch.
3. **Advisor escalation:** 85% (config) → existing nudge, now naming the cheapest applicable move; **95% (config `advisor.criticalPct`) → fire the deterministic snapshot inline** (<2s, free) and emit the wall-imminent message with post-reset instructions. Never blocks, still once-per-bucket.
4. **Audit event classes:** `switch` (consumer ≠ source profile), `refresh` (same profile, explicit consumedBy — no longer rejected), `post-reset` (same profile, consumption after a ≥5h quota gap). Same-profile *heuristic* candidates remain rejected (only explicit records count). Savings totals per class surface in status/dash/extension.
5. **Keepalive ceiling config:** `keepalive.maxWindowPct` (default 80) replaces the hardcoded guard; pings never run at/above it.
6. **Extension idle warning (only surface that can):** optional toast when a tracked project's warm cache is within N minutes of expiry (default off, `lodestone-vscode.expiryToastMinutes`).

## Consequences
- The README/positioning changes from "for people with two accounts" to "for every Claude Code user who hits limits", with the two-account story as the flagship case — this at least triples the audience honestly.
- Trail mode's cost/reliability tradeoff is documented rather than hidden; measurement (audit + EVALUATION) covers it like everything else.
- No change to the never-touch-quality rule: all moves happen between sessions/contexts, never inside Claude's reasoning or requests.
