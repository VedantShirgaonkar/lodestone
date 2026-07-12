# warmswap — VS Code companion extension

A lightweight VS Code extension that bridges warmswap's account-switching and quota monitoring into your editor's status bar.

## What it does

**One status bar item** shows your warmswap account profile, 5-hour quota %, weekly quota %, and warns when you're approaching usage limits.

**Click the status bar** for a menu:
- **Handoff & Switch Account…** Pick a profile and run the account switch with handoff
- **Keep Current Account Warm…** Keep your current session cache alive while switching
- **Open Dashboard (terminal)** View account details and transaction history
- **Refresh Status** Manually refresh quota display
- **Enable real usage data** Opt in to live quota from Anthropic's API (requires credentials)

**Tooltip popover** shows:
- Per-profile quota bars (5h and weekly) with live/est labels and reset countdowns
- Per-project cache warmth (minutes remaining before cold)
- Total tokens saved (from `warmswap audit`)
- Advisor line if any profile crosses configured thresholds
- Footer hint

The extension reads your warmswap config and profile usage caches locally; it shells out to the CLI for additional data (status, audit). **No webviews, no external requests (unless you opt in to real usage data).**

## Requirements

- **warmswap CLI** installed (`npm install -g warmswap`; or `WARMSWAP_BIN=/path/to/warmswap` env var)
- VS Code 1.85+

## Privacy

- Reads local files: warmswap config, usage cache, transcript directories
- Runs the warmswap CLI via `execSync` (visible in terminal); no hidden API calls
- Optional real usage data is opt-in via `warmswap config set realUsage on`; the CLI reads Anthropic's usage endpoint only over TLS, per ADR-007
- Does not store, copy, or transmit any credentials

## Screenshots

_(Placeholder: status bar item with quota text; tooltip popover; QuickPick menu)_

## Links

- [warmswap repository](https://github.com/your-org/warmswap)
- [CLI documentation](../docs/OVERVIEW.md)
