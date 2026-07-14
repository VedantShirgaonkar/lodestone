# Changelog

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
