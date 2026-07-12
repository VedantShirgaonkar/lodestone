import { ExtractedSnapshot } from "./extract.js";
import { renderHandoff, estimateTokens, HandoffMeta } from "./handoffFile.js";

export interface ComposedHandoff {
  markdown: string;
  meta: HandoffMeta & { quality?: number | undefined };
  tokens: number;
  quality: number;
}

/**
 * Compose a handoff from extracted snapshot data.
 * Unified render logic used by snapshot, hook, and other commands.
 * Quality score: 0–5 across goal/state/decisions/files/next-steps.
 */
export function composeHandoff(
  extracted: ExtractedSnapshot,
  opts: {
    sourceProfile: string;
    sourceSession: string;
    project: string;
    branch?: string | undefined;
    contextTokens: number;
    distilled: boolean;
    created?: string | undefined;
  }
): ComposedHandoff {
  // Render the handoff
  const goal = extracted.goal || "(no goal found)";
  const state =
    extracted.lastThreePrompts.length > 0
      ? extracted.lastThreePrompts.join("\n---\n")
      : "(no recent activity)";
  const decisions = extracted.latestCompactSummary
    ? `From the last compaction summary:\n\n${extracted.latestCompactSummary}`
    : "(none recorded)";
  const files =
    extracted.filesEdited.length > 0 || extracted.filesRead.length > 0
      ? [
          extracted.filesEdited
            .map((f) => `- ${f.name} (${f.count} edits)`)
            .join("\n"),
          extracted.filesRead.map((f) => `- ${f} (read)`).join("\n"),
        ]
          .filter(Boolean)
          .join("\n")
      : "(no files)";
  const lastExchange = extracted.finalAssistantText || "(no exchange)";
  const nextSteps =
    extracted.latestTodos.length > 0
      ? extracted.latestTodos.map((t) => `- ${t}`).join("\n")
      : "(none)";
  const openQuestions = "(none recorded)";

  const renderResult = renderHandoff({
    goal,
    state,
    decisions,
    files,
    lastExchange,
    nextSteps,
    openQuestions,
    sourceProfile: opts.sourceProfile,
    sourceSession: opts.sourceSession,
    project: opts.project,
    branch: opts.branch,
    contextTokens: opts.contextTokens,
    distilled: opts.distilled,
    created: opts.created,
  });

  const { markdown, meta } = renderResult;
  const tokens = estimateTokens(markdown);

  // Calculate completeness score (0–5)
  // +1: goal found (non-placeholder)
  // +1: state found (at least one recent prompt)
  // +1: decisions found (from compact summary)
  // +1: files present (≥1 file)
  // +1: next steps found
  let quality = 0;

  if (goal && !goal.includes("(no goal found)")) quality++;
  if (state && !state.includes("(no recent activity)")) quality++;
  if (decisions && !decisions.includes("(none recorded)")) quality++;
  if (files && !files.includes("(no files)")) quality++;
  if (nextSteps && !nextSteps.includes("(none)")) quality++;

  const metaWithQuality: HandoffMeta & { quality: number } = {
    ...meta,
    quality,
  };

  return {
    markdown,
    meta: metaWithQuality,
    tokens,
    quality,
  };
}
