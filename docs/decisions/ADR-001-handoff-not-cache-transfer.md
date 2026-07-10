# ADR-001: Solve the cross-account cache tax with context handoff, not cache preservation

**Status:** accepted · 2026-07-10

## Context
The originating goal was "even if I'm switching accounts, the context should stay and not get rebuilt." Research (docs/research/01) established: Anthropic's prompt cache is server-side, keyed to org/workspace, and *"different organizations never share caches, even if they use identical prompts."* Claude Code writes to the 1-hour tier (2× write, 0.1× read). A mid-session `/login` makes the next turn replay the full conversation as fresh input + 1h cache writes on the new org — the observed 40–80% window burn.

## Decision
Accept that literal cache preservation across accounts is impossible for any client-side tool, permanently, by design. Reframe the product: **minimize what must cross the boundary.** Replace conversation replay (C tokens, ~2C weighted) with a structured handoff (≈2k tokens) injected into a fresh session on the target account.

## Consequences
- Honest positioning: the README must say "cannot preserve the cache" prominently — this differentiates us from magical-thinking tools and builds trust.
- Semantic continuity replaces token-identical continuity: Claude on account B knows *about* the work rather than re-reading every byte. The handoff format and injection framing carry the quality burden; the audit command carries the proof burden.
- Bonus market: the same mechanism rescues single-account users resuming cold (>1h) or bloated sessions.

## Alternatives rejected
- **API-key proxy / router** (route both accounts through one org): changes billing model entirely (subscriptions → pay-per-token), against the point of using two subscriptions.
- **Sharing one account's cache via shared credentials**: violates ToS boundaries and isn't what the user wants (two limit pools).
- **Full transcript replay into the new account** (`--resume` semantics faked): costs exactly the tax we're avoiding.
