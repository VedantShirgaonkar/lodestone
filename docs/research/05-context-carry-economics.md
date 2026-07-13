# Research: The Economics of Context Carry — trail vs handoff vs /compact vs continue

> 2026-07-12. A common community pattern is the "running session log": a context file the model keeps current as it works, updated after every significant decision or block of work, so a new session can read the latest entry and resume. This doc asks whether that pattern is actually efficient, how it compares to a handoff and to native `/compact`, and where each one wins. All weights per research/02 (`read 0.1× · uncached 1× · 1h write 2× · output ~5×`).

## 0. The unifying frame: boundaries

Every cost event this project touches is a **context-carry boundary** — a moment where the conversation's server-side cache stops helping and context must move (or be shed):

| Boundary | Cache state after | Native options | Our options |
|---|---|---|---|
| B1 Account switch | other org: no cache, ever | none | handoff → fresh session (built) |
| B2 Cache expiry (>1h idle, same account) | cold; continue = 2×C rewrite | continue and eat it; /compact (see §3) | refresh: fresh session + handoff |
| B3 5h/weekly wall | can't send at all; after reset, cache long cold → resume = 2×C | wait, resume, eat 2×C | capture BEFORE wall → post-reset fresh session + handoff |
| B4 Voluntary shed (bloat) | warm but huge | **/compact (native, good)** | refresh when compact unavailable/undesired |
| B5 Machine/device change | different machine ⇒ different prefix anyway | none | handoff via committed `.claude/handoff/` |

The tool's honest scope: **make every boundary cost ≈ 2×(S+H) instead of ≈ 2×C** (S = fixed session preamble ~15–25k, H = carried state ~1–2.5k, C = live context, commonly 100–450k). Same-account boundaries (B2–B4) are what generalize the tool to *every* Claude Code user — the friend's point, and correct.

## 1. Same session vs new session — the question answered precisely

Our system **never continues the bloated session across a boundary**. Every carry lands in a *fresh* context (new session, or the post-`/clear` context — identical economics), where the SessionStart/clear hook injects the handoff. This is exactly the friend's flow. The reason is arithmetic, not taste:

Continue old session (context C=150k) after expiry/reset vs fresh+handoff (S=20k, H=2k):
- One-time: 2×150k = **300k** vs 2×22k = **44k** weighted.
- **Ongoing carry — the part everyone underweights:** every later turn re-reads the whole context at 0.1×. 30 more turns: 30×15k = **450k** vs 30×2.2k+growth ≈ **80k**. The rebuilt giant keeps taxing you forever; the fresh session doesn't.
- Quality cost: the fresh session only knows what H says + what it re-reads from disk. This is the real price, and why capture quality (below) is the battleground.

## 2. The friend's running trail — objective verdict

**Mechanism:** instructions (rules-file level) make Claude keep `sessions/<date>.md`-style running notes DURING the session; on any boundary, the next session reads the file.

