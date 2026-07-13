<p align="center"><img src="https://raw.githubusercontent.com/VedantShirgaonkar/lodestone/main/assets/lodestone.png" width="128" alt="Lodestone"></p>

# Lodestone for VS Code

Live Claude Code usage and cache monitoring in your status bar, with one click handoffs and account switching. Companion to the [lodestone CLI](https://github.com/VedantShirgaonkar/lodestone).

## What it does

**One status bar item** shows the active profile, the 5 hour quota, the weekly quota, and turns amber as you approach a usage limit.

**Hover it** for a popover with:

- Per profile quota bars for the 5 hour and weekly windows, labeled live or est, with reset countdowns
- Per project cache warmth: minutes remaining before the prompt cache goes cold
- Tokens saved so far, grouped by switch, refresh, and post reset
- An advisor line when any profile crosses your configured thresholds

**Click it** for a menu:

- **Handoff and Switch Account** copies the switch command to your clipboard, ready to run
- **Refresh In Place** writes a handoff so you can clear a bloated session and reload it cheaply
- **Trail Mode** toggles continuous capture, which survives a usage limit that lands mid task
- **Keep Current Account Warm** schedules cheap keepalive pings so the cache does not go cold
- **Open Dashboard** opens the full terminal view

## Requirements

- The lodestone CLI: `npm install -g lodestone-cli`
- VS Code 1.85 or newer

## Settings

- `lodestone.expiryToastMinutes`: warn when a project cache is within N minutes of expiring. Set to 0 to disable, which is the default.

## Privacy

The extension reads local files only: your lodestone config, its usage cache, and transcript timestamps. It makes no network requests of its own, and it never reads, stores, or transmits credentials. Optional real usage data is opt in and handled entirely by the CLI.

## License

MIT. Not affiliated with, or endorsed by, Anthropic or Microsoft.
