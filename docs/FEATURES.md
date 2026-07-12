# Feature-presence matrix — where each monitoring feature lives

The user-required informational features, audited per surface. "In-session" means inside a Claude Code conversation — which is the same engine whether you run the CLI in a terminal or the official Claude Code VS Code extension, with one exception noted below.

| Feature | Terminal (CLI commands) | In-session (CLI) | In-session (official VS Code ext.) | warmswap VS Code extension |
|---|---|---|---|---|
| **Intimation: when to hand off** | `status` footer + `dash` advisor line | statusline `⚠ handoff?` glyph **and** advisor message at ≥85%/90% ("cache is warm: /handoff now is cheap…") | advisor message ✅ (hooks run identically); statusline glyph ❌ (see note) | status-bar warning color + advisor line in the popover |
| **Time till warm cache disappears** | `status` ("cache warm ~43m left") + `dash` per-session countdowns | statusline `cache 43m` / `cache cold` segment | ❌ via statusline (note) → covered by companion extension | per-workspace cache countdown lines in the popover |
| **How much a switch costs right now** | `switch` printout (measured, e.g. "≈931,266 vs ≈41,620 (96% less)") + `status` footer + `dash` panel | advisor message names the cheap path | same advisor message ✅ | popover switch-tax line + "Handoff & Switch" action |
| **How much you saved (history)** | `audit` / `audit --json` per-event + totals | — (post-hoc metric) | — | savings totals in the popover (from `audit --json`) |
| **Real quota: 5h/weekly %, resets, pacing** | `status` bars + `dash` (live vs est labeled) | statusline `5h 87%▲87 (2h10m) · wk 25%` | ❌ via statusline (note) → companion ext. or opt-in OAuth | quota bars per profile, both accounts side-by-side, live/est labeled |
| **Handoff quality visibility** | `snapshot`/`handoff`/`switch` print `handoff quality: n/5` + thin-handoff warning | `/handoff` skill writes and reports the file | same ✅ | — (quality shown at creation time by the CLI) |

**The one gap and its fix:** the official Claude Code VS Code extension does not execute custom statusline commands (open upstream feature requests #55643, #20207, #11165, #21265). Hooks and skills work there unchanged — so the advisor intimation and `/handoff` are fully present — but the always-visible bar (quota, cache timer) is not. That's precisely what the **warmswap VS Code extension** restores, natively in the editor's status bar, plus things the statusline can't do: both accounts at once, savings history, and one-click actions.

**Data honesty rule across all surfaces:** every figure is labeled `live` (from Claude Code's native rate_limits feed or the opt-in usage endpoint) or `est` (local burn model); missing data renders as "no data", never as a fake 0%.
