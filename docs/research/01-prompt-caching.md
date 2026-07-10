# Research: How Anthropic Prompt Caching Actually Works

> Verified 2026-07-10 against official docs and empirical data from real Claude Code session transcripts on this machine.

## The mechanism

Anthropic's API caches the *processed prefix* of a prompt server-side. A request marks blocks with `cache_control`; the server stores a hash of the prefix ending at that block. A later request whose prefix hashes identically gets a **cache read** instead of reprocessing those tokens.

- Cache hits require **100% identical prompt segments** — all text and images up to and including the marked block.
- Prefix hierarchy is `tools → system → messages`. A change higher in the hierarchy invalidates everything below it (e.g. changing tool definitions kills the whole cache; toggling fast mode invalidates tools-level cache).
- The cache is **per-model**. Switching model mid-session = full cache miss on the next turn.
- Up to 4 cache breakpoints per request; on reads the server walks backward up to 20 blocks looking for the longest matching cached prefix.
- Minimum cacheable size is model-dependent (512 tokens for Fable/Mythos 5, 1024–4096 for others). Below that, requests process uncached with no error.

## TTLs — the "warm cache"

| Tier | TTL | Write cost | Read cost | Refresh |
|------|-----|-----------|-----------|---------|
| Ephemeral 5m (API default) | 5 minutes | 1.25× base input | 0.1× base input | free on every hit |
| Ephemeral 1h | 1 hour | **2× base input** | 0.1× base input | free on every hit |

> "The cache is refreshed for no additional cost each time the cached content is used." — prompt caching docs

**Claude Code uses the 1-hour tier.** Verified empirically on this machine (v2.1.170 and v2.1.206 transcripts): every assistant turn's `usage.cache_creation` puts 100% of write tokens in `ephemeral_1h_input_tokens`, 0 in `ephemeral_5m_input_tokens`. So an idle Claude Code session's context stays warm for 1 hour after the last turn, and each new turn refreshes the clock. This is the user-observable "warm cache that sits for an hour."

## The fact that shapes this whole project: cache scope

From the official prompt caching docs (platform.claude.com/docs/en/build-with-claude/prompt-caching), verbatim:

> "Organization and workspace isolation: Caches are isolated between organizations. **Different organizations never share caches, even if they use identical prompts.**"

> "As of February 5, 2026, prompt caching uses workspace-level isolation instead of organization-level isolation. Caches are isolated per workspace…"

A personal Pro account and a Team-plan account are **different organizations**. Therefore:

1. When you switch accounts mid-conversation (`/login`), the next turn sends the *entire conversation* to an org that has never seen any of it. Every token that was a 0.1× cache read becomes fresh input plus a 2× 1-hour cache write.
2. **No client-side software can ever make org B read org A's cache.** The cache lives on Anthropic's servers, keyed inside an org/workspace boundary that exists for privacy isolation. "Preserving the cache across accounts" is not an engineering problem — it's cryptographically/architecturally sealed off, by design.

The only lever a local tool controls is **how many tokens must be re-sent** after a switch. That is the lever cchandoff pulls: replace a 100–170k-token conversation replay with a 1–3k-token structured handoff.

## Cost arithmetic of one account switch (why it eats 40–80% of a window)

Take a healthy working session: ~150k tokens of context (system prompt + tools + CLAUDE.md + conversation + tool results).

- Staying on account A, each turn costs ~150k × 0.1× = **15k token-equivalents** of read + small write delta.
- Switching to account B, the first turn costs ~150k × (1.0 input… effectively billed as 2× 1h cache write) = **~300k token-equivalents**, i.e. **~20× one normal turn**, in one keystroke. Subsequent turns on B are cheap again — but you paid a full rebuild, and you'll pay it *again* switching back to A once A's hour lapses.
- A handoff switch instead: distilled state ≈ 2k tokens + fresh system prompt/CLAUDE.md ≈ 15–20k → first turn on B ≈ **35–45k token-equivalents once**, and the new session doesn't drag 150k of history into every subsequent turn either.

Empirical anchor from this machine (single 489-turn session, `-Users-rahul-Desktop-Algotrace`): `input_tokens` 87,620; `cache_creation` 5,262,790 (all 1h-tier); `cache_read` 177,241,656; `output` 1,029,715. Cache reads outnumber uncached input by ~2000:1 — the cache is what makes long sessions affordable at all, and a switch forfeits it entirely.

## Sources

- https://platform.claude.com/docs/en/build-with-claude/prompt-caching (TTLs, pricing multipliers, isolation, breakpoints, minimums, invalidation table)
- Local transcripts: `~/.claude/projects/*/**.jsonl` `usage.cache_creation.ephemeral_1h_input_tokens` (Claude Code 2.1.170–2.1.206)
- https://code.claude.com/docs/en/costs ("Claude Code automatically optimizes costs through prompt caching…")
