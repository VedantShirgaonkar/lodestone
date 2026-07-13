# Pull Request

## Description

Brief summary of the changes. What problem does this solve or what does it add?

## Related issue(s)

Fixes #(issue number) or Refs #(issue number)

## Testing

How have you verified this change works?

- [ ] `npm test` passes (all tests green)
- [ ] Relevant unit tests added or updated
- [ ] Integration test added (if CLI or filesystem touched)
- [ ] Tested against your own real profiles (if applicable)

## Checklist

- [ ] No new runtime dependencies added (`npm ls --production` unchanged)
- [ ] Fixtures are synthetic (no real transcripts or credentials copied)
- [ ] If this touches hooks, they exit 0 and finish under 2s (test with `--self-test` if applicable)
- [ ] If this spends tokens, it is behind an explicit flag and prints estimated cost first
- [ ] All usage figures labeled `est` (estimates) or sourced (live quota, audit, etc.)
- [ ] Command help and documentation updated if CLI interface changed
- [ ] Commits are atomic and well-messaged (conventional style preferred)
- [ ] If this is a significant design change, a corresponding ADR exists (check `docs/decisions/`)
- [ ] Code links to relevant ADR, research, or ARCHITECTURE where decisions are referenced

## Breaking changes?

No / Yes (describe what breaks and how users should migrate)

## Related docs

Links to relevant ADRs (`docs/decisions/ADR-*.md`), research sections, or architecture notes that inform this change.
