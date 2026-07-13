# Research: Prior Art & Ecosystem Positioning

> Surveyed 2026-07-10. Conclusion: many partial solutions, none integrated; the account-switching + measured-handoff combination is unclaimed.

## Handoff-shaped tools (context preservation between sessions)

| Project | What it does | Gap vs lodestone |
|---|---|---|
| Sonovore/claude-code-handoff | Claude continuously maintains `.claude/session-state.md` during work | No account/profile layer, no measurement, relies on Claude remembering to update |
| antonwing77/session-handoff | Skill: commit+push code, write handoff doc to `.claude/handoffs/` + `LATEST.md`, "pickup" on the other side. Explicitly aimed at multiple accounts relaying via git | Manual; explicitly does NOT handle auth/profiles/usage/automation; 0 stars single-commit PoC |
| REMvisual/claude-handoff | Two skills capturing decisions/failed approaches/next steps | Session-continuity focus, no accounts, no automation |
| thepushkarp/handoff | Plugin: `/handoff:create`, auto-injects latest entry after compaction | Compaction survival focus, single account |
| maca0229/claude-context-resume | /handoff + /resume with git as transport (cross-device) | No profiles, no measurement |
| willseltzer/claude-handoff, BexTuychiev /transfer-context gist | Skill-based state docs | Same pattern |

Pattern: everyone converged on "write a structured markdown state file, read it in the next session" — validating the core mechanism — but all are skills that depend on manual invocation, none manage accounts, none quantify what a switch costs, none auto-snapshot deterministically from transcripts.

## Account/profile-shaped tools

| Project | What it does | Gap |
|---|---|---|
| CLAUDE_CONFIG_DIR alias pattern (many blog posts: melkon.tech, codeminer42, mohamedyamani, KMJ-007/heyogrady gists, dev.to/ashishxcode) | Shell aliases per config dir | No handoff, no shared memory, no measurement; "without losing context" in those posts means only *not logging out* |
| fortunto2 gist | macOS Keychain-based auth profile switcher | Auth only |
| jmdarre-v/claude-multiprofile | Isolated profiles for Desktop+Code on macOS | Profiles only |
| cc-switch (GUI, popular) | Switch providers/API endpoints/configs | Provider-config focus, not subscription accounts + context |

## Usage-measurement tools

- **ccusage** (npm, very popular): parses the same `projects/**/*.jsonl` files, daily/weekly/session/blocks reports, cost estimates from token buckets. Reads `~/.claude` and `~/.config/claude`; env var accepts comma-separated dirs. Complementary — lodestone links to it for deep reporting rather than reimplementing analytics; lodestone's own math is narrowly scoped to window-burn + switch-tax estimates.
- Claude-Code-Usage-Monitor, ccstatusline: real-time meters; same JSONL substrate.

## Upstream signals

- anthropics/claude-code issue #11455 "Feature Request: Session Handoff / Continuity Support" — unaddressed need, users asking for exactly this.
- Issue #56903 — claude.ai → Claude Code handoff drops context (adjacent pain).

## Positioning statement

lodestone = the **workflow tool**: profiles (isolated `CLAUDE_CONFIG_DIR` accounts) + deterministic transcript snapshots + hook-automated capture/rehydration + switch-tax measurement + an honest explainer of the cache physics. It deliberately does not compete with ccusage (analytics), cc-switch (provider configs), or in-repo handoff skills (it can coexist; its own skill covers that niche). Nothing in the ecosystem combines these layers today.
