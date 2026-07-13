<p align="center"><img src="https://raw.githubusercontent.com/VedantShirgaonkar/lodestone/main/assets/lodestone.png" width="128" alt="Lodestone"></p>

# lodestone

> Switch Claude Code accounts without torching your usage limits: isolated per-account profiles + automated context handoffs, measured.

**Status:** v0.1.0 pre-release: feature-complete, 130 tests, dogfooded on real sessions; live two-account validation in progress (see [docs/EVALUATION.md](docs/EVALUATION.md)). Zero runtime dependencies. MIT.

---

## The problem

Claude Code keeps sessions affordable through Anthropic's server-side 1-hour prompt cache: cache reads cost 0.1×, writes cost 2×. That cache is **sealed inside your account's organization**. Official Anthropic API docs state: *"Different organizations never share caches, even if they use identical prompts."*

When you switch accounts mid-session (via `/login` or by picking another account), your next turn replays the entire conversation as fresh input to an org that has never seen it. At ~150k context tokens, that single turn costs ~20 normal turns. Users report losing **40-80% of a 5-hour usage window** to one switch.

**No local tool can carry the cache across accounts.** This isolation is Anthropic-side and deliberate. What a tool *can* do is make what you carry across tiny.

> **Read the full story:** [docs/explainer/how-claude-code-memory-works.md](docs/explainer/how-claude-code-memory-works.md). It covers the physics of Claude Code layers, cache TTLs, pricing buckets, and why the switch tax exists. Evidence in [docs/research/01-prompt-caching.md](docs/research/01-prompt-caching.md).

---

## What this cannot do

