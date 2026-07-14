# Research: Claude Code Internals That lodestone Builds On

> Verified 2026-07-10 on Claude Code v2.1.206 (macOS) + official docs (code.claude.com/docs). Every mechanism below was either observed directly on this machine or quoted from current docs.

## 1. Config directory & multi-account isolation

- Default state root: `~/.claude` (+ top-level `~/.claude.json` for global app state: `oauthAccount`, onboarding flags, per-project state, caches).
- **`CLAUDE_CONFIG_DIR=<path>` relocates the whole state root.** Each config dir gets its own: credentials, `settings.json`, `projects/` (session transcripts), `history.jsonl`, plugins, stats. This is the sanctioned way to run multiple accounts side by side.
- **Credentials:**
  - macOS: Keychain generic password, service `"Claude Code-credentials"`. **The entry is keyed by a SHA-256 hash of the active `CLAUDE_CONFIG_DIR`** — different config dir → different Keychain entry → fully isolated login. (Community-verified: fortunto2 gist "Claude Code multi-account auth switcher", melkon.tech, daring-designs; consistent with the item observed on this machine.)
  - Linux/Windows: `<config-dir>/.credentials.json`, mode 0600.
  - lodestone must **never read or copy credentials** — it only points `CLAUDE_CONFIG_DIR` at a profile dir and lets `claude /login` own auth.
- Caveat (Windows-reported): some global state may still touch `~/.claude.json`; per-profile config dirs each maintain their own `.claude.json` inside the dir. Verify per-platform during testing.

## 2. Session transcripts (the raw material for snapshots)

Location: `<config-dir>/projects/<munged-cwd>/<session-uuid>.jsonl` where `<munged-cwd>` is the working directory path with **every character that is not ASCII alphanumeric or `-` replaced by `-`** (e.g. `-Users-rahul-Desktop-mem`; `/Users/rahul/Desktop/RAIT QA` → `-Users-rahul-Desktop-RAIT-QA`). Spaces, dots, underscores, backslashes and non-ASCII all become dashes; runs are not collapsed; existing hyphens survive. Verified against live entries and anthropics/claude-code#19972, #30828. An earlier version of this doc claimed the rule was `/` → `-` only; code written to that claim could not find sessions for 3 of 9 real projects on the machine it was tested on. One JSON object per line. Observed line `type`s and counts from a real 1059-line session: `assistant` (489), `user` (315), `file-history-snapshot` (108), `attachment` (44), `mode`, `permission-mode`, `last-prompt`, `system`, `queue-operation`.

Key fields (observed v2.1.170–2.1.206):

- Every line: `type`, `uuid`, `parentUuid`, `sessionId`, `timestamp`, `cwd`, `version`, `gitBranch`, `isSidechain`, `userType`, `slug` (session title slug).
- `user` lines: `message` (role/content — string or content blocks incl. `tool_result`), `isMeta` (injected non-user content), `promptId`, **`isCompactSummary: true`** on post-compaction summary messages.
- `assistant` lines: `message` = full API response shape — `model`, `content[]` (blocks: `text`, `thinking`, `tool_use` with `name`+`input`), `stop_reason`, and **`usage`**:
  ```json
  {"input_tokens":2479,"output_tokens":...,"cache_creation_input_tokens":5295,
   "cache_read_input_tokens":12466,
   "cache_creation":{"ephemeral_1h_input_tokens":5295,"ephemeral_5m_input_tokens":0},
   "service_tier":null,...}
  ```
  Streaming writes the same assistant `uuid` across several lines (dedupe by `message.id`/`uuid`, take last).
- Compaction markers: `type:"system", subtype:"compact_boundary"` line, followed by a `user` line with `isCompactSummary: true` containing the summary text.
- Sidechains (subagents): `isSidechain: true` — exclude from main-thread reconstruction.
- Current context size of a session ≈ last assistant turn's `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` (what the model actually received last turn).
- Other per-config-dir artifacts: `history.jsonl` (global prompt history: `display`, `pastedContents`, `project`, `sessionId`, `timestamp`), `todos/`-style task state, `file-history/` (rewind checkpoints), `shell-snapshots/`.

## 3. Hooks (the automation surface)

Configured in `settings.json` (user `~/.claude/settings.json` — i.e. **per config dir**, so per profile), project `.claude/settings.json`, or `.claude/settings.local.json`. JSON output on exit 0; `hookSpecificOutput.additionalContext` injects context.

