# Direction Review — 2026-07-12

Triggered by user feedback after Phases 1–3. Answers four questions, audits the build, and sets the roadmap that PLAN.md v2 encodes.

## Q1 — "Are we 1000% sure the cache can't cross accounts?"

**Yes. Verdict re-verified and final** (evidence stack in research/01 "Final verdict" section): org isolation is stated verbatim in Anthropic's API docs, tightened to workspace-level in Feb 2026, enforced server-side where no client parameter can reach, and empirically consistent with everything observed on this machine. The one legitimate manipulation is TTL refresh *within* an account — adopted as the switch-back keepalive (ADR-009). Building the local layer proceeds on solid ground; the README will state the impossibility up front (trust through honesty, ADR-001).

## Q2 — "Deterministic extraction won't be effective, right? Use Claude itself + warn before limits."

Half-agreed, and the design now reflects it (ADR-008): deterministic extraction is demoted to the always-on free floor; the **recommended** path is Claude-written handoffs — the `/handoff` skill in-session (zero extra cost) or `--distill` against the still-warm cache (0.1×). The user's second idea is the piece that makes it real: the **advisor** (ADR-007) watches REAL quota data and nudges "handoff now, cache is warm" at ~85% of the 5h window / ~90% weekly — before the wall, when the good paths are still cheap. Snapshot output gains a completeness score so thin handoffs are visible.

## Q3 — Open-source shape + monitoring UI

Product = npm CLI (`lodestone`) as the single source of truth; surfaces: statusline v2 (real `rate_limits`, pacing marker, cache countdown, advisor glyph) + `lodestone dash` live TUI (the reference popover, terminal-native, both profiles) now; slim VS Code extension (statusbar + Quota popover + action buttons) after launch (ADR-010). Real data policy per ADR-007 — native statusline feed needs no credentials; the cross-profile view is the opt-in OAuth-endpoint layer. The UI answers, at a glance: both accounts' 5h/weekly bars with resets and pacing · minutes left on each live session's 1h cache · what a full/partial rebuild costs *for your plan right now* · when to hand off.

## Q4 — Conference paper or LinkedIn post?

**Objectively: not a research paper.** No novel algorithm or generalizable method; the contribution is systems engineering plus a measurement study with n≈1. A tools/demo-track submission (ICSE/FSE demo) would need a real multi-user evaluation — months, low return. **What it IS:** a strong technical launch — the explainer (cache physics + measured 90%+ switch-tax reduction with real numbers) is genuinely publishable as a blog post / Show HN / LinkedIn piece, and the measured-savings screenshots are the hook. Optional later: an arXiv-style write-up of the measurement methodology if the community asks. Recommendation: ship OSS + write the post; skip the paper.

## Build audit (Phases 1–3, committed through b7f1a91)

Working, validated on real data: transcript parser (real schema, compact-summary harvest), profiles/launch/login, snapshot/handoff/switch/status/doctor, hooks (inject + auto-snapshot), init installer, statusline v1, /handoff skill; 92 tests green; dogfooded on this repo's own 296k-token session (649-token handoff, ~92% cheaper switch).

Known debt (tracked into PLAN v2): render-composition duplicated between snapshot.ts and hook.ts (factor into core); statusline currently estimates burn from JSONL (upgrade to native rate_limits); extraction thin on atypical sessions (mitigated by ADR-008, plus harvest `last-prompt` lines); hook self-test writes to /tmp without cleanup; delegation reports must keep being audited against raw output (see memory: delegation lessons).

## Risks

1. `/api/oauth/usage` is undocumented → contained by ADR-007 layering (never a hard dependency).
2. Keepalive economics depend on the subscription 1h tier persisting → isolated module, must be live-validated before README claims (ADR-009).
3. Anthropic could ship native multi-account or handoff (issue #11455 open) → our moat is the integrated workflow + measurement; if upstreamed, the tool remains useful for the UI/advisor and the explainer remains valuable. Ship fast.
4. Two-account usage etiquette: both subscriptions are paid; README FAQ will note Team-plan/org-policy considerations are the user's to check.
