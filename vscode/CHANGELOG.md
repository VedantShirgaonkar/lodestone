# Changelog

## 0.1.8

- **No more "107%".** The quota feed can transiently overshoot right after a limit lands; the panel and status bar now clamp percentages to 100, because a window cannot be more than fully used.
- A short thanks section on the listing. No telemetry means we never see you use this, only the download number: ratings, stars and bug reports are the entire feedback channel.

## 0.1.7

- The install callout now carries the macOS `EACCES` fix up front (root-owned npm prefix from the macOS Node installer; `npm config set prefix ~/.local`, no sudo). A user hit this as their literal first command.

## 0.1.6

Found by a user clicking through every action.

- **Refresh In Place now happens inside the editor.** The handoff is saved in the background, and a new conversation is started in the Claude Code panel, where the session-start hook loads it automatically. No terminal. Falls back to a "type /clear" hint in editors without the Claude Code extension.
- **The trail toggle can now turn trail mode off.** Its status check ran in the extension host's own directory rather than the workspace, so it always answered "not installed" and the toggle was a one-way switch to on. Per-project commands now run in the workspace folder.
- **Menu labels state what will happen**: "Trail Mode: turn off" when it is on, "Disable real usage data" when it is enabled, and a "Keep Warm: stop" entry per running scheduler (pids verified alive, with pings-sent shown). Trail, keep-warm stop and the real-usage toggle run in the background with a notification instead of opening a terminal.
- Handoff & Switch and keep-warm start stay in the terminal deliberately: the switch launches an interactive Claude on the other account, and the keep-warm plan prints its per-ping cost before anything spends.

## 0.1.5

- **Per-model weekly quota rows in the panel.** When the usage endpoint meters a model separately (`seven_day_opus`, `seven_day_sonnet` on plans with per-model caps), the panel shows a `Weekly (opus)` row with its own bar and reset countdown. Handled generically: any bucket the endpoint returns appears, buckets it returns as null render nothing. Requires `lodestone-cli` with `realUsage` on.
- Pairs with `lodestone-cli` 0.5.0, which adds `lodestone uninstall` and the keepalive/skill/munge fixes from the release-gate audit.

## 0.1.4

- **Cache warmth now works for workspaces whose path contains a space, dot or underscore.** Claude Code names its transcript directories by replacing every non-alphanumeric character with a dash; the extension replaced only slashes, so such workspaces munged to a directory that does not exist and their cache read "cold" forever. Requires nothing from you beyond updating.
- Pair with `lodestone-cli` 0.4.0, where the same munge bug (and more) is fixed in the CLI: the "Keep Current Account Warm" action now drives a scheduler that actually exists, and `lodestone init` installs the `/handoff` skill the panel's advice refers to.

## 0.1.3

The extension's own code is unchanged. This release is about what sits underneath it, and what the listing says.

- **Update the CLI: `npm install -g lodestone-cli`.** The Savings section of the panel and the Dashboard were empty for everyone, because the CLI's `audit` had never reported a single event and `dash` never listed a live session. Both are fixed in `lodestone-cli` 0.3.0 and newer, along with the advisor hook, which had never been installed at all. The extension shells out to the CLI for all of this, so updating the CLI is what fixes the panel.
- The listing now explains the thin-client design up front, links to the CLI on npm, shows the guided `lodestone setup` in place of a four-command install, and carries the setup wizard screenshot.

## 0.1.2

Fixes to the quota panel, found by using it.

- **Reset countdowns work.** Every "Resets" cell showed a dash, because the extension was reading a field name the usage cache never wrote. It now shows real countdowns, like `1h 57m` and `2d 10h`.
- **The numbers match reality.** Claude Code's own quota figures lag behind the truth: they are whatever its last API response happened to say. With real usage enabled, the CLI now asks Anthropic directly, so the panel matches your actual usage instead of sitting a few points under it.
- **Stale figures cannot pose as current.** Anything older than a few minutes is labeled rather than presented as live.
- Requires `lodestone-cli` 0.1.1 or newer for the live numbers.

## 0.1.1

- **A real quota panel.** A Window, Usage and Resets table, with a colored bar per window, the reset countdown, a live or est tag, cache warmth per project, and what your past switches have saved you.
- **One click actions**, now including Refresh In Place and Trail Mode.
- **The panel keeps its own numbers fresh** inside the editor, where Claude Code runs no status line of its own.

## 0.1.0

First release.

- A status bar item showing your active Claude account and both usage windows
- A hover panel with quota, cache warmth and savings
- An action menu: hand off and switch accounts, keep the cache warm, open the dashboard
- An optional warning before a project's one hour cache expires
- Reads local files only, runs nothing without you asking, and sends nothing anywhere
