# Changelog

All notable changes to the lodestone VS Code extension are documented here.

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
