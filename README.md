<p align="center"><img src="https://raw.githubusercontent.com/VedantShirgaonkar/lodestone/main/assets/lodestone.png" width="120" alt="Lodestone"></p>

<h1 align="center">Lodestone</h1>

<p align="center"><b>Stop paying Claude Code's cache tax.</b><br>Live usage and cache monitoring, context handoffs, and account switching, in one command.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/lodestone-cli"><img src="https://img.shields.io/npm/v/lodestone-cli?color=7c6cba&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/lodestone-cli"><img src="https://img.shields.io/node/v/lodestone-cli?color=7c6cba" alt="node version"></a>
  <a href="https://open-vsx.org/extension/VedantShirgaonkar/lodestone"><img src="https://img.shields.io/open-vsx/v/VedantShirgaonkar/lodestone?color=4ad6f0&label=open%20vsx" alt="Open VSX version"></a>
  <a href="https://github.com/VedantShirgaonkar/lodestone/actions/workflows/ci.yml"><img src="https://github.com/VedantShirgaonkar/lodestone/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="zero runtime dependencies">
</p>

```bash
npm install -g lodestone-cli
lodestone setup
```

> **macOS: install fails with `EACCES: permission denied`?** Your npm prefix points at a root-owned directory (the macOS Node installer does this). Fix it once, no sudo: `npm config set prefix ~/.local`, make sure `~/.local/bin` is on your PATH, then run the install again.

---

## The problem this solves

Claude Code stays affordable because Anthropic caches your conversation on their servers. Cache reads cost about a tenth of normal input. Cache writes cost double. Everything hinges on staying inside that cache.

The cache dies at four moments, and each one is expensive:

1. **You switch accounts.** Caches never cross organizations, so the next turn re-sends your entire conversation to an account that has never seen a byte of it.
2. **Your session goes cold.** The cache lives for one hour. Come back after lunch and the first turn rebuilds everything at double price.
3. **A usage limit resets.** Same thing: you return to a session whose cache is long dead.
4. **Your session gets bloated.** Every single turn re-sends the whole thing.

At 150k tokens of context, one of those moments costs about twenty normal turns. People routinely lose 40 to 80 percent of a five hour window to a single account switch.

**No tool can carry the cache across.** That isolation is enforced on Anthropic's servers, and it exists for good reasons. What a tool can do is make the thing that crosses tiny. Lodestone replaces a 150k token replay with a 2k token handoff, and tells you when to cross while it is still cheap.

---

## What you get

### Live usage in your status line

Run `lodestone init --statusline` once, and every Claude Code session shows this:

```
⇄ personal · ctx 84% · cache 47m · 5h ████░░░░ 69% 1h10m · wk ███████░ 88% · switch 1.6M→45k
```

Which account you are on. How full the context is. **How many minutes until the one hour cache dies.** Both usage windows with real percentages and reset countdowns. And what switching right now would cost you.

### The same thing in your editor

The companion extension puts it in your status bar, with a panel on hover and one click actions.

<p align="center"><img src="https://raw.githubusercontent.com/VedantShirgaonkar/lodestone/main/assets/screenshot-popover.png" width="800" alt="Lodestone quota panel"></p>

