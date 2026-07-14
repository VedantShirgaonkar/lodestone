<p align="center"><img src="https://raw.githubusercontent.com/VedantShirgaonkar/lodestone/main/assets/lodestone.png" width="120" alt="Lodestone"></p>

<h1 align="center">Lodestone</h1>

<p align="center"><b>Live Claude Code usage, cache countdowns, and one click account switching, in your status bar.</b></p>

<p align="center">
  <a href="https://www.npmjs.com/package/lodestone-cli"><img src="https://img.shields.io/npm/v/lodestone-cli?color=7c6cba&label=lodestone-cli" alt="npm version"></a>
  <a href="https://github.com/VedantShirgaonkar/lodestone/actions/workflows/ci.yml"><img src="https://github.com/VedantShirgaonkar/lodestone/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/VedantShirgaonkar/lodestone/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="zero runtime dependencies">
</p>

<p align="center"><img src="https://raw.githubusercontent.com/VedantShirgaonkar/lodestone/main/assets/screenshot-popover.png" width="820" alt="Lodestone quota panel"></p>

> ### This extension is a thin client
>
> The **[`lodestone` CLI](https://www.npmjs.com/package/lodestone-cli)** is the engine: it reads your transcripts, writes the handoffs, and talks to Claude Code. The extension reads the same files and shells out to the same CLI, so there is exactly one brain.
>
> **Install the CLI first, or nothing here will have anything to show you:**
>
> ```bash
> npm install -g lodestone-cli
> lodestone setup
> ```
>
> `setup` is a guided first run: it finds your Claude install, adopts your account, and asks before it changes anything. Every step verifies itself.
>
> **macOS: install fails with `EACCES: permission denied`?** Your npm prefix points at a root-owned directory (the macOS Node installer does this). Fix it once, no sudo: `npm config set prefix ~/.local`, make sure `~/.local/bin` is on your PATH, then run the install again.
>
> **[View on npm →](https://www.npmjs.com/package/lodestone-cli)** · **[Source on GitHub →](https://github.com/VedantShirgaonkar/lodestone)**

---

## Details

Claude Code stays affordable because Anthropic caches your conversation on their servers. Reads from that cache cost about a tenth of normal input, writes cost double, and the cache only lives for one hour. It dies whenever you switch accounts, come back to a cold session, resume after a limit reset, or let a session grow bloated. When it dies, your next turn re-sends the entire conversation at full price. At 150k tokens of context that single turn costs about twenty normal ones, which is how people lose 40 to 80 percent of a five hour window to one account switch.

Lodestone shows you exactly where you stand, warns you before you fall off that cliff, and replaces the expensive replay with a small handoff file that a fresh session picks up automatically.

Works in **Cursor, Windsurf, Devin Desktop, VSCodium, Google Antigravity, AWS Kiro, Gitpod, Eclipse Theia**, and other editors that install from the Open VSX Registry.

---

## Features

### The status bar item

Always visible: which Claude account you are on, your five hour usage, your weekly usage. It turns amber as you approach a limit.

### The panel, on hover

- **Quota bars** for the five hour and weekly windows, with the real percentage, the reset countdown, and a `live` tag when the number came straight from Anthropic
- **Cache warmth** per project: how many minutes remain before your one hour cache dies and returning costs a full rebuild
- **Savings**: what your past account switches and refreshes actually saved you

### The actions, on click

<p align="center"><img src="https://raw.githubusercontent.com/VedantShirgaonkar/lodestone/main/assets/screenshot-actions.png" width="640" alt="Lodestone actions menu"></p>

| Action | What it does | When to use it |
|---|---|---|
| **Handoff and Switch Account** | Captures what you are working on, prints what the switch costs versus replaying everything, then opens Claude on your other account, where that summary loads itself | Your window is nearly spent and you want to keep working on the other account |
| **Refresh In Place** | Writes the same summary so you can clear a bloated or cold session and have the fresh one reload it | Same account, but continuing would rebuild the entire cache at double price |
| **Trail Mode** | Makes Claude keep a running notes file current as it works | You keep getting caught mid task by a limit. With this on, the notes already exist when the wall hits |
| **Keep Current Account Warm** | Pings the account you are leaving every 52 minutes so its one hour cache never dies | You plan to come back within a couple of hours and want that return to be cheap |
| **Open Dashboard** | Opens the full terminal view: both accounts, cache countdowns, switch costs, savings | You want to watch everything at once |
| **Enable real usage data** | Lets the CLI read your own token locally and fetch your true quota from Anthropic | Turn this on. Without it, the numbers are estimates and estimates lag behind |

### And in the terminal, from the same tool

One guided command sets the whole thing up, and every step verifies itself rather than assuming it worked:

<p align="center"><img src="https://raw.githubusercontent.com/VedantShirgaonkar/lodestone/main/assets/screenshot-setup.png" width="760" alt="lodestone setup"></p>

The CLI adds a live status line to every Claude Code session:

```
⇄ personal · ctx 84% · cache 47m · 5h ████░░░░ 69% 1h10m · wk ███████░ 88% · switch 1.6M→45k
```

It also warns you at 85 percent of your window, while a handoff is still cheap, and at 95 percent it quietly banks a recovery snapshot so a limit that lands mid task never catches you empty handed. `lodestone audit` then reads your own transcripts and proves what each crossing really cost.

---

## Settings

- **`lodestone.expiryToastMinutes`**: pop a warning when a project's cache is within this many minutes of expiring. Set to 0 to disable, which is the default.

---

## Privacy

This extension reads local files only: your lodestone config, its usage cache, and transcript timestamps. It runs the `lodestone` CLI as a subprocess for status and audit data. It makes no network requests of its own, and it never reads, stores or transmits credentials. The optional real usage feature is handled entirely by the CLI, which reads your own token locally and asks Anthropic for your own usage, and nothing else.

---

## Requirements

- The `lodestone` CLI: `npm install -g lodestone-cli` (Node 20 or newer)
- An editor that installs from Open VSX, version 1.85 or newer
- Claude Code 2.0 or newer

MIT licensed. Not affiliated with, or endorsed by, Anthropic.
