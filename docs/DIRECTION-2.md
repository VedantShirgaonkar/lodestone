# Direction Review #2 — 2026-07-12 (boundary generalization)

Triggered by the user's second direction message (friend's running-log pattern; generalization mandate; UX reiteration; naming/publish gates). Companion analysis: research/07 (economics), ADR-012 (decisions), PLAN v3 (execution).

## The bird's-eye verdict

What we built is one instance (account switching) of the general product we should ship: **a boundary-cost eliminator for Claude Code**. Every expensive moment — switching accounts, resuming after the 1h cache dies, coming back after a 5h/weekly wall, shedding a bloated context — is the same event: context must cross a boundary the server cache can't cross. One capture→carry→inject machine, four boundaries, honest measurement. The two-account story remains the flagship demo because it's the most dramatic (96% measured), but the addressable audience becomes *every* Claude Code user on a subscription.

## Answers the user asked for

1. **"Same session or new session?"** New, always (or post-`/clear`, economically identical). The bloated session is never continued across a boundary; savings come from both the smaller one-time rebuild (2×(S+H) vs 2×C) *and* the smaller every-turn carry thereafter — the second part compounds and usually dominates. The injection hook already fires on both `startup` and `clear`.
2. **"Is my friend's thing the same as ours?"** Same carry mechanism, different **capture timing**. Ours captures on demand (skill/distill/exit-snapshot); his captures continuously. Continuous capture costs real tokens (~10–40k weighted/session, honestly counted) but is the ONLY capture that survives a wall that lands mid-work — the one hole in our ladder. Verdict: adopt as opt-in **trail mode** (bounded single file, staleness nudges — two upgrades over his unbounded append-log), keep the cheaper on-demand ladder as default, and fix the wall-hole for non-trail users too via the 95% auto-snapshot escalation.
3. **"Is it actually efficient?"** Conditionally — the full arithmetic is research/07 §2–3. Summary: vs continuing after expiry/reset it's strictly cheaper (and quality is the only tradeoff); vs native `/compact` on a *warm* cache it is NOT cheaper, and the advisor will honestly recommend `/compact` there. Cold cache, walls, and cross-account are where our path wins structurally.

## Feature keep/cut audit (everything currently built)

KEEP unchanged: profiles/launch/login · snapshot/handoff/distill ladder · switch · injection hooks · statusline v2 (ctx/cache/5h/wk/advisor) · dash · keepalive (gains config ceiling) · audit (gains classes) · doctor · config · measure-switch · docs corpus · VS Code extension (gains menu items + toast).
ADD (Phase 9): trail mode · refresh flow · advisor 95% escalation with inline snapshot · audit classes · keepalive ceiling · extension refresh/trail/toast.
CUT: nothing. (Reviewed each for redundancy against the generalized frame — every existing feature maps onto a boundary.)

## Publishability & usability posture

- **Naming:** publish-blocking user gate (their explicit directive, twice). Nothing ships to npm/marketplace/GitHub until the user confirms the final name in writing. Current `lodestone` is provisional.
- **Marketplace footfall:** treated as a real workstream (Phase 10): SEO research → listing engineering (name/description keyword placement, category, icon, README-top-as-search-snippet, badges, qna, verified links). Same care for npm keywords.
- **Repo flow:** user creates the GitHub repo post-naming, provides URL; we add remote and push every commit thereafter.
- **Usability:** every feature reachable three ways — CLI command, in-session (skill/advisor/statusline), and extension click — enforced by extending docs/FEATURES.md as the acceptance matrix for Phase 9.

## Risks added by this direction

1. Trail-mode adherence variance (model may under-update) → bounded by staleness nudges + the 95% snapshot net; measured in validation (trail freshness at session end).
2. Advisor now has more voice → strict once-per-bucket debounce stays; all copy ≤2 lines.
3. Scope temptation → the "not token-optimization, never touch in-session quality" rule (ADR-012 §5 restated) is the line; anything inside a live conversation other than terse advisory text is out of scope, permanently.
