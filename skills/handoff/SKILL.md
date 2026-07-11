---
name: handoff
description: Write a cross-account/session handoff file capturing the current work state, so a fresh Claude Code session (possibly on another account) can continue without replaying this conversation. Use when the user says /handoff, "hand off", "prepare to switch accounts", or wants to preserve context before ending a session.
---

# Session handoff

You are preparing a handoff: a compact, structured state file that lets a *fresh* session — with none of this conversation's context — continue the work. The reader knows nothing you don't write down. Optimize for what the next session needs to act, not for narrating history.

## Steps

1. Determine the project root (nearest ancestor with `.git`, else cwd) and ensure the directory `.claude/handoff/` exists under it.
2. Write `.claude/handoff/latest.md` with YAML frontmatter and exactly these sections:

```markdown
---
created: <ISO-8601 now>
source: skill
project: <absolute project root>
git_branch: <current branch or "unknown">
---

# Session handoff

## Goal / current task
<What the user is ultimately trying to achieve, and the specific task in progress right now. 2-5 sentences.>

## State of work
<Done / in-flight / blocked, as tight bullets. Include verification state: what's tested, what isn't.>

## Key decisions & constraints
<Decisions made this session WITH their reasons, and constraints the next session must not violate. Include approaches that were tried and rejected — that knowledge is expensive to rediscover.>

## Files in play
<Bullet list: path — why it matters right now. Only files that matter for continuing.>

## Last exchange
<The most recent user request and where you left off answering it, condensed.>

## Next steps
<Numbered, concrete, in order. First step should be executable immediately.>

## Open questions
<Anything unresolved that the user must decide, or that needs verification.>
```

3. Keep the whole file under ~2,000 tokens (~7,000 characters). Prefer dropping old history over dropping decisions, constraints, and next steps.
4. If `.claude/handoff/latest.meta.json` exists, update it: set `consumed` to `false`, `created` to now, `distilled` to `true`, and `sourceProfile` to its existing value or `"skill"`. If it doesn't exist, create it with `{"schema": 1, "created": "<ISO now>", "sourceProfile": "skill", "project": "<root>", "distilled": true, "consumed": false}`.
5. Tell the user exactly this, filling in the token estimate (chars/3.6):

> Handoff written to `.claude/handoff/latest.md` (~N tokens).
> To continue on another account: quit this session, then run `cchandoff switch <profile>` — the new session picks the handoff up automatically (or paste the file if hooks aren't installed).

## Rules

- Never include secrets, API keys, tokens, or credential file contents in the handoff.
- Do not copy large code blocks into the handoff — reference file paths; the next session can read files itself.
- Facts you are unsure of get marked `(verify)` rather than stated confidently.
