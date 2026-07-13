# Docs

Read in this order. Everything here is in this directory.

## 1. Why any of this exists

[explainer/how-claude-code-memory-works.md](explainer/how-claude-code-memory-works.md)

How Claude Code's prompt cache actually works, what kills it, and why that is the thing that shreds your usage window. The foundation for everything else. Start here even if you never intend to install anything.

## 2. What lodestone is

[OVERVIEW.md](OVERVIEW.md)

One page, with ASCII architecture and data flows. The four boundaries it handles and how the pieces fit together.

## 3. Which feature lives where

[FEATURES.md](FEATURES.md)

The CLI and the editor extension are two faces of one engine. This is the matrix: what each surface can do, and why some things only exist on one of them.

## 4. How to use it

[GUIDE.md](GUIDE.md)

The user manual. Setup, the passive features that run without you, the active commands, how to read the numbers, and troubleshooting.

## 5. How it is built

[ARCHITECTURE.md](ARCHITECTURE.md)

Component design and data contracts: how the CLI, the hooks, the statusline and the extension exchange state. Read this before changing anything.

## 6. Whether the savings are real

[EVALUATION.md](EVALUATION.md)

The measurement methodology, the weighted-token model, and how to reproduce the numbers on your own transcripts instead of taking ours on faith.

## Research: verified facts about Claude Code

These are the ground truth the design rests on, gathered by reading the documentation, the API behavior, and real session files. Where something is inferred rather than documented, it says so.

- [01-prompt-caching.md](research/01-prompt-caching.md): cache TTLs, pricing weights, and why a cache can never cross an organization.
- [02-usage-limits.md](research/02-usage-limits.md): the 5-hour and weekly windows, and what counts against them.
- [03-claude-code-internals.md](research/03-claude-code-internals.md): the transcript JSONL schema, hooks, statusline contract, config directories.
- [04-realtime-usage-and-ui.md](research/04-realtime-usage-and-ui.md): where live quota data comes from, and the keepalive economics.
- [05-context-carry-economics.md](research/05-context-carry-economics.md): the boundary model, and an honest comparison of handoff, trail, native `/compact`, and just continuing.

## Design decisions

[decisions/](decisions/), ADR-001 through ADR-013. Settled calls, each with the context and the alternatives that were rejected: why a handoff rather than cache transfer, why zero runtime dependencies, why profiles use `CLAUDE_CONFIG_DIR`, how handoff quality is graded, why the extension is a thin client.

If a change would overturn one of these, open an issue first. They are settled, not sacred, but they should not be reversed silently.
