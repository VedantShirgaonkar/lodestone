# warmswap — Architecture

**One sentence:** warmswap makes crossing a Claude Code account boundary cost ~2k tokens instead of ~2× your whole context, by pairing isolated per-account profiles with automated, measured context handoffs.

**What it is NOT:** it does not and cannot preserve Anthropic's server-side prompt cache across organizations (impossible by design — see ADR-001). It does not touch credentials. It does not proxy or intercept API traffic. It is a local workflow tool over documented Claude Code surfaces: `CLAUDE_CONFIG_DIR`, transcript JSONL, hooks, skills, statusline, headless CLI.

## System overview

```
                       ┌────────────────────────────────────────────┐
                       │            warmswap CLI (Node, 0 deps)    │
                       │                                            │
 ┌───────────────┐     │  profiles   snapshot   switch    status    │
 │ ~/.config/     │◄───┤  registry   engine     orchestr. & audit   │
 │  warmswap/    │    └──────┬─────────┬──────────┬─────────┬──────┘
 │  config.json   │           │         │          │         │
 └───────────────┘           ▼         ▼          ▼         ▼
        profile A     ┌──────────┐ ┌─────────┐ ┌────────┐ ┌─────────┐
        profile B ──► │ CLAUDE_  │ │project/ │ │ spawns │ │ reads   │
        (config dirs) │ CONFIG_  │ │.claude/ │ │ claude │ │ *.jsonl │
                      │ DIR env  │ │handoff/ │ │  CLI   │ │ usage   │
                      └──────────┘ └─────────┘ └────────┘ └─────────┘
                                        ▲                      │
             Claude Code hooks ─────────┘◄─────────────────────┘
             (SessionStart inject · SessionEnd/PreCompact auto-snapshot)
```

## Components

### 1. Profile manager (`core/profiles.ts`, `commands/profile.ts`, `commands/launch.ts`)
- Registry in `~/.config/warmswap/config.json`: `{ "profiles": { "<name>": { "configDir": "<abs path>", "label": "..." } }, "settings": {...} }`.
- `warmswap profile add <name>`: creates `~/.claude-profiles/<name>/`, registers it, offers `warmswap <name> /login`. **The existing `~/.claude` is adopted in place as the first profile** (no migration, history intact).
- `warmswap <name> [claude args…]`: `exec`s `claude` with `CLAUDE_CONFIG_DIR=<dir>` in the current cwd. Auth isolation is guaranteed upstream: macOS Keychain entries are keyed by sha256(config dir); Linux/Windows keep `.credentials.json` inside the dir. warmswap never reads either.
- Optional shared auto-memory: `profile link-memory` sets `autoMemoryDirectory` in each profile's settings.json to one shared path, so Claude's learned notes cross accounts (local markdown, no billing).

### 2. Transcript reader (`core/transcript.ts`)
- Streams JSONL (`node:readline`), tolerant of unknown line types/fields (forward compat) and malformed lines (skip+count).
- Reconstructs the main thread: filter `isSidechain`, order by `parentUuid` chain fallback timestamp, dedupe streamed assistant lines by `message.id` (keep last), respect `compact_boundary`/`isCompactSummary`.
- Exposes: messages, tool_use events, per-turn usage, last-turn context size (`input + cache_read + cache_creation` of final assistant turn), session meta (id, slug, model, gitBranch, cwd, version, first/last timestamps).
- Session discovery: newest `*.jsonl` under `<configDir>/projects/<munged-cwd>/` (munge = `/`→`-`), or explicit `--session`.

### 3. Snapshot engine (`core/extract.ts`, `commands/snapshot.ts`) — deterministic, zero tokens
Extracts from the main thread:
- **Goal**: first substantive user prompt (skip `isMeta`/command wrappers) + last 3 user prompts.
- **Task state**: latest `TodoWrite` input (statuses preserved).
- **Files in play**: Edit/Write/NotebookEdit targets (ranked by edit count), top Read/Grep targets.
- **Conclusions**: final assistant text block + latest `isCompactSummary` body if present (already an LLM summary — free to reuse!).
- **Environment**: git branch + `git status --porcelain` summary at snapshot time; cwd; model.
- **Metrics**: context tokens at snapshot, turn count, session duration — feeds the tax math.
Output: `.claude/handoff/latest.md` (human-readable markdown, YAML frontmatter: created/source_profile/source_session/branch/context_tokens) + `latest.meta.json` (machine state incl. `consumed`) + timestamped copy in `.claude/handoff/archive/`. Auto-snapshots (hooks) write to `.claude/handoff/auto/<session>.md`; explicit handoffs always outrank autos.

