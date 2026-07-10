# How Claude Code Memory & Caching Actually Work

*(and why switching accounts mid-session torches your usage limits)*

Everything below is verified against Anthropic's official docs and real session transcripts. Citations in `docs/research/`.

## The four layers

Claude Code "memory" is four unrelated systems that people constantly conflate:

| Layer | Lives | Lifetime | Costs tokens? |
|---|---|---|---|
| 1. Context window | In the request, rebuilt every turn | One turn | Yes — every turn |
| 2. Prompt cache | **Anthropic's servers**, inside your org | 1 hour (refreshed per use) | Discounts layer 1 |
| 3. Session transcripts | Your disk (`~/.claude/projects/**.jsonl`) | Forever | Free until resumed |
| 4. Memory files (CLAUDE.md, auto memory) | Your disk | Forever | Loaded each session start |

### Layer 1: The context window — there is no memory

The model remembers nothing between turns. Every single turn, Claude Code sends: system prompt + tool definitions + CLAUDE.md + auto-memory index + **the entire conversation so far** (including every file read and command output) + your new prompt. A 150k-token session sends ~150k tokens *per turn*. This is why context size is the tax base for everything.

### Layer 2: The prompt cache — the only reason layer 1 is affordable

Anthropic caches the processed prefix of your prompt server-side. If this turn's prompt starts with exactly the same bytes as a previous one, the matching prefix is a **cache read at 0.1× the price** of fresh input. Only the new suffix (your last exchange) is processed fresh.

- **Claude Code uses the 1-hour cache tier** (verified: every write lands in `usage.cache_creation.ephemeral_1h_input_tokens`). Writes cost 2× base input; each use refreshes the 1-hour clock for free. Walk away for lunch and come back within the hour: still warm. Overnight: cold, and the next turn re-writes your whole context at 2×.
- The cache is keyed on the *exact* prefix, per **model**. Switching models mid-session = full miss. Editing anything early in the conversation = miss from that point on.
- A long session's economics (real transcript, 489 turns): 177M cache-read tokens vs 0.088M uncached input. **The cache absorbed ~99.95% of would-be input.**

**The rule that matters for two accounts** (official docs, verbatim): *"Different organizations never share caches, even if they use identical prompts."* Your personal Pro account and your work Team account are different organizations. When you `/login` to the other account mid-conversation, the next turn replays the entire conversation to an org that has never seen a byte of it: everything that was 0.1× becomes fresh input written to cache at 2×. At 150k context that's one turn costing ~20 normal turns — the observed 40–80% window burn. **No local tool can bridge this; the isolation is Anthropic-side and deliberate.** The only fix that can exist: carry *less* across the boundary.

### Layer 3: Session transcripts — perfect recall, expensive replay

Every session is appended line-by-line to `<config-dir>/projects/<munged-cwd>/<session-id>.jsonl`: every message, every tool call, per-turn token usage, compaction boundaries. `--resume`/`--continue` rebuild the context window from this file. Resuming is free *locally*, but the first resumed turn re-sends the whole conversation — cheap only if the org's cache is still warm (same account, <1h). Resuming a big yesterday-session is nearly as expensive as the account-switch tax, on your own account.

### Layer 4: Memory files — the only cheap persistence

- **CLAUDE.md** (managed → `~/.claude/CLAUDE.md` → `./CLAUDE.md` → `./CLAUDE.local.md`): loaded in full every session start. Keep under ~200 lines; supports `@file` imports and `.claude/rules/` with path-scoped loading.
- **Auto memory** (`~/.claude/projects/<project>/memory/`): Claude's own notes; first 200 lines / 25KB of `MEMORY.md` load each session, topic files on demand.
- These are *re-sent every session* as part of the preamble — cheap because they're small and immediately cached.

## Usage limits: what you're actually spending

Subscription plans meter a 5-hour rolling window (starts at your first message) plus weekly caps, shared across claude.ai/Desktop/Code. Anthropic doesn't publish the formula, but it tracks compute cost, and compute cost per bucket is public:

```
cache read      0.1×      ← where you want your tokens
uncached input  1×
cache write 1h  2×        ← what Claude Code writes
output/thinking ~5×
```

So the levers, in order of impact:
1. **Keep context small** — it multiplies into every turn. `/clear` between tasks; `/compact` at milestones, not at 95%.
2. **Never break the cache** — don't switch accounts or models mid-session; don't let a huge session go cold and then resume it.
3. **Cross boundaries with summaries, not transcripts** — a 2k-token handoff instead of a 150k replay is a ~99% cut in transfer cost.
4. Model/effort choice, thinking budget, MCP overhead — all secondary to the above.

## The switch tax, precisely

Context C on account A; fixed session preamble S (~15–25k); handoff H (~2k):

| Path | First-turn cost on B | At C=150k |
|---|---|---|
| Naive: `/login` and continue | ≈ C × 2 (cache write) | ~300k weighted tokens |
| Resume same session on B later | ≈ C × 2 | ~300k |
| **Fresh session on B + handoff** | ≈ (S+H) × 2 | ~35–45k |

Plus the compounding effect: the naive path drags C into every later turn on B; the handoff path starts a lean session. That's the entire thesis of cchandoff — and the same mechanism rescues single-account users resuming cold sessions.
