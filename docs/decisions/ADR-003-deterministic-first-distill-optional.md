# ADR-003: Deterministic transcript extraction is the default; LLM distillation is opt-in with a cold-cache guard

**Status:** accepted · 2026-07-10

## Context
A handoff needs to be produced at switch time and at session end (hook). Producing it with an LLM costs tokens on some account every time; producing it deterministically from the transcript JSONL costs zero. Prior-art tools rely on Claude "remembering" to maintain state files (unreliable) or on manual skill invocation (forgettable).

## Decision
1. **Default path is deterministic**: parse the transcript (goal prompts, TodoWrite state, edited files, final assistant conclusions, latest compact summary if any, git state). Runs in <2s inside SessionEnd/PreCompact hooks — handoffs exist *automatically*, always, for free.
2. **`--distill` is opt-in**: `claude --resume <id> --fork-session -p … --max-turns 1` on the **source** profile, where context is ~all 0.1× cache reads. Refuse (unless `--force`) when the session has been idle >55 min: the 1h cache is about to lapse and distillation would trigger the very 2× rewrite we exist to avoid.
3. Compact summaries already present in transcripts (`isCompactSummary`) are harvested for free — they are LLM-quality prose Anthropic already billed for once.

## Consequences
- Hook path can never surprise-bill the user; anything token-spending announces its estimated cost and requires an explicit flag.
- Deterministic output quality is bounded — mitigated by harvesting compact summaries, structured sections, and the injection frame instructing receiving-Claude to verify against the repo. The eval protocol (docs/EVALUATION.md) measures whether deterministic-only handoffs suffice in practice.