### 4. LLM distillation (optional, `--distill`; `core/claudeCli.ts`)
`claude --resume <session> --fork-session -p "<distill prompt per HANDOFF template>" --max-turns 1` executed **on the source profile**, where the conversation is still ~all cache reads (0.1×). Fork keeps the real session untouched. Guard: if the session's last activity is >55 min old (1h TTL nearly lapsed), refuse by default with an explanation (`--force` overrides) — distilling against a cold cache would itself cost a full 2× rewrite. Distilled prose replaces the skeleton's narrative sections; deterministic facts (files, todos, git) are kept verbatim.

### 5. Rehydration (hooks; `commands/hook.ts`, installed by `commands/init.ts`)
- **SessionStart** (matchers `startup`, `clear`): if `.claude/handoff/latest.md` exists for this cwd, is unconsumed, and is younger than `maxAgeDays` (default 7): emit `{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "<framed handoff>"}, "systemMessage": "warmswap: restored handoff (…tokens, from <profile>, <age>)"}`, then mark consumed. The framing wrapper tells Claude what this block is and instructs it to verify current file/git state before trusting details.
- **SessionEnd** + **PreCompact**: run `warmswap hook session-end --transcript <path>` → auto-snapshot. Budget <2s, exit 0 always (failures logged to `~/.config/warmswap/warmswap.log`, never surfaced as session errors).
- Installed at **user level per profile** (each profile's `settings.json`) by `warmswap init`; `--project` variant writes `.claude/settings.json` for team-shared setups. Settings edits are surgical read-modify-write with `.bak` backup and strict JSON validation; refuse on unparseable files.

### 6. Switch orchestrator (`commands/switch.ts`)
`warmswap switch <profile> [--distill] [--stay]`:
1. Locate active project + freshest session on the *current* profile (env `CLAUDE_CONFIG_DIR` or registry default).
2. Snapshot (± distill). 3. Print the measured delta: handoff tokens vs live context tokens, est. % of 5h window saved. 4. Launch target profile in same cwd (SessionStart hook injects). `--stay` skips the launch (prepare only).
Inside a session, the `/handoff` **skill** (project-installable) does the same capture conversationally, then tells the user the one command to run.

### 7. Meter & audit (`core/usage.ts`, `commands/status.ts`, `commands/audit.ts`, `commands/statusline.ts`)
- Weighted burn: `input×1 + cache_creation×2 + cache_read×0.1 + output×5`, × per-model price ratio (static table, overridable), summed over each profile's JSONLs in the current 5h window (window start = first message after last ≥5h gap — documented approximation).
- `status`: per-profile window bars, live session context sizes, current switch-tax estimate, freshness of cache (minutes since last turn vs 1h TTL).
- `audit`: finds boundary events (explicit handoff records; heuristic: same project, profile A session ends → profile B session starts within 30 min) and reports *actual* first-turn write cost on B vs context abandoned on A → "this switch cost X, naive would have been Y". This is the built-in honesty mechanism.
- `statusline`: single-line renderer for Claude Code's statusLine (profile · context% · window burn · "switch now costs ~N%").
- All figures labeled *estimates*; `/usage` remains authoritative.

### 8. Doctor (`commands/doctor.ts`)
Checks: `claude` on PATH + version ≥ 2.0; profiles resolvable + logged-in marker (`.claude.json` `oauthAccount` presence only — never credentials); hooks installed & executable; handoff dir writable; JSONL parse sanity on newest session; statusline wiring. Exit non-zero on failure for scriptability.

## Data contracts

- **Handoff markdown**: sections `Goal`, `State of work`, `Key decisions & constraints`, `Files in play`, `Last exchange`, `Next steps`, `Open questions`. Target ≤ 2,500 tokens (hard cap 4,000; truncate oldest-first with notice).
- **`latest.meta.json`**: `{schema: 1, created, sourceProfile, sourceSession, project, branch, contextTokens, distilled: bool, consumed: bool, consumedBy?: {profile, session, at}}`.
- **warmswap config**: `{schema: 1, profiles: {...}, settings: {maxAgeDays, injectOn: ["startup","clear"], autoSnapshot: true, weights: {...}}}`.

## Failure philosophy

Hooks never break sessions (exit 0, log file). Parsers never crash on unknown schema (skip + count + doctor warning). Settings edits always back up. Anything that spends tokens (`--distill`) is opt-in, states its estimated cost first, and refuses cold-cache runs without `--force`. No network calls of our own, no telemetry, no credential access — the security story is "read your own local files, set one env var, spawn `claude`".

## Platforms

macOS + Linux first-class; Windows best-effort (pure-Node paths, no shell tricks; CI compile+unit only). Node ≥ 20. Zero runtime dependencies (ADR-004).
