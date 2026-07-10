import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ParsedSession } from "./transcript.js";
import { latestContextTokens } from "./transcript.js";

export interface GitInfo {
  branch?: string | undefined;
  isDirty?: boolean | undefined;
  status?: string | undefined;
}

export interface ExtractedSnapshot {
  goal: string;
  lastThreePrompts: string[];
  latestTodos: string[];
  filesEdited: Array<{ name: string; count: number }>;
  filesRead: string[];
  finalAssistantText: string;
  latestCompactSummary: string | undefined;
  gitInfo: GitInfo;
  metrics: {
    contextTokens: number;
    turnCount: number;
    sessionDurationMin: number;
  };
}

/**
 * Extract a deterministic snapshot from a parsed session.
 * Pure function over parsed transcript + injected gitInfo.
 * Uses new model: userPrompts separate from turns, latestContextTokens helper.
 */
export function extractSnapshot(
  parsed: ParsedSession,
  opts?: { gitInfo?: GitInfo }
): ExtractedSnapshot {
  const gitInfo = opts?.gitInfo ?? {};

  // Goal: first genuine user prompt (>20 chars), truncate 600
  let goal = "";
  for (const prompt of parsed.userPrompts) {
    if (prompt.text.length > 20) {
      goal = prompt.text.substring(0, 600);
      break;
    }
  }

  // Last 3 user prompts (300 chars each)
  const lastThreePrompts: string[] = [];
  for (let i = parsed.userPrompts.length - 1; i >= 0 && lastThreePrompts.length < 3; i--) {
    const prompt = parsed.userPrompts[i];
    if (prompt) {
      lastThreePrompts.unshift(prompt.text.substring(0, 300));
    }
  }

  // Latest TodoWrite todos (from toolUses)
  const latestTodos: string[] = [];
  for (let i = parsed.toolUses.length - 1; i >= 0; i--) {
    const toolUse = parsed.toolUses[i];
    if (toolUse && toolUse.name === "TodoWrite") {
      const input = toolUse.input as Record<string, unknown> | undefined;
      if (input && Array.isArray(input.todos)) {
        for (const todo of input.todos) {
          if (typeof todo === "string") {
            latestTodos.push(todo);
          }
        }
      }
      break;
    }
  }

  // Files: edits ranked by count, reads top 10
  const editedFilesMap = new Map<string, number>();
  const readFilesSet = new Set<string>();

  for (const toolUse of parsed.toolUses) {
    if (!toolUse) continue;
    const input = toolUse.input as Record<string, unknown> | undefined;
    if (
      toolUse.name === "EditFile" ||
      toolUse.name === "WriteFile" ||
      toolUse.name === "Write" ||
      toolUse.name === "Edit" ||
      toolUse.name === "NotebookEdit"
    ) {
      const path = input?.path;
      if (typeof path === "string") {
        editedFilesMap.set(path, (editedFilesMap.get(path) ?? 0) + 1);
      }
    } else if (toolUse.name === "Read" || toolUse.name === "Grep") {
      const path = input?.path ?? input?.file_path;
      if (typeof path === "string") {
        readFilesSet.add(path);
      }
    }
  }

  const filesEdited = Array.from(editedFilesMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([name, count]) => ({ name, count }));

  const filesRead = Array.from(readFilesSet).slice(0, 10);

  // Final assistant text (1500 chars): last non-empty assistantText across turns
  let finalAssistantText = "";
  for (let i = parsed.turns.length - 1; i >= 0; i--) {
    const turn = parsed.turns[i];
    if (turn && turn.assistantText && turn.assistantText.length > 0) {
      finalAssistantText = turn.assistantText.substring(0, 1500);
      break;
    }
  }

  // Latest compact summary (2000 chars)
  let latestCompactSummary: string | undefined = undefined;
  if (parsed.compactSummaries.length > 0) {
    const lastSummary = parsed.compactSummaries[parsed.compactSummaries.length - 1];
    if (lastSummary) {
      latestCompactSummary = lastSummary.substring(0, 2000);
    }
  }

  // Context tokens via helper (skips zero-usage and synthetic turns)
  const contextTokens = latestContextTokens(parsed);

  // Metrics
  const firstTs = parsed.meta.firstTs ? new Date(parsed.meta.firstTs).getTime() : 0;
  const lastTs = parsed.meta.lastTs ? new Date(parsed.meta.lastTs).getTime() : 0;
  const sessionDurationMin = Math.round((lastTs - firstTs) / (1000 * 60));

  return {
    goal,
    lastThreePrompts,
    latestTodos,
    filesEdited,
    filesRead,
    finalAssistantText,
    latestCompactSummary,
    gitInfo,
    metrics: {
      contextTokens,
      turnCount: parsed.turns.length,
      sessionDurationMin: Math.max(0, sessionDurationMin),
    },
  };
}

/**
 * Spawn git to get repo info (branch, dirty status).
 * 1s timeout, tolerant of absent git or errors.
 */
export function captureGitInfo(cwd: string): GitInfo {
  const result: GitInfo = {};
  try {
    // Get branch
    const branchResult = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout: 1000,
    });
    if (branchResult.status === 0) {
      result.branch = branchResult.stdout.trim();
    }

    // Get status
    const statusResult = spawnSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      timeout: 1000,
    });
    if (statusResult.status === 0) {
      result.isDirty = statusResult.stdout.length > 0;
      if (statusResult.stdout.length > 0) {
        result.status = statusResult.stdout.substring(0, 200);
      }
    }
  } catch {
    // Silent fail, return partial result
  }
  return result;
}
