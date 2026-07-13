# Changelog

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
