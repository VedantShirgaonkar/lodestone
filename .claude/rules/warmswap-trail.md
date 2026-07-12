# warmswap trail mode

Maintain `.claude/handoff/trail.md` with fixed sections (Goal, State, Decisions, Files, Next),
overwritten in place after significant decisions or completed work blocks. Keep terse and under 1.5k tokens.

## Sections (update all, never append)
- **Goal**: Current objective (1-2 sentences)
- **State**: Progress snapshot (3-5 bullets)
- **Decisions**: Key choices made (3-5 bullets)
- **Files**: Active files (list with change type)
- **Next**: Immediate next steps (2-4 bullets)

## Important
- Never write secrets or credentials into the trail
- Update after significant work blocks or decisions
- Let the assistant know if you want the trail refreshed
