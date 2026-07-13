# Changelog

All notable changes to the lodestone VS Code extension are documented here.

## [0.1.1] - 2026-07-13

### Added

- Terminal execution for all actions: Handoff & Switch, Keep Warm, Refresh, Trail Mode, etc.
- Live data refresh: calls `lodestone status --json` on every popover update to keep usage bridge fresh
- Audit totals display with per-class breakdown (switch/refresh/post-reset counts)
- New popover design: markdown table with Window, Usage, Resets columns

### Changed

- Popover layout: quota bars now use colored emoji (🟩 under 50%, 🟧 50-84%, 🟥 85%+)
- Savings display: shows token count in abbreviated format (e.g., ~1.2M) with per-class counts
- Cache warmth: inline per-project display instead of separate section header
- Reset countdown: cleaner `-` when unknown instead of stale times
- Trail mode toggle: now checks current status before offering toggle

### Fixed

- Restore safe CLI execution via `spawnSync` with shell:false and argument array (no string command assembly)

## [0.1.0] - 2026-07-12

### Added

- Initial release: one status bar item showing account profile and quota (5h/weekly %)
- Tooltip popover with per-profile quota bars, reset countdowns, cache warmth, and savings
- QuickPick menu with five actions: Handoff & Switch, Keep Warm, Dashboard, Refresh, Enable Real Usage
- Graceful degradation when CLI is missing
- `fs.watch` on profile usage caches + 30s fallback interval for live updates
- Warning background color when any profile crosses advisor thresholds
- Pure-logic model layer unit-tested with node:test (no vscode dependency)
- Full TypeScript, zero runtime dependencies
