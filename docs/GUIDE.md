# Lodestone: the user guide

## The one idea

Every expensive moment in Claude Code is a **boundary**: you switch accounts, your 1-hour cache goes cold, a 5-hour or weekly limit resets, or your session gets too bloated to keep. At every one of those, the conversation has to be re-sent to a cache that cannot help you, and that is what shreds your usage window. Lodestone makes the thing that crosses the boundary tiny (a structured handoff instead of the whole conversation), and tells you when to cross while it is still cheap.

## The two halves, and how they talk

The **CLI** (npm `lodestone-cli`, command `lodestone`) owns all the logic and all the data. The **extension** is a thin face: it reads the same files and runs the same CLI. There is one brain.

The important part is what `lodestone init` does: it writes **hooks and a statusline into Claude Code's own settings**, so most of the product runs inside your normal sessions without you typing anything.

```
   your Claude Code session
            |
   hooks + statusline  (installed once by: lodestone init)
            |
            v
   ~/.config/lodestone/config.json        profiles + settings
   ~/.claude/lodestone/usage-cache.json   real quota, per profile
   <project>/.claude/handoff/             handoff files
            |
            +--> lodestone CLI commands
            +--> Lodestone VS Code extension
```

## Passive features: things that happen without you

| Trigger | What it does | What it costs |
|---|---|---|
| **Session starts** (or you `/clear`) | Injects the newest unused handoff into the fresh session, then marks it consumed so it never loads twice | The size of the handoff, typically 1-2k tokens. That is the whole point: 2k instead of replaying 150k |
| **Session ends** or **Claude compacts** | Writes a deterministic snapshot to `.claude/handoff/auto/` by reading the transcript: goal, files touched, todos, decisions, git state | Zero tokens. It reads a file on disk, it never calls the model |
| **Every prompt you send** | The advisor checks your real quota. At **85%** it tells you to hand off while the cache is warm. At **95%** it silently banks a snapshot first, then tells you what to do after the reset | Zero tokens |
| **Every statusline render** | Shows context, cache countdown, both quota windows, and the current switch cost. Also caches your real quota so the CLI and extension can read it | Zero tokens |
| **Trail mode** (only if you turn it on) | Claude keeps `.claude/handoff/trail.md` current as it works, so a limit that lands mid-task never catches you empty-handed | Real cost: roughly 10-40k weighted tokens per session. This is insurance, so it is off by default |

## Active features: things you do

| What you want | CLI | Extension | What actually happens |
|---|---|---|---|
| See where I stand | `lodestone status` | hover the status bar | Quota per profile, live sessions, cache warmth, current switch cost |
| Watch it live | `lodestone dash` | Open Dashboard | Full-screen view, refreshes every 2s |
| Write a handoff now | `/handoff` inside the session | (use the session) | Claude writes the handoff from what it actually knows. Best quality |
| Switch accounts | `lodestone switch work` | Handoff and Switch Account | Captures a handoff, prints the measured cost comparison, launches Claude on the other account, which auto-loads the handoff |
| Shed a bloated session | `lodestone refresh` then `/clear` | Refresh In Place | Writes a handoff, you `/clear`, the fresh session loads it back. Same account |
| Survive surprise limits | `lodestone trail on` | Trail Mode: toggle | Installs the rule that makes Claude maintain a running trail file |
| Come back to a warm cache | `lodestone switch work --keep-warm 90m` | Keep Current Account Warm | Pings the account you left every ~52 min so its 1-hour cache never dies |
| See what you saved | `lodestone audit` | shown in the popover | Every real boundary event, what it cost, what the naive path would have cost |
| Get real quota numbers | `lodestone config set realUsage on` | Enable real usage data | Lets the CLI read your own token locally to fetch your usage. Nothing is stored or sent anywhere else |
| Check the setup | `lodestone doctor` | (terminal) | Verifies the CLI, profiles, logins, hooks, and that transcripts parse |

## Three ways to make a handoff, and when to use which

1. **`/handoff` in the session** (best). Claude writes it from full conversational knowledge. It costs one ordinary turn against a warm cache. Use this whenever the session is still alive: the advisor exists to remind you.
2. **`lodestone handoff --distill`** (good). You already left, but the cache is still warm. It resumes the session in a fork and distills it at cache-read prices (0.1x). It refuses if the session has been idle more than 55 minutes, because by then the cache is nearly dead and distilling would trigger the very rebuild we are avoiding.
3. **The automatic snapshot** (free floor). Always there, written by hooks, extracted from the transcript with no model call. Mechanically honest but thin, so the tools print a quality score and tell you when it is weak.

## Reading the numbers

**`live` vs `est`.** `live` is Claude Code's real quota data (or your own usage endpoint if you opted in). `est` is our local burn model. When there is no live data we show what we measured in weighted tokens and **refuse to invent a percentage**, because a percentage of a plan budget we are guessing at produces nonsense like "9297%".

**Weighted tokens.** Not all tokens cost the same, so we normalize: cache read x0.1, uncached input x1, cache write x2, output x5. It is the unit that reflects what a boundary actually costs you.

**`switch 1.6M -> 45k`.** Replaying this conversation on another account would cost about 1.6M weighted tokens. Starting fresh there with the handoff costs about 45k. That gap is the entire product.

**Cache countdown.** Claude Code keeps your context cached for 1 hour, and every turn resets that clock. `cache 47m` means you have 47 minutes before returning to this session costs a full rebuild.

## A day in the life

You open Claude Code. The start hook injects yesterday's handoff, so Claude already knows where you left off. You work; the statusline sits at `5h ███░░░░░ 34%`.

Late morning the bar turns amber and the advisor speaks up: your 5-hour window is at 85%, and the cache is still warm. You type `/handoff`. Claude writes the file and tells you its size.

You run `lodestone switch work`. It shows you the two numbers, then opens Claude on your work account, where the handoff loads itself. You keep going without re-explaining anything.

Later you come back with `lodestone switch personal`. If you had asked for `--keep-warm`, that cache is still alive and the return is cheap.

At the end of the day, `lodestone audit` reads your own transcripts and tells you what each of those crossings really cost, against what the naive path would have.

## Troubleshooting

**No statusline in Claude Code.** Run `lodestone init --statusline`, then start a new session. Statuslines load at session start.

**Numbers look stale inside VS Code.** Claude Code does not run statuslines in the editor, so nothing refreshes the quota there. Run `lodestone config set realUsage on` and the CLI will fetch live figures itself.

**`doctor` reports failures.** It tells you the fix. Missing hooks means you have not run `lodestone init`. A "not logged in" profile means `lodestone login <name>`.

**The extension says the CLI is not found.** `lodestone` must be on your `PATH` (check with `which lodestone`), or set `LODESTONE_BIN` to its full path. Restart the editor after installing.

## More

[OVERVIEW.md](OVERVIEW.md) for the architecture and data flows. [FEATURES.md](FEATURES.md) for which feature lives on which surface. [explainer/how-claude-code-memory-works.md](explainer/how-claude-code-memory-works.md) for the cache physics this is all built on.
