# Pull Request

## Description
Brief summary of the changes (what problem does this solve?).

## Related issue(s)
Fixes #(issue number)

## Testing
How have you tested this change? Include:
- [ ] `npm test` passes (all tests green)
- [ ] Relevant unit tests added/updated
- [ ] Integration test (if CLI/filesystem touched)
- [ ] Manual testing steps (if needed)

## Checklist
- [ ] Zero new runtime dependencies (`npm ls --production` unchanged)
- [ ] Fixture privacy respected (no real transcripts copied)
- [ ] Hooks exit 0 and finish <2s
- [ ] All token-spend paths are opt-in with cost estimate printed
- [ ] Estimates labeled `est`; real data sourced
- [ ] Command help updated if CLI interface changed
- [ ] Related ADR or docs linked in code comments
- [ ] Commits are atomic and well-messaged

## Breaking changes?
No / Yes (describe)

## See also
Links to relevant docs, ADRs, or research sections.
