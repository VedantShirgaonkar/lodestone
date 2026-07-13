# Try it — a guided 15-minute validation

A hands-on pass over every feature, ordered so each step proves the next one is worth trusting. Works with one account; the two-account steps are marked.

## 0 · Install & sanity

```bash
npm install -g lodestone-cli     # installs the `lodestone` command
lodestone --version              # -> lodestone 0.1.0
lodestone doctor                 # every line should read ok
```

`doctor` FAILs on "login" until a profile is authenticated — expected on a fresh box.

## 1 · Profiles (your existing account is adopted, untouched)

```bash
lodestone profile list           # your ~/.claude appears as `personal`
lodestone profile add work       # creates ~/.claude-profiles/work
lodestone login work             # opens Claude Code's normal login on that profile
```

Nothing is copied, moved, or deleted: `personal` keeps its history and credentials exactly where they were. `profile remove` only unregisters — it never touches files.

## 2 · Wire the automation (one time)

```bash
lodestone init                   # hooks into every profile
lodestone init --statusline      # optional: live bar inside Claude Code
lodestone config set realUsage on   # optional: real quota for the *other* profile too
```

Now open a Claude Code session in any project. You should see the statusline:

```
⇄ personal · ctx 12% · cache 60m · 5h 8% (4h51m) · wk 3%
```

That single line answers: which account, how full the context is, **how long until the warm cache dies**, and both quota windows with reset countdowns.

## 3 · Watch the monitoring surfaces

```bash
lodestone status                 # per-profile windows + live sessions + switch tax
lodestone dash                   # full-screen live view (q to quit)
```

`dash` is the one to leave open on a second monitor: quota bars with pacing targets, cache countdowns per project, and what a switch would cost *right now*.

## 4 · The cheap single-account test (do this first — costs almost nothing)

In a Claude Code session with real work in it:

1. Type `/handoff` → Claude writes `.claude/handoff/latest.md` and tells you its size.
2. Type `/clear`.
3. Watch the session restart: a system message says *"lodestone: restored handoff (~N tokens…)"* and Claude picks up exactly where you were — without re-reading the whole conversation.

That's the whole thesis, in 30 seconds, on one account. `lodestone refresh` does the same from outside a session.

## 5 · Trail mode (wall insurance)

```bash
lodestone trail on
```

Claude now maintains `.claude/handoff/trail.md` as it works. Do some work, then `cat .claude/handoff/trail.md` — goal, state, decisions, files, next steps, kept current. If a usage limit ever kills a session mid-thought, that file is already there and loads into the next one automatically.

Honest cost: the trail updates spend tokens (~10–40k weighted per session). Leave it off if you rarely hit walls.

## 6 · The account switch (needs the second profile)

With a real working session on `personal`:

```bash
lodestone switch work
```

It captures a handoff, prints the measured comparison — *"replaying the conversation there would cost ≈931,266 weighted tokens · starting fresh with this handoff costs ≈41,620 (96% less)"* — then launches Claude on `work`, where the hook injects the handoff automatically.

## 7 · Prove it saved you something

```bash
lodestone audit                  # every carry event: switch / refresh / post-reset
lodestone audit --json           # same, machine-readable
```

This reads your real transcripts and reports what each boundary actually cost versus what the naive path would have cost. If the numbers aren't there, the tool says so instead of inventing them.

## 8 · Keepalive (optional, when you plan to come back)

```bash
lodestone switch work --keep-warm 90m
```

Pings the `personal` session every ~52 minutes so its 1-hour cache never dies — returning is warm instead of a full rebuild. Every ping prints its estimated cost first, caps out, and skips entirely if that account is near its limit.

## 9 · VS Code

Install the extension (`Lodestone`), then look bottom-right:

```
⇄ personal 5h 24% · wk 25%
```

Hover for the popover: both accounts' quota bars with resets, cache countdowns per folder, and total tokens saved by class. Click for the menu: **Handoff & Switch**, **Refresh In Place**, **Trail Mode**, **Keep Warm**, **Open Dashboard**. Optional: set `lodestone.expiryToastMinutes` to get warned before a warm cache expires while you're away from the keyboard.

## What to report back

- Did the `/clear` rehydration actually continue your work correctly? (quality, not just tokens)
- Do the statusline / dash numbers match `/usage` inside Claude Code?
- Does `audit` find your events?
- Anything that felt confusing — that's a bug in the UX, not in you.