**Costs, honestly counted:** each update is a Write/Edit tool call: ~100–400 output tokens (5×) plus the tool blocks joining the context (~150–500 tokens re-read thereafter at 0.1×). At 10–20 updates/session: ≈ **10–40k weighted per session** — one to four ordinary turns. Not free. Also a reliability cost: instruction-following decays in long sessions (prior art: Sonovore's session-state tool has exactly this "Claude forgets" failure mode).

**What it buys that NOTHING we built buys:** capture that exists *before the boundary is known*. Our current ladder has a hole exactly there:
- `/handoff` (Tier 1) needs a live, un-throttled session — **unavailable once the wall hits mid-work**.
- `--distill` (Tier 2) resumes the session — **also unavailable when throttled**, and expensive after expiry.
- Deterministic snapshot (Tier 3) always works but is mechanically dumb.
So on a surprise B3 (the most painful boundary — the user's own 40–80% story started there), today we fall to the weakest tier. The trail turns the surprise wall into a non-event: the good capture already exists.

**Verdict:** adopt, as an **opt-in capture mode** ("trail mode", the wall-insurance tier), not as a replacement: continuous cost is only worth paying for users who actually hit walls; others keep the cheaper on-demand ladder. Two engineering upgrades over the friend's raw pattern:
1. **Bounded format:** one file (`.claude/handoff/trail.md`), fixed sections overwritten in place (goal/state/decisions/files/next), hard cap ~1.5k tokens — never an append-forever diary (his `sessions/` logs grow unboundedly; fine for a research repo, wrong for a cost tool).
2. **Staleness nudge:** hooks can't force the model to write, but our UserPromptSubmit advisor can *measure* staleness (mtime vs turns elapsed) and inject one terse reminder — converting "hope Claude remembers" into a bounded-loss loop.

## 3. Honest comparison with native `/compact` (we do not compete where native wins)

Official docs: compaction's summarization request *shares the session prefix and reads the existing cache* — so with a WARM cache, /compact captures at ~0.1×C + output, then rebuilds only (S+summary). For B4 with a warm cache and no wall, **/compact is the right tool and the advisor should say so.**

Where /compact structurally loses and we win:
- **Cold cache (B2):** compact's capture request must re-read the whole history UNCACHED first (≈1×C+) before summarizing — the very cost we're avoiding. Trail/handoff already exist → refresh pays 2×(S+H) with no big re-read.
- **Wall (B3):** compact cannot run at all on a throttled account. The trail is the only high-quality artifact that can exist.
- **Cross-account (B1) / cross-machine (B5):** compact's summary lives inside the session; it doesn't travel. Handoff files do. (We already harvest past compact summaries into handoffs — paid-for prose, reused free.)

## 4. The integrated design (what changes in the product)

**The capture ladder.** Four ways to get context out of a session, in descending order of quality and ascending order of certainty that something exists at all:
- **T0 trail mode** (opt-in): a bounded trail the model keeps current as it works, plus staleness nudges. Insurance against B3, the boundary you do not choose.
- **T1 `/handoff` on demand**: the cheapest good capture when *you* choose the boundary, because the model still remembers everything and the cache is warm.
- **T2 `--distill`**: post-hoc, still inside the TTL, at cache-read prices.
- **T3 deterministic auto-snapshot**: the floor. Free, hook-driven, no model call. Also fired automatically at the 95% advisor threshold, so even with trail mode off, a surprise wall never finds you empty-handed.

**Carry moves: one mechanism, three fronts.** `switch <profile>` crosses B1. `refresh` handles B2 and B4 (write a handoff, `/clear`, the start hook injects it back). Post-reset resume handles B3, and needs nothing new: you just start a session and the waiting handoff loads itself.

**Advisor escalation.** At 85% the cache is still warm and a handoff is still cheap, so it nudges. At 95% it stops asking and banks a deterministic snapshot inline, then tells you what to do after the reset. The cache-expiry countdown lives on the statusline and dash; the editor extension, being timer-driven rather than hook-driven, is the only surface that can also warn you while you are idle, which is exactly when a warm cache dies unnoticed.

**Keepalive guardrail.** Pings run only while the source profile's 5h window is below a ceiling (skip at ≥80% used, configurable via `keepalive.maxWindowPct`), so keeping a cache warm can never be the thing that spends the window you were saving.

**Audit classes.** Every consumption event is classified `switch` (consumer profile differs from source), `refresh` (same profile, session shed deliberately), or `post-reset` (same profile, consumed after a window boundary). Savings are reported per class, which is what turns "it feels cheaper" into a number per kind of crossing.

## 5. What we explicitly do NOT do (scope honesty, per the user's directive)

No prompt rewriting, no context pruning inside live sessions, no model/effort meddling, no request interception — Claude Code's in-session quality stays untouched. We only decide *when a fresh context is cheaper than a carried one* and make the carry as small and as automatic as possible. Where native tools win (warm-cache /compact, /rewind), the advisor recommends the native tool.
