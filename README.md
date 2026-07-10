# cchandoff

> Switch Claude Code accounts without torching your usage limits.

**Status: pre-release, under active development.** Full README lands with v0.1.0 (see `docs/PLAN.md` Phase 5).

## The problem

Claude Code keeps your session affordable through Anthropic's server-side prompt cache (1-hour tier: reads cost 0.1×, writes 2×). That cache is **sealed inside your account's organization** — official docs: *"Different organizations never share caches, even if they use identical prompts."* Switch accounts mid-session and your next turn replays the entire conversation as fresh input to an org that has never seen it: at ~150k context that single turn costs ~20 normal turns. People report losing 40–80% of a 5-hour window to one switch.

No tool can carry the cache across accounts — that isolation is Anthropic-side and deliberate. What a tool *can* do is make the thing you carry across tiny.

## What cchandoff does

- **Profiles** — one `CLAUDE_CONFIG_DIR` per account (auth fully isolated, incl. macOS Keychain), your existing `~/.claude` adopted untouched.
- **Handoffs** — deterministic session snapshots extracted from transcripts for free (goal, todos, files in play, decisions, next steps), auto-captured by hooks at session end and before compaction; optional LLM distillation on the *cheap* side of the boundary.
- **Rehydration** — a SessionStart hook injects the handoff into your fresh session on the other account: ~2k tokens instead of a ~150k replay.
- **Measurement** — `status` shows each account's estimated 5h-window burn and what switching *right now* would cost; `audit` shows what your past switches actually cost vs. the naive path.

Also useful with a **single** account: resuming a big session after the 1-hour cache lapses costs the same 2× rewrite — snapshot + fresh start is cheaper there too.

## Learn the mechanics

[docs/explainer/how-claude-code-memory-works.md](docs/explainer/how-claude-code-memory-works.md) — the four memory layers, cache TTLs and pricing, what usage limits actually count, and the switch-tax math. Research with citations in [docs/research/](docs/research/).

---
Community tool; not affiliated with or endorsed by Anthropic. MIT.
