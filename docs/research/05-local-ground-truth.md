# Research: Local Ground Truth (this machine, 2026-07-10)

Facts observed directly on the primary development machine — the empirical anchors for parser design and the switch-tax math.

## Environment

- macOS (darwin 24.0.0), zsh; Claude Code **2.1.206**; Node v22.14.0; npm 10.9.2; jq 1.6; gh 2.88.1; no bun.
- Single default config root `~/.claude` (+`~/.claude.json`, `~/.claude.json.backup`). `CLAUDE_CONFIG_DIR` not set → both accounts have historically shared one config dir via `/login` switching. **This is the worst-case setup for the cache tax** (same conversation continued across orgs).
- Logged-in org at inspection time: personal ("vedxntshirgaonkar@gmail.com's Organization", role admin).
- Credentials: macOS Keychain generic password, service `Claude Code-credentials`, account `rahul`. No `.credentials.json` on disk.

## `~/.claude` layout (v2.1.206)

`projects/` (transcripts per munged cwd), `history.jsonl` (48KB), `file-history/`, `shell-snapshots/`, `session-env/`, `sessions/`, `plans/`, `plugins/`, `skills/` (has graphify), `settings.json` (model/effort/tui/voice only — no hooks yet), `stats-cache.json`, `todos` absent here (per-project task state under `tasks/`), `daemon*` (background job runner), `jobs/`.

`~/.claude.json` top-level keys observed: `oauthAccount`, `projects`, `numStartups`, caches (`cachedStatsigGates`, `modelAccessCache`, `overageCreditGrantCache`, …), onboarding/migration flags. Per-project map lives here too.

## Transcript anatomy (real session, project `-Users-rahul-Desktop-Algotrace`)

- File: `c1c8b223-….jsonl`, 4.8MB, 1059 lines.
- Line types: assistant 489 / user 315 / file-history-snapshot 108 / attachment 44 / mode 32 / permission-mode 31 / last-prompt 29 / system 7 / queue-operation 4.
- Assistant `usage` block includes `cache_creation: {ephemeral_1h_input_tokens, ephemeral_5m_input_tokens}` — **all cache writes 1h-tier** (5,262,790 vs 0), on v2.1.170 and v2.1.206 both.
- Session totals: input 87,620 / cache_creation 5,262,790 / cache_read 177,241,656 / output 1,029,715. Reads:input ≈ 2000:1.
- First turns of a fresh session still show `cache_read` ~12–16k — the fixed preamble (system prompt/tools) is already cached org-side from sibling sessions within the TTL. Cache is org+model+prefix scoped, not session-scoped.
- Compaction markers found in `-Users-rahul-Desktop-rlm` session: 4× `type:"system", subtype:"compact_boundary"` + 4× `user` with `isCompactSummary: true`.
- Streaming duplicates: consecutive assistant lines share `message.id` with identical usage → dedupe before summing.
- `history.jsonl` line keys: `display`, `pastedContents`, `project`, `sessionId`, `timestamp`.

## Numbers to design against

- Fixed session preamble on this machine ≈ 15–25k tokens (system prompt + tools + user CLAUDE.md + memory index).
- Working sessions here grow to 100–200k context routinely (4.8MB transcript ≈ 150k+ live context before compaction).
- Predicted naive switch cost at 150k context: ~300k write-tokens ≈ 40–80% of a Pro 5h window depending on model — matching the user's observed burn. Handoff target: <15% of that.