- **SessionStart** — fires on `startup` / `resume` / `clear` / `compact` (matcher = source). Input: `session_id`, `transcript_path`, `cwd`, `model`, `source`. Output can inject `additionalContext` (string) → **this is lodestone's rehydration channel**: a hook that, when a fresh handoff exists for this project, prints it into the new session's context automatically.
- **SessionEnd** — fires on session termination with `transcript_path`, `cwd`, reason (`clear`, `resume`, `logout`, `prompt_input_exit`, `other`). Side-effects only → **lodestone's free auto-snapshot trigger** (extract state from the transcript; no tokens spent).
- **PreCompact** — before manual/auto compaction; can block; gets `transcript_path` → snapshot-before-compaction insurance.
- **UserPromptSubmit** — can inject `additionalContext` per prompt; 30s default timeout. (Not used in v1; candidate for "switch advisor" nudges.)
- Hook config shape: `{"hooks": {"SessionEnd": [{"hooks": [{"type":"command","command":"...","timeout":10}]}]}}`.

## 4. CLI surface used by lodestone

- `claude` respects `CLAUDE_CONFIG_DIR` (env). Launcher = `exec` with env set; all extra args pass through.
- Headless: `claude -p "prompt"` (print mode), `--output-format json` (result incl. usage/session id) / `stream-json`.
- Resume: `claude --resume <session-id|name>` (per current project dir), `claude -c` (most recent in cwd), both combinable with `-p` (`claude -c -p "..."`). `--fork-session` resumes into a *new* session id (leaves original untouched — used for LLM distillation without polluting the session). `--session-id <uuid>` pins an id.
- `--append-system-prompt "<text>"`, `--settings <file|json>` (session-scoped overrides), `--model`, `--max-turns` (print mode).
- v2.1.206 also supports `--no-session-persistence` (env `CLAUDE_CODE_SKIP_PROMPT_HISTORY`) — useful to keep distillation runs out of history. Verify per-version in `doctor`.

## 5. Statusline (the live meter surface)

`settings.json`: `{"statusLine": {"type": "command", "command": "<script>", "padding": 0}}`. Script gets JSON on stdin per render, including: `session_id`, `transcript_path`, `model`, `workspace`, `version`, `cost` (`total_cost_usd`, `total_input_tokens`, `total_output_tokens`, duration), and **`context_window` (`used_percentage`, token counts, `exceeds_200k_tokens`, `current_usage`)**. First line of stdout is displayed (ANSI colors supported; multi-line supported). → lodestone ships an optional statusline segment: active profile + est. switch tax + window burn.

## 6. Memory & context persistence surfaces

- **CLAUDE.md hierarchy** (load order): managed policy (`/Library/Application Support/ClaudeCode/CLAUDE.md` on macOS) → user `~/.claude/CLAUDE.md` (per config dir!) → project `./CLAUDE.md` or `./.claude/CLAUDE.md` → `./CLAUDE.local.md` (gitignored personal). Parent-dir files load at launch; subdirectory files load on demand. `@path` imports (4-hop max, skipped inside backticks/code fences). HTML comments stripped before injection. Guidance: keep <200 lines.
- **`.claude/rules/*.md`** — modular rules, optional `paths:` frontmatter scoping (load when matching files are touched).
- **Auto memory** (v2.1.59+, on by default): per-project dir `~/.claude/projects/<project>/memory/` — `MEMORY.md` index (first 200 lines / 25KB loaded every session) + topic files read on demand. Setting: `autoMemoryEnabled`, `autoMemoryDirectory`, env `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. **Per config dir → NOT shared across profiles by default.** lodestone option: set `autoMemoryDirectory` to a shared path in both profiles so learned knowledge crosses accounts (it's local markdown, no billing implication).
- **Compaction:** `/compact [instructions]`; auto-compact near context limit; project-root CLAUDE.md is re-read and re-injected after compaction, nested ones aren't. Compaction itself is an LLM call on the *current* account (cheap there: mostly cache reads).
- What a session sends every turn: "The conversation so far… Project context — your CLAUDE.md and any files Claude has read. Your new prompt." (support docs) — i.e. context size is the tax base.

## 7. Skills

`SKILL.md` files under `~/.claude/skills/<name>/` (per config dir) or `.claude/skills/` (project). Frontmatter (`name`, `description`) + body instructions; invoked as `/name` or auto-triggered. lodestone ships a project-installable `/handoff` skill so users can trigger a distilled handoff *from inside* an interactive session (the skill instructs Claude to write the handoff file itself using conversation knowledge — zero extra API calls beyond the turn).

## Sources

- https://code.claude.com/docs/en/hooks (full event/JSON schemas)
- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/memory
- https://code.claude.com/docs/en/statusline
- https://code.claude.com/docs/en/costs
- https://code.claude.com/docs/en/authentication
- Local observation of real transcripts (`~/.claude`, Claude Code v2.1.170 to v2.1.206). Everything above was confirmed against live session files before it was relied on.
- Community: fortunto2 keychain-switcher gist; melkon.tech; daring-designs; joshcgrossman (Windows caveats); KMJ-007 gist