**Preserve the prompt cache across accounts.** Caches are keyed at the organization level and enforced server-side. Switching accounts means a cache miss, always. See [docs/research/01 final verdict](docs/research/01-prompt-caching.md#final-verdict-on-cross-account-cache-access-re-verified-2026-07-12-1000-check) for the full technical audit. 

What lodestone *does* do: **minimize what must cross the boundary**. Replace a ~150k-token conversation replay with a ~2k-token structured handoff.

---

## What lodestone does

### **Profiles.** Isolated accounts
One `CLAUDE_CONFIG_DIR` per account. Your existing `~/.claude` is adopted untouched as `personal`. Create more:

```bash
lodestone profile add work
lodestone login work
```

Profiles are fully isolated: auth, settings, session history, all independent.

### **Handoffs.** Structured context recovery
Three tiers (user follows the recommended path via the advisor):

1. **Tier 1 (recommended): `/handoff` skill in-session.** Write a handoff from live conversation knowledge, to `.claude/handoff/latest.md`. Zero extra cost; runs against a warm cache. The advisor nudges this while the session is alive (see below).

2. **Tier 2: `lodestone handoff --distill`.** After leaving the session but within the cache TTL (≤55 min). Resumes and distills via a fork, reading at 0.1×. Cold-cache guard: refuses if idle >55min without `--force`.

3. **Tier 3 (floor, always on): Auto-snapshot.** Deterministic extraction from transcripts (goal, recent prompts, files, todos, git state, last response) saved by `SessionEnd` and `PreCompact` hooks. Always there, free, no LLM required.

Each handoff includes a completeness score. Thin handoffs print a warning.

### **Rehydration.** Inject the handoff into the target session
On `SessionStart` for the target account, a hook injects the latest handoff as additional context:

```
Restored handoff from work/12 min ago — verify file and git state before relying on details

[handoff markdown body: goal, decisions, files, next steps]
```

The receiving Claude verifies against the live tree and continues. At ~2k tokens this costs ~4k weighted on the next turn vs. ~300k for a naive replay.

### **Switch workflow.** Account handoff in one command
```bash
lodestone switch work
```

This orchestrates: snapshot current session → distill (if desired) → launch Claude under the target account's `CLAUDE_CONFIG_DIR` in the same directory, where the SessionStart hook injects the handoff. It prints a measured cost comparison first. See the [feature tour](#feature-tour--real-captured-output) for real captured output (96% less on a real 450k-token session).

### **Advisor.** When to handoff, before the limit
Watches your real usage quota (real data from Claude Code's statusline or opt-in OAuth endpoint). At ≥85% of 5-hour window (or ≥90% weekly), emits a nudge:

```
⚠ lodestone: 5-hour window at 87% — cache is warm.
  Use /handoff in-session (free), then: lodestone switch work
```

Shows once per 5%-step per session. Never blocks.

### **Measure.** See what your past switches actually cost
```bash
lodestone audit
```

Scans your profile history for explicit handoff events (via `consumedBy` metadata) and heuristic boundaries (same project, A→B within 30 min). Reports per event:

```
Session A → B (2026-07-12 14:22)
  Context abandoned:        142k tokens
  First-turn cache_creation on B: 285k tokens
  Naive estimate:           ~6% of window
  With handoff estimate:    ~0.8% (from audit metadata)
  Observed savings:         ~85%
```

### **Dashboard.** Live profile and session view
```bash
lodestone dash
```

Full-screen ANSI TUI (q to quit, 2s refresh):
- Real usage quota per profile (5-hour & weekly bars with resets, pacing marker)
- Live sessions: project, context tokens, cache TTL countdown
- Switch-tax panel: naive vs. handoff cost for the current project
- Advisor line: nudge state and keepalive status

`lodestone dash --once` for a single frame (test/CI use).

### **Keepalive.** Warm cache on switch-back
When switching to account B intending to return to A, the cache on A dies after 1 hour idle. A periodic "ping" on A (via `--resume --fork-session --max-turns 1`) costs ~0.1×C weighted and refreshes the TTL:

```bash
lodestone switch work --keep-warm 90m
```

Schedules 3 pings (default, configurable) at 52-minute intervals over 90 minutes. Each ping prints its cost before running. Skipped if A's 5-hour window ≥80% (guardrail: don't burn tokens).

Standalone: `lodestone keepalive personal --for 5m` / `--stop`.

---

## Works with a single account too

Even on one account, your cache expires (B2: >1 hour idle) and resets (B3: 5-hour or weekly limits). The same handoff mechanism that crosses accounts works within the account:

- **B2 (cache expiry >1h):** Use `lodestone refresh` to capture a handoff, then `/clear` the bloated context. The session-start hook injects the handoff, and you resume from a clean slate at ~2k tokens instead of replaying ~150k.
- **B3 (wall: 5h or weekly limit):** Enable `trail mode` (`lodestone trail on`) to capture continuously during a session with fixed sections (goal, state, decisions, files, next), capped at ~1.5k tokens. When the limit resets, start a fresh session and the trail loads automatically. It's the same cheap re-entry. Cost: ≈10-40k weighted per session (one to four ordinary turns), which is insurance for the wall surprise. Trail is opt-in; documented costs up-front.
- **Refresh in VS Code:** The companion extension adds "Refresh In Place…" to the menu, wiring `lodestone refresh` without leaving the IDE.

The tool's honest scope for single-account users: **every boundary (cache expiry, wall, voluntary shed) now costs ≈2×(S+H) instead of ≈2×C**, where S is session preamble (~15-25k), H is carried state (~1-2.5k), and C is live context (~100-450k). That's the win whether you switch accounts or stay on one. Without a handoff, the first turn after a boundary replays the whole conversation.

For B4 (voluntary shed with warm cache), native `/compact` is cheaper and recommended. The advisor tells you so.

---

## Quickstart

**Install:**
```bash
npm install -g lodestone-cli
```

Or use via `npx`:
```bash
npx lodestone --help
```

**One-time setup:**
```bash
# Add your two accounts
lodestone profile add work  # default: ~/.claude-profiles/work
lodestone login work

# Install hooks into all profiles
lodestone init

# (optional) Enable real usage data from Anthropic endpoint
lodestone config set realUsage on
```

**Daily flow:**
1. Work on `personal` (or `work`)
2. When the session is alive and you want to switch: type `/handoff` (Tier 1, recommended) or run `lodestone handoff --distill` (Tier 2)
3. Run `lodestone switch work`
4. Claude on `work` sees the handoff and continues

**Check status anytime:**
```bash
lodestone status        # per-profile burn, active sessions, switch cost
lodestone dash          # live TUI (or --once for one frame)
lodestone doctor        # diagnose setup
```

---

## VS Code extension

A lightweight VS Code companion extension brings lodestone quota monitoring and account switching into your editor's status bar, without leaving the IDE.

**What it shows:**
- Status bar item with current profile, 5h quota %, and weekly quota %
- Click for a menu: Handoff & Switch, Keep Warm, Open Dashboard, Refresh, Enable Real Usage
- Tooltip popover with per-profile quota bars (live/est labeled), cache countdown, savings, and advisor warning

**How to install:**

Once published to the VS Code Marketplace:
```bash
# Search "lodestone" in VS Code Extensions, or
code --install-extension lodestone-vscode
```

For manual installation from source (or pre-release .vsix):
```bash
# Build: cd vscode && npm install && npm run compile
# Package: npx @vscode/vsce package
# Install: code --install-extension lodestone-vscode-0.1.0.vsix
```

**Requirements:**
- lodestone CLI installed: `npm install -g lodestone-cli` or `LODESTONE_BIN=/path/to/lodestone` env var
- VS Code 1.85+

**Privacy:** Reads your local lodestone config and usage cache; runs the CLI in the integrated terminal; makes no external requests except when you opt in to real usage data (which reads Anthropic's usage endpoint per ADR-007). No credentials stored or transmitted.

**Note:** The official Claude Code extension doesn't execute custom statuslines (anthropic/claude-code #55643), so quota data is not visible there. The lodestone companion extension bridges this gap by reading the same local usage cache and CLI.

---

## Feature tour: real captured output

Everything below was captured verbatim from a real machine during development (a ~450k-token working session on the 1M-context model). Your numbers will differ; the shapes won't.

### `lodestone switch work --stay`
```
handoff ready: .claude/handoff/latest.md (~810 tokens)

switching personal → work in /Users/rahul/Desktop/mem
  replaying the conversation there would cost  ≈ 931,266 weighted tokens
  starting fresh with this handoff costs       ≈ 41,620 weighted tokens  (96% less)
(estimates; cache writes are billed 2× — see docs/explainer)
```

### `lodestone status`
```
personal  /Users/rahul/.claude      you@example.com (Your Organization)
  5h window: [█████████████░░░░░░░░░] 60% est
  started 14:46, ~297m left
  mem: ctx 455,970 tok · last turn 0m ago (cache warm ~60m left)

switch tax now: ≈ 911,940 weighted tokens naive vs ≈ 42,408 with handoff
```
(email redacted; `est` marks the local burn model: with real `rate_limits` data the bar is labeled `live`)

### Statusline (in Claude Code, with real quota data)
```
⇄ personal · ctx 42% · cache 43m · 5h 87%▲87 (2h10m) · wk 25% ⚠ handoff?
```
`cache 43m` is the session cache TTL (minutes until cold), `▲87` is the pacing target (where linear consumption "should" be), `(2h10m)` the reset countdown, `⚠ handoff?` the advisor at threshold.

### Advisor (UserPromptSubmit hook: shown by Claude Code as a system message)
```json
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"(Claude may suggest running /handoff to write a high-quality handoff while cache is warm, then switching accounts)"},"systemMessage":"lodestone: 5h window at 87% — cache is warm: /handoff now is cheap, then lodestone switch <other>"}
```

### `lodestone dash --once`
```
lodestone dash · 11:30:49 · q quit · r refresh

personal · you@example.com (Your Organization)
  5h [███████████████] 100% 207% · resets in 2h 57m · (est, target 41%)
  wk no recent data · (est)

switch tax: naive ~869526 vs handoff ~45000 (−95%)

⚠ personal: 5h at 207% — consider /handoff
```
(Yes, 207%: the local estimate is honest about a marathon session blowing past a Pro-window budget; bars clamp, text doesn't lie.)

### Keepalive plan (from the integration test fixture, ~3.3k-token session)
```
Keepalive plan for personal:
  Duration: 2h
  Session: sess-123…
  Context tokens: 3300 · Pings scheduled: 1
  Cost per ping: ~330 tokens (~0.1× context)
  Break-even: ping ~330 vs cold return ~6600; worth it if return > 5% likely
  Interval: every 52m
Keepalive started (pid 11019)
```

### `lodestone audit`
On a machine that has never switched profiles yet it honestly reports `No switch events found`; after your first handoff switches it lists each event with context abandoned, actual first-turn cache writes on the target, and the naive-vs-handoff comparison (see `--json` for the schema).

---

## How it works

1. **Profiles.** One `CLAUDE_CONFIG_DIR` per account, isolated via environment. Your existing `~/.claude` is adopted as `personal`. [ADR-002](docs/decisions/ADR-002-profiles-via-config-dir.md)

2. **Handoff format.** Structured extract from live sessions (goal, decisions, files, todos, git state, next steps) serialized to markdown. Always ≤2500 chars. [ARCHITECTURE §3](docs/ARCHITECTURE.md)

3. **Injection.** `SessionStart` hook reads the freshest handoff from the current project and injects it into Claude as additional context. Framing reminds the user to verify against the tree. [ADR-001](docs/decisions/ADR-001-handoff-not-cache-transfer.md), [ARCHITECTURE §5](docs/ARCHITECTURE.md)

4. **Real usage data.** Native Claude Code `rate_limits` (free, in-session) + opt-in OAuth endpoint (cross-profile view, behind `config set realUsage on`). [ADR-007](docs/decisions/ADR-007-realtime-usage-sources.md), [research/06](docs/research/06-realtime-usage-and-ui.md)

5. **Advisor.** Watches quota, nudges `/handoff` while cache is warm (85% of 5h window, 90% weekly). No blocking, debounced. [ADR-007](docs/decisions/ADR-007-realtime-usage-sources.md)

6. **Quality ladder.** Tier 1 (in-session skill, recommended) → Tier 2 (distill, cheap) → Tier 3 (auto-snapshot, free). Completeness score shows which tier was used. [ADR-008](docs/decisions/ADR-008-handoff-quality-ladder.md)

Full explainer: [docs/explainer/how-claude-code-memory-works.md](docs/explainer/how-claude-code-memory-works.md)

---

## Real usage data: two layers

### Layer A: In-session (native, always available)
Claude Code natively passes `rate_limits` (real quota %) into statusline on every render. Our statusline captures it to `~/.config/lodestone/usage-cache.json` so hooks and status can read it without any API call. The advisor uses this.

### Layer B: Cross-profile (opt-in OAuth)
For checking the other account's quota when it's not running a session:
```bash
lodestone config set realUsage on
```

Uses the OAuth access token from your OS keychain (macOS) or credentials.json (Linux). Token is never stored, copied, or sent anywhere except `api.anthropic.com` over TLS. Responses cached ≥180s. Falls back to JSONL estimation if unavailable or 429-limited.

> **Risk disclosure:** This uses an undocumented endpoint (like community tools do). It may change. Never a hard dependency; failures gracefully degrade to estimates. See [SECURITY.md](SECURITY.md) for the full model.

---

## Keepalive: cost and guardrails

When you return to account A after switching to B, the cache is dead if >1 hour idle, costing ~2×C weighted (~300k at 150k context). A periodic 52-minute "ping" on A costs ~0.1×C weighted (~15k) and refreshes the TTL.

**Economics:**
- Ping cost: ~15k weighted tokens (0.3% of Pro 5h window)
- Break-even: 1 return within ~2 hours is worth 1 ping; >5 returns makes it profitable
- Default: 3 pings (works up to ~3h away)

**Guardrails:**
- Never enabled by default. Always explicit: `lodestone switch work --keep-warm 90m`
- Skips if source profile's 5h ≥80% (don't waste quota near the limit)
- Each ping prints cost before running
- `--no-session-persistence` supported (verify empirically in your EVALUATION run)

**Validation required before README claims:** This must be live-tested in Phase 7 to confirm fork-session ping cache behavior matches expectations (fork inherits cache, writes go to 1h tier). See [ADR-009](docs/decisions/ADR-009-cache-keepalive.md) and [EVALUATION.md](docs/EVALUATION.md) for the protocol.

---

## Comparison: lodestone vs. alternatives

| Tool | What it does | What lodestone adds |
|---|---|---|
| **ccusage** (community) | Analytics dashboard on transcripts | Multi-account, handoff workflow, switch advisor |
| **Claude Code statusline** (native) | Shows usage %, recent sessions | Cross-profile view, cache TTL countdown, switch cost est. |
| **cc-switch** (community) | Account switcher for CLI | Context handoff injection, advisor, keepalive, audit |
| **handoff skill** (community) | Manual context extraction in-session | Advisor timing, auto-snapshot fallback, audit trail |
| **Quota VS Code extensions** (10+ in marketplace) | Terminal/editor usage bar | Profiles, cache countdown, switch cost, handoff actions |
| **Multi-account setups** (manual) | Two `CLAUDE_CONFIG_DIR` env shortcuts | Hooks, handoff, automation, measurement |

**Unique to lodestone:**
- Automated, advisor-driven handoff workflow (Tier 1 nudge → Tier 2 distill → Tier 3 fallback)
- Real quota data (in-session + cross-profile opt-in) feeding advisor & dashboard
- Switch-cost measurement & audit trail
- Cache keepalive with safeguards
- Zero runtime dependencies (auditable, offline-capable)

---

## FAQ

### **Do I need two paid subscriptions?**
Yes, both accounts must have their own Pro/Max/Team plan. Organization policies on account sharing are your responsibility to check with your admin. lodestone is a tool for multiplexing your own accounts; it doesn't share credentials.

### **Windows support?**
Best-effort. Built and tested on macOS; Linux works (Keychain replaced by credentials.json). Windows users: Credentials.json path works identically. Hooks should work in PowerShell and WSL. File paths use `\` on native Windows; munging to `-` for project dirs is applied. Report issues with concrete examples.

### **Privacy: does this touch my credentials?**
No, by default. Credentials are never read, written, copied, or transmitted anywhere.

Optional OAuth layer (`config set realUsage on`): reads your OAuth access token **from your local keychain/credentials file only**, uses it to fetch your own usage endpoint from api.anthropic.com over TLS, and caches the response locally. Token never stored or sent elsewhere. See [SECURITY.md](SECURITY.md) for the threat model and reporting process.

### **Single-account use case?**
Yes, effective. Resuming a big session after the 1-hour cache lapses costs the same 2×C rewrite as a cross-account switch. A fresh session + handoff is cheaper.

### **Will the undocumented usage endpoint break?**
Maybe. It's used by community tools and Claude Code itself, but it's not officially documented by Anthropic. We:
1. Treat it as a nice-to-have enhancement, never required (falls back to JSONL estimates)
2. Cache responses ≥180s and respect rate limits
3. Document the risk in the README and SECURITY.md
4. Monitor the community for breaking changes

Safest stance: test on a non-critical account first.

### **Doesn't Claude Code's native prompt cache TTL handle this?**
Yes, within one account. TTL refresh (hitting the cache to reset the 1h clock) is free. We use this in the keepalive feature. But **TTL is per-account**. Switching accounts means cache miss, and there's nothing a client-side tool can do about that. See [research/01](docs/research/01-prompt-caching.md).

### **How do I know it actually works?**
`lodestone audit` shows your past switches + cost deltas. `lodestone status` and `dash` show live metrics. The handoff files themselves (`.claude/handoff/latest.md` and archived versions) are human-readable. We include an evaluation methodology in [EVALUATION.md](docs/EVALUATION.md).

### **Cost of running lodestone itself?**
Zero token cost for the CLI (no API calls except opt-in real-usage endpoint, cached). Hooks run in <2s and exit 0 on failure (logged, never visible). The only token spend is `/handoff` (Tier 1, lives in the session) or `--distill` (Tier 2, optional).

---

## Installation & development

**Install from npm (when published):**
```bash
npm install -g lodestone-cli
```

**Dev setup:**
```bash
git clone https://github.com/OWNER/lodestone   # OWNER: replaced at publish time
cd lodestone
npm ci
npm run build
npm test
```

**Requirements:**
- Node ≥20
- TypeScript 5.7+
- No runtime dependencies (zero external packages in `node_modules` at runtime)

See [CONTRIBUTING.md](CONTRIBUTING.md) for development details and fixture privacy rules.

---

## Support & reporting issues

**Bug reports:** Run `lodestone doctor` and include its output.

**Security issues:** See [SECURITY.md](SECURITY.md) for responsible disclosure.

**Feature requests & discussion:** GitHub issues.

---

## License & attribution

MIT license. Not affiliated with or endorsed by Anthropic.

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Roadmap

- **v0.1** (now): Core CLI, profiles, handoffs, advisor, audit, dash, VS Code companion extension
- **v0.2+** (planned): Enhanced OAuth caching, performance monitoring, community plugins for other editors
- **Future:** Integration with other Claude tools

See [docs/PLAN.md](docs/PLAN.md) for the full phase roadmap and [DIRECTION.md](docs/DIRECTION.md) for strategic context.
