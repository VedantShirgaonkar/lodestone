# Evaluation: is the saving real?

Lodestone claims that crossing a boundary with a handoff costs an order of magnitude less than crossing it naively. This document says exactly what that claim means, how it is computed, how you reproduce it on your own data, and what it does not prove. If you only read one section, read "What this does not prove".

## The unit: weighted tokens

Not all tokens cost the same, so counting raw tokens tells you nothing useful about what a boundary cost. Anthropic's published cache pricing gives the weights:

```
weighted = input×1  +  cache_creation×2  +  cache_read×0.1  +  output×5
```

Every number lodestone reports is in this unit. It comes from the `usage` object on each assistant message in the transcript JSONL, which is ground truth for what the API actually processed, not an estimate of what we think it processed. See [research/01-prompt-caching.md](research/01-prompt-caching.md) for where the weights come from and [research/02-usage-limits.md](research/02-usage-limits.md) for how they map onto your usage window.

## What a boundary costs

Let `C` be the conversation's current context size, `S` the fixed session preamble (system prompt, CLAUDE.md, tool definitions), and `H` the handoff size.

**Naive crossing.** The conversation is re-sent to a cache that cannot help it, so the whole of `C` is written fresh at the 2x cache-write weight:

```
naive ≈ 2 × C
```

**Handoff crossing.** A fresh session on the other side pays for its own preamble plus the handoff, and nothing else:

```
handoff ≈ 2 × (S + H)
```

`C` grows all session. `S + H` does not. That gap is the entire product, and it widens the longer you work.

## A worked example, from a real session

Measured on the session that wrote this file, read from its own transcript:

| | Value |
|---|---|
| Context (`C`) | 149,884 tokens |
| Naive crossing (`2C`) | ≈ 299,768 weighted |
| Handoff crossing (`2(S+H)`) | ≈ 42,604 weighted |
| Difference | ≈ 257,000 weighted, about 86% less |

This is what `lodestone status` prints as `switch tax now`, and what the statusline shows as `switch 300k→43k`. It is computed from a measured `C` and a measured handoff size. It is not a guess at a percentage of your plan, and lodestone will refuse to print one of those: see "the 9297% rule" below.

## Reproducing it on your own data

```bash
lodestone status          # the switch tax right now, from your live context
lodestone audit           # every boundary you actually crossed, and what each cost
lodestone audit --json    # the same, machine readable
```

`audit` reads your own transcripts. It reports two kinds of event:

- **Explicit**, from a handoff that was written and then consumed. The record says which account wrote it, which account picked it up, and how big the context was at the time. This is evidence, not inference.
- **Heuristic**, from session timing alone, for boundaries you crossed before you installed lodestone. Weaker, and labeled as such.

Events are classified `switch` (a different account picked it up), `refresh` (same account, session deliberately shed), or `post-reset` (same account, picked up after a usage window reset), so you can see which kind of crossing is actually costing you.

## The 9297% rule

An early build printed a usage figure of "9297%". It got there by dividing measured tokens by a plan budget it was only guessing at. The rule that came out of that: **never print a percentage of a quantity you do not actually know.** When live quota data is unavailable, lodestone reports what it measured in weighted tokens and says the source is an estimate. It never converts that into a confident-looking percentage. Anything labeled `est` is a local model; anything labeled `live` came from Claude Code's own quota feed or, with `realUsage` on, from your own usage endpoint.

## What this does not prove

Being straight about the limits, because the numbers above are a model applied to real measurements, not a controlled experiment:

- **No controlled A/B has been run.** Doing the naive arm honestly means deliberately burning a full context replay on a second account, which is the exact cost the tool exists to avoid. The naive figure is therefore computed from the measured `C` using the pricing weights, not observed. The handoff figure is observed.
- **The weighting is a model.** Subscription usage accounting is not published in full. The weights come from documented API cache pricing and match observed behavior, but they approximate an accounting formula we cannot see. That is why raw token buckets are always reported alongside weighted figures, and why real `used_percentage` deltas are preferred whenever they are available.
- **`S` varies by machine.** Your preamble depends on the size of your CLAUDE.md and your tool set. A big CLAUDE.md raises the floor for every fresh session, including the ones lodestone creates.
- **Compounding is claimed, not yet measured.** The model says a naive crossing keeps paying, because `C` is dragged into every subsequent turn, while a handoff crossing does not. That follows from how caching works, and it is not separately validated here.
- **One machine, one user.** These figures are from real sessions, not from a study. `audit` exists precisely so that you do not have to believe them: run it against your own history.

## Threats we actively guard against

- The undocumented usage endpoint could change or disappear. It is a secondary source, never the only one, and every consumer degrades to an estimate and says so.
- Heuristic audit events can be wrong (two sessions close in time are not necessarily a handoff). They are labeled `heuristic` and are suppressed wherever an explicit record exists for the same crossing.
- A handoff's consumption record has to survive the handoffs that come after it, or the audit trail quietly rots. It is written to the archive beside the handoff itself, and there is a test pinning that.