It is published on the [**Open VSX Registry**](https://open-vsx.org/extension/VedantShirgaonkar/lodestone), so it installs straight from the Extensions panel in **Cursor, Windsurf, Devin Desktop, VSCodium, Google Antigravity, AWS Kiro, Gitpod, Eclipse Theia**, and other editors built on the VS Code extension model. Search for **Lodestone**.

<p align="center"><img src="https://raw.githubusercontent.com/VedantShirgaonkar/lodestone/main/assets/screenshot-actions.png" width="620" alt="Lodestone actions menu"></p>

### It tells you when to act

At 85 percent of your five hour window, while the cache is still warm and a handoff is still cheap, Claude says so mid session. At 95 percent it quietly banks a recovery snapshot first, so a limit that lands mid task never catches you empty handed.

### It proves what it saved you

```bash
lodestone audit
```

Reads your own transcripts and reports every boundary you crossed, what it actually cost, and what the naive path would have cost.

---

## Setup, once

```bash
npm install -g lodestone-cli
lodestone setup
```

<p align="center"><img src="https://raw.githubusercontent.com/VedantShirgaonkar/lodestone/main/assets/screenshot-setup.png" width="760" alt="lodestone setup"></p>

`setup` is a guided first run. It finds your Claude install, adopts your existing account, and asks before it changes anything: hooks, the live status line, real quota data, a second account, trail mode. Every step verifies itself, so when it says real usage is on, it has already fetched your real numbers and printed them.

Your existing `~/.claude` is adopted as a profile called `personal`. Nothing is moved, copied or deleted. To add a second account:

```bash
lodestone profile add work
lodestone login work
```

Each profile is a separate `CLAUDE_CONFIG_DIR`, so logins, history and settings stay completely isolated from each other.

---

## Every feature, what it does, and when to use it

| Feature | Command | In the extension | What it does | When you want it |
|---|---|---|---|---|
| **Status** | `lodestone status` | hover the status bar | Every account's quota, live sessions, cache warmth, current switch cost | Any time you want to know where you stand |
| **Dashboard** | `lodestone dash` | Open Dashboard | Full screen live view, refreshes every two seconds | Leave it open on a second monitor |
| **Handoff** | `/handoff` in the session | (use the session) | Claude writes a compact summary: goal, state, decisions, files, next steps | Before you cross any boundary. Highest quality, because the model still remembers everything |
| **Switch accounts** | `lodestone switch work` | Handoff and Switch Account | Captures a handoff, prints the measured cost of both paths, opens Claude on the other account, where the handoff loads itself | Your window is nearly spent and you want to keep working on the other account |
| **Refresh in place** | `lodestone refresh` then `/clear` | Refresh In Place | Writes the handoff, you clear the session, the fresh one reloads it | Same account, but the session is bloated or its cache went cold, and continuing would rebuild everything at double price |
| **Trail mode** | `lodestone trail on` | Trail Mode: toggle | Claude keeps a running notes file current as it works | You keep getting caught mid task by a limit. With this on, the notes already exist when the wall hits. It costs real tokens, so it is off by default |
| **Keep warm** | `lodestone switch work --keep-warm 90m` | Keep Current Account Warm | Pings the account you left every 52 minutes so its one hour cache never dies | You are switching but plan to come back within a couple of hours, and want that return to be cheap |
| **Audit** | `lodestone audit` | shown in the panel | Every crossing you made, what it cost, what it would have cost | When you want proof rather than promises |
| **Real usage** | `lodestone config set realUsage on` | Enable real usage data | Reads your own token locally to fetch your true quota from Anthropic | Turn this on. Without it you get estimates, and estimates lag behind |
| **Doctor** | `lodestone doctor` | (terminal) | Verifies the CLI, profiles, logins, hooks, and that transcripts parse | When something is not showing up |

---

## What happens without you touching anything

Once `lodestone init` has run, four things work on their own:

- **A new session loads your last handoff.** Start Claude Code, or type `/clear`, and the waiting handoff is injected automatically. It is marked consumed, so it never loads twice.
- **Ending a session banks a snapshot.** So does compaction. Both read your transcript and write a summary. This costs zero tokens, because it never calls the model.
- **The advisor watches your quota.** It speaks at 85 percent. At 95 percent it banks a snapshot first, then tells you what to do after the reset.
- **The status line stays current.** It also caches your real quota, so the CLI and the editor extension can read it.

---

## Three ways to make a handoff

1. **`/handoff` in the session.** Claude writes it from everything it currently knows. Costs one ordinary turn against a warm cache. Always the best quality, which is why the advisor nudges you to do it while the session is alive.
2. **`lodestone handoff --distill`.** You already left, but the cache is still warm. Resumes the session in a fork and distills it at cache read prices. It refuses if the session has been idle more than 55 minutes, because by then the cache is nearly dead and distilling would trigger the exact rebuild you are avoiding.
3. **The automatic snapshot.** Always there, written by hooks, extracted from the transcript with no model call. Mechanically honest but thin, so the tools print a quality score and warn you when it is weak.

---

## Reading the numbers

**`live` and `est`.** `live` means the figure came from Claude Code's own quota feed, or, with `realUsage` on, straight from your usage endpoint. `est` is a local model. When there is no live data, we show what we actually measured in weighted tokens and refuse to invent a percentage.

**Weighted tokens.** Not all tokens cost the same, so we normalize them: cache read counts 0.1, uncached input 1, cache write 2, output 5. It is the unit that reflects what a boundary really costs you.

**`switch 1.6M→45k`.** Replaying this conversation on another account would cost about 1.6 million weighted tokens. Starting fresh there with the handoff costs about 45 thousand. That gap is the whole product.

**`cache 47m`.** Claude Code keeps your context cached for one hour, and every turn resets that clock. You have 47 minutes before returning to this session costs a full rebuild.

---

## Privacy and safety

- **Zero runtime dependencies.** The whole supply chain is source you can read.
- **Credentials are never stored, copied or transmitted.** With `realUsage` on, the CLI reads your own token locally and asks Anthropic for your own usage. Nothing is sent anywhere else.
- **No telemetry, ever.**
- **Hooks cannot break your session.** Every path exits cleanly in under two seconds, and failures go to a log file instead of your terminal.
- **Anything that would spend tokens is opt in**, prints its estimated cost first, and refuses when the cache is too cold to be worth it.
- **Leaving is one command.** `lodestone uninstall` removes the hooks, the status line and the skill, stops any keepalive, and tells you what it left and how to remove that too.

---

## It works with one account too

Most of this has nothing to do with switching. Cache expiry, limit resets and bloated sessions are the same problem, and `lodestone refresh` solves them the same way: write a handoff, clear the session, and keep working for a fraction of the price.

---

## Install

| | |
|---|---|
| **CLI** | `npm install -g lodestone-cli` ([npm](https://www.npmjs.com/package/lodestone-cli)) |
| **Editor extension** | Search **Lodestone** in your Extensions panel ([Open VSX](https://open-vsx.org/extension/VedantShirgaonkar/lodestone)) |

If the install fails with `EACCES: permission denied`, your npm prefix points at a root-owned directory (common with the macOS Node installer). Fix it once, without sudo: `npm config set prefix ~/.local`, make sure `~/.local/bin` is on your PATH, and run the install again.

The extension works in any editor that reads the Open VSX Registry: Cursor, Windsurf, Devin Desktop, VSCodium, Google Antigravity, AWS Kiro, Gitpod, Eclipse Theia, and others built on the VS Code extension model. It is a thin client. The CLI is the engine, so install that first.

## Documentation

[docs/](docs/) has the full set, in reading order. The three worth knowing about:

- [How Claude Code memory works](docs/explainer/how-claude-code-memory-works.md). The cache physics this is all built on. Worth reading even if you never install anything.
- [The user guide](docs/GUIDE.md). Every feature, when to use it, and how to read the numbers.
- [Evaluation](docs/EVALUATION.md). How the savings are measured, and what the measurement does not prove.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the setup and the handful of rules that are not negotiable (zero runtime dependencies, synthetic test fixtures, hooks that cannot break your session). Design decisions live in [docs/decisions/](docs/decisions/) as ADRs; if a change would overturn one, open an issue first.

Found a security issue? [SECURITY.md](SECURITY.md).

---

Requires Node 20 or newer, and Claude Code 2.0 or newer.

MIT licensed. Not affiliated with, or endorsed by, Anthropic.
