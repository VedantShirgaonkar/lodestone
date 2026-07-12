# What this is, in one page

## The delivery form: an npm CLI package that installs its own integrations

This is **not** an MCP server and **not** a VS Code extension (one is planned — see last section). It is a single **command-line program distributed on npm** (`npm install -g …`), zero runtime dependencies. You run it once to set things up; after that it mostly works *through Claude Code itself*, because the setup step plugs three small integrations into Claude Code's official extension points:

```
                     ┌─────────────────────────────────────────┐
                     │        THE NPM PACKAGE (one CLI)        │
                     │                                         │
   you type ───────► │  profile · switch · status · dash ·     │
   commands          │  handoff · keepalive · audit · doctor   │
                     │                                         │
                     │  `init` installs, into Claude Code: ────┼──┐
                     └─────────────────────────────────────────┘  │
                                                                  ▼
              ┌───────────────────────────────────────────────────────────┐
              │              INSIDE EVERY CLAUDE CODE SESSION             │
              │                                                           │
              │  ① HOOKS (automatic, invisible)                           │
              │     · session start → injects your latest handoff        │
              │     · session end / pre-compact → free auto-snapshot     │
              │     · every prompt → advisor checks your quota           │
              │  ② SKILL — type /handoff, Claude writes the handoff file  │
              │  ③ STATUSLINE — live bar: quota % · cache timer · advice  │
              └───────────────────────────────────────────────────────────┘
```

So: **package on the outside, built-in Claude Code features on the inside.** After `init`, a normal day needs almost no terminal commands — the statusline shows state, the advisor tells you when to act, `/handoff` is typed inside the chat, and only the actual account switch is a terminal command (because switching accounts means starting a new Claude process — nothing inside a session can do that).

## What problem it solves (30 seconds)

```
 WITHOUT                                      WITH
 ───────                                      ────
 personal account          work account       personal account          work account
 ┌────────────────┐        ┌─────────────┐    ┌────────────────┐        ┌─────────────┐
 │ 150k-token     │ /login │ re-reads    │    │ 150k-token     │ 2k     │ reads 2k    │
 │ conversation,  │ ─────► │ ALL 150k    │    │ conversation   │ hand-  │ handoff,    │
 │ cheap (cache)  │        │ from zero   │    │ → snapshot     │ off ─► │ starts lean │
 └────────────────┘        └─────────────┘    └────────────────┘        └─────────────┘
                            ≈ 40–80% of a                                ≈ 96% cheaper
                            5-hour window                                (measured)
```

Anthropic's prompt cache is sealed per account (server-side, by design — verified in `research/01`). Nothing can carry the cache across. What crosses instead is a small structured **handoff file**: goal, state, decisions, files in play, next steps.

## Where things live on disk

```
 ~/.claude                       your original account, adopted untouched
 ~/.claude-profiles/work         second account (fully isolated login/history)
 ~/.config/<tool>/config.json    profile registry + settings
 <your project>/.claude/handoff/ the handoff files (readable markdown,
                                 gitignored by default, one per project)
```

## The three data flows

**1 · Switching accounts (the core flow)**

```
 you: /handoff  (or automatic snapshot at session end)
        │
        ▼
 .claude/handoff/latest.md  ←── quality-scored, ~1–2k tokens
        │
 you: `<tool> switch work`  ── prints real cost comparison first
        │                      (e.g. 931k naive vs 42k with handoff)
        ▼
 Claude opens under the work account → start hook injects the handoff
        → Claude continues your task, verifying against the actual files
```

**2 · The advisor (know when to act, before the wall)**

```
 Claude Code natively reports your real quota to the statusline
        │                     (5h % + weekly % + reset times)
        ▼
 statusline shows it live ──► writes a tiny local cache
        │                            │
        ▼                            ▼
 you see: 5h 87% ⚠ handoff?   every prompt, the advisor hook checks it:
                              ≥85%? → one gentle nudge: "cache is warm,
                              /handoff now is cheap, then switch"
```

**3 · Keepalive (optional, for switch-backs)**

```
 switch to work, planning to return ──► `--keep-warm 90m`
 every ~52 min a tiny ping touches the personal session
 → its 1-hour cache clock resets → switching BACK is warm, not a rebuild
 (each ping ≈ 0.1× context, printed before it runs; hard caps; skips if
  the account is already near its limit)
```

## Trust properties (why it's safe to run)

- Zero runtime dependencies — the whole supply chain is the source you can read.
- Never stores, copies, or transmits credentials. The optional "real usage" mode reads your own token locally, asks Anthropic's usage endpoint over TLS, and nothing else — off by default.
- Hooks can never break a session: every path exits cleanly in under ~2s; failures go to a log file.
- Anything that would spend tokens says its estimated cost first and requires an explicit flag.
- Every number it shows is either real (labeled `live`) or an estimate (labeled `est`).

## Where the UX runs today, and what's next

| Surface | Today | How |
|---|---|---|
| Claude Code CLI (terminal) | ✅ | statusline + advisor + `/handoff` inside the session; CLI commands outside |
| Claude Code **VS Code extension** | ✅ same engine | hooks, the `/handoff` skill, and the advisor work identically there (it's the same Claude Code core); terminal commands run in the integrated terminal |
| Dedicated **VS Code companion extension** | 🔜 next build phase | native status-bar quota item + a Quota panel (both accounts side-by-side, cache countdowns, rebuild costs) + one-click "Handoff & Switch" buttons — no terminal needed |

The companion extension stays thin by design: it reads the same data files and shells out to the same CLI, so there is exactly one brain and several faces.
