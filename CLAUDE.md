# lodestone

Open-source CLI (npm: `lodestone-cli`, binary: `lodestone`) plus a companion editor extension (Open VSX: `lodestone`), solving Claude Code's "cache tax": the full-price context rebuild you pay whenever you switch accounts, let the 1-hour cache expire, hit a limit reset, or shed a bloated session. Per-account profiles via `CLAUDE_CONFIG_DIR`, automated context handoffs, live usage monitoring, and measurement of what each crossing cost.

TypeScript, ESM, Node >= 20, **zero runtime dependencies** (dev-only: typescript, @types/node). Tests: `node --test` (no vitest/jest).

## Commands
- `npm run build` : tsc to `dist/`
- `npm test` : build + `node --test` (210 tests)
- `npm run compile --prefix vscode` : the extension (CommonJS, the VS Code host requires it)

## Source of truth (read before changing anything)
- `docs/ARCHITECTURE.md` : component design and data contracts
- `docs/decisions/ADR-*.md` : settled decisions. Do not relitigate silently; if a change overturns one, say so.
- `docs/research/` : verified facts about Claude Code internals (JSONL schema, hooks, caching, usage endpoint). Cite these, do not guess. If something here is wrong, fix the doc in the same change.

## Hard rules
- No runtime dependencies, ever (ADR-004). The whole supply chain must stay readable.
- No telemetry. The only network call in the product is the opt-in `realUsage` fetch, which asks Anthropic for the user's own quota using the user's own token, and goes nowhere else.
- Never read, write or copy credentials or Keychain items. Never delete a profile's config directory (ADR-002).
- Hook code paths must always exit 0 and finish in under 2s. Failures go to the log file, never into the user's session.
- Anything that spends API tokens is opt-in behind an explicit flag and prints its estimated cost first (ADR-003).
- Label every figure with its source: `live` (real quota feed) or `est` (local model). **Never print a percentage of a quantity you do not actually know.** An early build printed "9297%" by dividing measured tokens by a guessed plan budget. When there is no live data, report measured weighted tokens instead.
- Test fixtures must be synthetic. Never copy a real transcript into the repo.

## Layout
`src/cli.ts` dispatch, into `src/commands/*`, on top of `src/core/*` (pure logic, injectable I/O) and `src/util/*`. Fixtures in `test/fixtures/`. Skill in `skills/handoff/SKILL.md`. Extension in `vscode/` (a thin client: it reads the same files and shells out to the same CLI, so there is exactly one brain).

## Things that have bitten us
- **The munged project name is not reversible.** `~/.claude/projects/-Users-alex-code-my-app` could be `/Users/alex/code/my-app` or `/Users/alex/code/my/app`, and a directory with a space in it munges to a dash too. Get the real project root from the transcript's `cwd` field. `newestSessionIn(projectDir)` takes an already-resolved projects dir; `latestSession(configDir, cwd)` takes a working directory and munges it. Passing the former to the latter double-munges and silently resolves to nothing.
- **The munge is every non-alphanumeric, not just `/`.** Claude Code replaces every character outside `[A-Za-z0-9-]` with `-` (spaces, dots, underscores, backslashes, non-ASCII; runs not collapsed). `mungeCwd` implemented only `/` → `-` for four releases, so every per-project command silently found no session in any path containing a space — 3 of 9 real projects on the author's own machine. The extension's `cacheWarmth` duplicated the bug. If you touch the munge, update `src/core/paths.ts` and `vscode/src/model.ts` together.
- **Transcript lines are not all timestamped.** They commonly open with `ai-title` and close with `summary` or `file-history-snapshot`, none of which carry a `timestamp`. Take the outermost lines that actually have one, or every staleness check downstream fails open.
- **`latest.meta.json` is overwritten by the next handoff.** A consumption record that lives only there dies within the session. Archive it beside the handoff, or `audit` outlives its own evidence.
- **Write tests against the real layout.** Twice now, tests were written to match a bug (a parser reading `usage` at the wrong nesting; an audit detector looking for handoffs in a directory that does not exist), so they passed while the feature was dead on real data. If a fixture describes a path or a shape, check it against a real `~/.claude` first.
- **A test that does not invoke the thing it names is worse than no test.** The entire hook suite once built fixtures, declared stdin "complex to mock", never called a hook, and asserted that a file it had just written existed. Five green ticks over a passive layer that had never run. Three bugs shipped underneath it. If a test cannot fail, delete it. Prove a regression test red against the bug before you trust it green.
- **Provenance fields are load-bearing, not decorative.** `sourceSession` is a resume target (`handoff --distill` feeds it to `claude --resume`), `sourceProfile` is the account `audit` reports a crossing *from*, and `project` is the munged root. Writing a display slug, a literal `"auto"`, or the git branch into them silently kills distill, fabricates crossings from accounts that do not exist, and files snapshots under a project named after a branch.
- **Never emit a truecolor escape you have not earned.** A terminal that cannot parse `ESC[38;2;r;g;b` does not ignore it, it reads the parameters as separate SGR codes and paints the result. Apple Terminal advertises `xterm-256color` and has never supported 24-bit color. Ask `stdout.getColorDepth()` and degrade: gradient at 24-bit, the same gradient quantized to the color cube at 8-bit, one flat color at 4-bit.
