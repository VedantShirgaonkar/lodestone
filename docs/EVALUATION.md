# Evaluation: Does warmswap actually kill the switch tax?

Methodology for validating the core claim — that a handoff switch costs an order of magnitude less than a naive account switch — plus the live protocol and a results section to be filled during Phase 7 validation.

## What we measure

All measurements come from transcript JSONL `usage` fields (ground truth for what the API processed) and, where available, real `rate_limits` percentages before/after. Weighted tokens = `input×1 + cache_creation×2 + cache_read×0.1 + output×5` (research/02).

**Primary metric — first-turn transfer cost on the target account:**
- Naive arm: continue the same conversation on account B (historically via `/login`, or by replaying context). First-turn `cache_creation_input_tokens + input_tokens` ≈ 2×C weighted.
- Handoff arm: fresh session on B with injected handoff. First-turn cost ≈ 2×(S+H) where S = fixed preamble, H = handoff size.

**Secondary metrics:** (a) compounding — mean per-turn weighted cost over the next 10 turns on B (the naive arm drags C into every turn); (b) real quota delta — `five_hour.used_percentage` before/after each arm when rate_limits available; (c) handoff quality score and a subjective "did Claude continue correctly without re-explaining?" (1–5, user-judged); (d) keepalive validation — a ping turn must show `cache_read ≈ C`, `cache_creation` ≈ small, all writes in `ephemeral_1h`.

## Expected numbers (from research, to be confirmed)

At C = 150k context, S ≈ 20k, H ≈ 1.5–2.5k:

| Arm | First turn on B (weighted) | Predicted |
|---|---|---|
| Naive continue/replay | ≈ 300k | 40–80% of a Pro 5h window |
| Handoff switch | ≈ 43–45k | ~85–90% cheaper |
| Handoff + small C growth over 10 turns | — | compounding savings > first-turn savings |

## Live protocol (Phase 7, requires the user's two accounts, est. spend: one controlled session ≈ 3–6% of one 5h window per arm)

1. Setup: `warmswap profile add work && warmswap login work && warmswap init && warmswap config set realUsage on`. `warmswap doctor` green on both profiles.
2. Build a controlled working session on `personal` in a test repo: scripted prompts that read ~6 files and make ~3 edits until context ≈ 40–60k (visible in statusline). Record session id, final context tokens, `five_hour.used_percentage`.
3. **Handoff arm:** `/handoff` in-session (Tier 1), quit, `warmswap switch work`, ask one continuation question, then 5 scripted follow-ups. Record from work-profile JSONL: first-turn usage, per-turn usage; quality judgment.
4. **Naive-arm measurement without burning a real replay** (default): compute from the recorded C via the formula, cross-checked against the user's HISTORICAL naive switches — `warmswap audit` heuristic detector over June–July transcripts in `~/.claude` finds real past `/login`-era boundary events with actual first-turn cache_creation numbers. (Optional strict arm, only with explicit consent: actually replay the session on B once and measure.)
5. **Keepalive check:** `warmswap keepalive personal --for 5m` with `WARMSWAP_KEEPALIVE_IMMEDIATE=1` → inspect the ping's JSONL usage per secondary metric (d).
6. Fill Results below; screenshots of dash + statusline for the README/launch post.

## Threats to validity

- Weighted-token model approximates an unpublished accounting formula → we report raw token buckets alongside weighted figures, and real `used_percentage` deltas where available.
- S varies by machine (CLAUDE.md/memory size); reported per-run.
- n=1 user, 1 machine for the live run → claims phrased as "measured on real sessions", not universal constants; audit lets every user reproduce on their own history.
- The undocumented usage endpoint may change → quota deltas are a secondary, not primary, metric.

## Results (Phase 7 — to be filled)

_Pending live validation._
