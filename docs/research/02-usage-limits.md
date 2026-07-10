# Research: Subscription Usage Limits (5-hour windows, weekly caps) and What Counts

> Verified 2026-07-10. Anthropic does not publish an exact accounting formula for subscription limits; this doc separates documented facts from well-supported inference.

## Documented facts

- **Two limit layers** on Pro/Max (and per-seat on Team): a session limit on a **5-hour window** that starts with your first message, and **weekly caps** (added August 2025): one for all models plus a separate cap for the top-tier models. Hit either → throttled until reset.
- Usage is shared across surfaces: "usage of all different Claude product surfaces (claude.ai, Claude Code, Claude Desktop) counts towards the same usage limit" (support.claude.com).
- Usage scales with "the length and complexity of your conversations, the features you use, which Claude model you're chatting with, and the effort level you've selected" (support.claude.com/11647753). Claude counts **tokens, not messages**.
- `/usage` in Claude Code shows plan usage bars (5h + weekly) for subscribers, plus a local-history breakdown by skill/subagent/MCP server (d/w toggles). Figures are computed locally per machine.
- Model choice matters: Opus-class burns the allowance several times faster than Sonnet-class per token (pricing-page ratios).

## What counts, directionally (inference, high confidence)

Subscription metering tracks *compute cost*, and compute cost per token bucket is public API pricing:

| Bucket | Cost weight (vs base input) |
|--------|------------------------------|
| Cache read | 0.1× |
| Uncached input | 1× |
| Cache write (5m) | 1.25× |
| Cache write (1h — what Claude Code uses) | 2× |
| Output (incl. thinking tokens) | ~5× (model-dependent) |

Supporting evidence:
1. API rate limits are officially "cache-aware": cache reads don't count toward ITPM on most models (platform docs / rate-limits). Anthropic consistently exempts or discounts cache reads because they're cheap to serve.
2. The user's own experience: a mid-session account switch (which converts one turn's worth of cache reads into uncached input + 1h cache writes) visibly consumed **40–80% of a 5-hour window** in one or a few turns. Nothing else about the turn changed — only the cache buckets. Limits therefore must weight cache writes/uncached input drastically heavier than reads.
3. Community measurement tools (ccusage, Claude-Code-Usage-Monitor) successfully model window burn using exactly these pricing weights applied to JSONL usage fields.

**Practical rule for cchandoff:** estimate window burn as
`burn ≈ Σ (input×1 + cache_creation×2 + cache_read×0.1 + output×5) × model_price_ratio`
labelled clearly as an *estimate* — good for relative decisions ("switching now costs ~X% of your window"), never presented as official billing.

## The switch-tax formula

For a session with context size C (tokens) on the account you're leaving:

- **Naive switch (continue same conversation on account B):** first turn ≈ `C × 2` (1h cache write) + normal turn costs; plus you keep paying B's rebuilt context every turn.
- **Handoff switch (fresh session on B with distilled state H):** first turn ≈ `(S + H) × 2` where S is Claude Code's fixed session preamble (system prompt + tools + CLAUDE.md + memory, typically 15–25k). With H ≈ 2k, that's ~10–20× cheaper *and* the smaller context compounds savings on every later turn.
- The same math explains why resuming a stale (>1h idle) giant session **on the same account** is expensive: full re-write at 2×. cchandoff's snapshot/rehydrate therefore also helps single-account users — bigger OSS audience.

## Team plan notes

Team (premium seat) users get Claude Code with per-seat limits on the same 5h + weekly structure; admins can buy extra usage. Seat usage is individual — the intern's Team seat and personal Pro account are two orgs with two separate limit pools *and two separate caches* (see 01-prompt-caching.md). Using both accounts deliberately to double available capacity is exactly the workflow cchandoff supports — the handoff makes the boundary cheap to cross. (Whether juggling two subscriptions is desirable is a user/org policy question, not a technical one; both subscriptions are paid for.)

## Sources

- https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work
- https://support.claude.com/en/articles/9797557-usage-limit-best-practices
- https://code.claude.com/docs/en/costs (/usage command, plan bars, background token usage)
- https://www.morphllm.com/claude-code-usage-limits, https://www.truefoundry.com/blog/claude-code-limits-explained (community syntheses; cache-read exemption from ITPM)
- User's observed 40–80% window burn per mid-session `/login` switch (motivating incident)
