# Research: The Economics of Context Carry — trail vs handoff vs /compact vs continue

> 2026-07-12. Triggered by the user's friend's "running session log" pattern (VESTIGE RULES.md §5: a continuously maintained per-session context file, updated after every significant decision/work block; a new session reads the latest log and resumes). This doc answers: is that pattern efficient, how does it relate to what we built, and what is the optimal integration? All weights per research/02 (`read 0.1× · uncached 1× · 1h write 2× · output ~5×`).

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

**Capture ladder (revised):**
- T0 **trail mode** (NEW, opt-in): continuous bounded trail + staleness nudges. Insurance against B3.
- T1 `/handoff` on demand (exists) — cheapest good capture when the boundary is chosen.
- T2 `--distill` (exists) — post-hoc within TTL.
- T3 deterministic auto-snapshot (exists) — floor; **now ALSO fired automatically at the 95% advisor threshold** (NEW), so even without trail mode a surprise wall never finds us empty-handed.

**Carry moves (one mechanism, three fronts):** `switch <profile>` (B1, exists) · **`refresh`** (B2/B4: write handoff → `/clear` → hook injects; NEW skill + advisor copy; the machinery — clear-matcher injection — already exists) · post-reset resume (B3: just start a session; startup injection already works — NEW advisor copy at ≥95%: "snapshot saved; after reset, start fresh here and it loads automatically").

**Advisor escalation (NEW):** 85% → nudge trail/handoff (cache warm, cheap). 95% → fire deterministic snapshot inline + wall-imminent message with the post-reset instruction. Cache-expiry countdown stays on statusline/dash; the VS Code extension (timer-driven, unlike hooks) additionally gets a T-minus toast option before a warm cache dies (NEW) — the only surface that can warn during idle.

**Keepalive guardrail** aligned to the user's spec: pings only while the source profile's 5h window is below a configurable ceiling (default raised check: skip at ≥80% used, i.e. run only when meaningful headroom remains; configurable `keepalive.maxWindowPct`).

**Audit classes (NEW):** every consumption event classified `switch` (consumer profile ≠ source) or `refresh` (same profile — stop rejecting these when they come from explicit consumedBy records; keep rejecting same-profile *heuristic* pairs) plus `post-reset` (same profile, consumed after a window boundary). Savings reported per class — giving the user their "how much did we save across same session, new session, resets, switches" view in status/dash/extension.

## 5. What we explicitly do NOT do (scope honesty, per the user's directive)

No prompt rewriting, no context pruning inside live sessions, no model/effort meddling, no request interception — Claude Code's in-session quality stays untouched. We only decide *when a fresh context is cheaper than a carried one* and make the carry as small and as automatic as possible. Where native tools win (warm-cache /compact, /rewind), the advisor recommends the native tool.
