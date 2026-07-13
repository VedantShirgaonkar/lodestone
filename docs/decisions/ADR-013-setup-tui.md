# ADR-013: `lodestone setup` — a guided first-run TUI, hand-rolled with zero dependencies

**Status:** accepted · 2026-07-13

## Context
A skilled developer tried lodestone cold and reported the setup as messy. Auditing the real path proves him right:

1. **Eight steps, none discoverable.** `npm install -g`, `init`, `init --statusline` (a second, separate invocation), `config set realUsage on`, `doctor`, `profile add`, `login`, and an undocumented "restart your session".
2. **Nothing guides the user.** Bare `lodestone` prints a 17-command list under a stale tagline that still describes the pre-generalization product.
3. **The failures are silent.** We hit `EACCES` on the global install ourselves, and `realUsage` was accepting `on` as `false` for days without anyone noticing, because nothing verified it end to end.
4. **No feedback loop.** `doctor` existed but nobody knew to run it, and it reported hooks as unimplemented even once they were installed.

Research (awesome-tuis survey, CLI onboarding practice): almost no CLI ships a formal wizard, and the ones that do (OpenClaw, dbt) are cited as their smoothest first-run experience. The consistent guidance: offer a quick path with sane defaults, disclose complexity progressively, validate each step live rather than at the end, and use color sparingly and semantically. "If everything is a highlight, nothing is a highlight."

## Decision
Ship **`lodestone setup`**: an interactive, guided first run that replaces all eight steps with one command, and make it the first thing the tool tells a new user to do.

- **Hand-rolled, zero dependencies** (ADR-004 is not negotiable): `node:readline` in raw mode for keys, ANSI escapes for rendering. No ink, no blessed, no inquirer.
- **Aesthetic:** a gradient `LODESTONE` block banner (violet to cyan, matching the icon), then a live checklist that fills in as each step completes. Color carries meaning only: violet for brand, cyan for the active step, green for done, amber for a warning, red for a real failure.
- **Every step verifies itself.** Detecting Claude Code prints its version; adopting the profile prints the account it found; enabling real usage immediately fetches the quota and prints the actual number. A step that cannot prove it worked says so.
- **Nothing is done behind the user's back.** Each step states what it will write before writing it, defaults are shown, and every prompt can be declined.
- **Non-interactive safe.** With no TTY (CI, pipes), it prints the equivalent commands and exits 0 rather than hanging.
- Ends by printing exactly what changed, and the one thing the user must do that we cannot: restart the Claude Code session.

## Consequences
- The README's setup section collapses to a single command.
- `doctor` remains for diagnosis; `setup` is for arrival. They share the same checks so they can never disagree.
- The banner and prompt primitives live in `src/util/tui.ts` and are reused by `dash`, which currently has its own ad hoc rendering.
