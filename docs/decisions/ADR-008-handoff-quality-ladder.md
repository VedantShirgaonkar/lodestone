# ADR-008: Handoff quality ladder — LLM-written handoffs are the recommended path; deterministic extraction is the safety net, not the product

**Status:** accepted · 2026-07-12

## Context
User critique (correct): purely deterministic extraction — "basic string matching" — produces mediocre handoffs. Dogfooding confirmed it: on an atypical session the deterministic snapshot yielded "(no goal found)" and a stray "continue" as state. Meanwhile the two LLM paths are cheap at the right moment: an in-session `/handoff` skill costs zero extra (the live model writes the file as a normal turn against a warm cache), and `--distill` via `--resume --fork-session` reads the conversation at 0.1× (fork officially inherits the parent's cache).

## Decision
Three tiers, explicitly ranked, with the product steering users to the top:
1. **Tier 1 (recommended): `/handoff` skill in-session** — live Claude writes the six sections from full conversational knowledge. The advisor (ADR-007 thresholds) nudges this while the session is alive. `switch` output and README teach it as the primary flow.
2. **Tier 2: `lodestone handoff --distill`** — after leaving the session but within the cache TTL; resume-fork distillation, cold-cache guard (>55min idle refuses without `--force`).
3. **Tier 3 (floor, always on, free): deterministic auto-snapshot** — SessionEnd/PreCompact hooks; harvests structure (files, todos, git, compact summaries — themselves LLM prose already paid for) so there is ALWAYS a handoff even when the user forgot everything.

Supporting changes: snapshot output gains a **completeness score** (goal found? decisions? next steps?) and prints "thin handoff — consider /handoff or --distill" when weak; rehydration frame already tells the receiving Claude to verify against the working tree.

## Consequences
- Deterministic extraction quality stops being load-bearing for UX; its job is "never empty-handed."
- The advisor is what makes Tier 1 the *de facto* default — timing beats tooling.
