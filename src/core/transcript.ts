import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readJsonlLines } from "../util/jsonl.js";
import { mungeCwd, projectsDirFor } from "./paths.js";

export interface TranscriptLine {
  type?: string;
  uuid?: string;
  message?: unknown;
  parentUuid?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  userType?: string;
  slug?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  subtype?: string;
  [key: string]: unknown;
}

/**
 * Turn = one unique assistant message (identified by message.id).
 * No userPrompt field; userPrompts are tracked separately.
 */
export interface Turn {
  timestamp?: string | undefined;
  model?: string | undefined;
  assistantText?: string | undefined; // May be empty string for tool_use-only
  toolUses?: Array<{ name: string; input: unknown }> | undefined;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  } | undefined;
}

/**
 * Genuine user prompt extracted from a user line.
 * Only includes non-meta, non-compact-summary, non-empty, non-slash-command user lines.
 */
export interface UserPrompt {
  text: string;
  timestamp?: string | undefined;
}

export interface SessionMeta {
  sessionId?: string | undefined;
  slug?: string | undefined;
  model?: string | undefined; // Last non-synthetic assistant model
  gitBranch?: string | undefined;
  cwd?: string | undefined;
  version?: string | undefined;
  firstTs?: string | undefined;
  lastTs?: string | undefined;
}

export interface ParsedSession {
  meta: SessionMeta;
  turns: Turn[]; // One per unique assistant message.id
  userPrompts: UserPrompt[]; // Genuine prompts only
  toolUses: Array<{ name: string; input: unknown }>; // Flattened from turns
  compactSummaries: string[];
  parseErrors: Array<{ lineNo: number; error: string }>;
  /** Total JSONL lines seen (parsed + malformed) — denominator for error rates. */
  lineCount: number;
}

/**
 * Parse a transcript JSONL file.
 * Tolerant of malformed lines and unknown types.
 * Dedupes assistant lines by message.id (keeps last).
 * Filters out sidechains.
 * Captures compact summaries and parse errors.
 */
export async function parseSession(path: string): Promise<ParsedSession> {
  const lines: TranscriptLine[] = [];
  const parseErrors: Array<{ lineNo: number; error: string }> = [];
  let lineCount = 0;

  // Read and parse all lines
  for await (const entry of readJsonlLines(path)) {
    lineCount++;
    if (entry.error) {
      parseErrors.push({ lineNo: entry.lineNo, error: entry.error });
    } else if (entry.value) {
      lines.push(entry.value as TranscriptLine);
    }
  }

  // Filter sidechains
  const mainThread = lines.filter((line) => !line.isSidechain);

  // Dedupe assistant lines by message.id (or uuid), keeping last
  const assistantMap = new Map<
    string,
    { line: TranscriptLine; index: number }
  >();
  const nonAssistantLines: Array<{ line: TranscriptLine; originalIndex: number }> = [];

  for (let i = 0; i < mainThread.length; i++) {
    const line = mainThread[i];
    if (!line) continue;

    if (line.type === "assistant") {
      const msg = line.message as Record<string, unknown> | undefined;
      const id = (msg?.id ?? line.uuid) as string | undefined;
      if (id) {
        assistantMap.set(id, { line, index: i });
      }
    } else {
      nonAssistantLines.push({ line, originalIndex: i });
    }
  }

  // Reconstruct: merge non-assistants and deduplicated assistants in order
  const assistantLines = Array.from(assistantMap.values()).sort(
    (a, b) => a.index - b.index
  );

  const finalLines: TranscriptLine[] = [];
  let assistantIdx = 0;
  let nonAssistantIdx = 0;

  // Merge in original order
  for (let i = 0; i < mainThread.length; i++) {
    const nextAssistant = assistantLines[assistantIdx];
    const nextNonAssistant = nonAssistantLines[nonAssistantIdx];

    if (nextAssistant && nextAssistant.index === i) {
      finalLines.push(nextAssistant.line);
      assistantIdx++;
    } else if (nextNonAssistant && nextNonAssistant.originalIndex === i) {
      finalLines.push(nextNonAssistant.line);
      nonAssistantIdx++;
    }
  }

  // Extract session metadata by scanning backward for first line with each field
  let sessionId: string | undefined = undefined;
  let slug: string | undefined = undefined;
  let model: string | undefined = undefined;
  let gitBranch: string | undefined = undefined;
  let cwd: string | undefined = undefined;
  let version: string | undefined = undefined;
  let firstTs: string | undefined = undefined;
  let lastTs: string | undefined = undefined;

  if (finalLines.length > 0) {
    // Not every line is timestamped: a transcript commonly opens with an
    // `ai-title` line and closes with a `summary` or `file-history-snapshot`,
    // none of which carry one. Taking the literal ends leaves firstTs/lastTs
    // undefined, which silently defeats every staleness check downstream (dash
    // shows month-old sessions as live, audit cannot measure a session gap).
    // Take the outermost lines that actually carry a time.
    for (let i = finalLines.length - 1; i >= 0 && !lastTs; i--) {
      lastTs = finalLines[i]?.timestamp;
    }
    for (let i = 0; i < finalLines.length && !firstTs; i++) {
      firstTs = finalLines[i]?.timestamp;
    }

    // Scan backward for fields
    for (let i = finalLines.length - 1; i >= 0; i--) {
      const line = finalLines[i];
      if (!line) continue;

      if (!sessionId) sessionId = line.sessionId;
      if (!slug) slug = line.slug;
      if (!gitBranch) gitBranch = line.gitBranch;
      if (!cwd) cwd = line.cwd;
      if (!version) version = line.version;

      // Model: last non-synthetic assistant model
      if (line.type === "assistant" && !model) {
        const msg = line.message as Record<string, unknown> | undefined;
        const msgModel = msg?.model;
        if (
          msgModel &&
          typeof msgModel === "string" &&
          msgModel !== "<synthetic>"
        ) {
          model = msgModel;
        }
      }

      // Stop if all fields found
      if (
        sessionId &&
        slug &&
        gitBranch &&
        cwd &&
        version &&
        model &&
        firstTs &&
        lastTs
      ) {
        break;
      }
    }
  }

  // Extract turns (one per unique assistant message.id)
  const turns: Turn[] = [];
  const toolUses: Array<{ name: string; input: unknown }> = [];
  const userPrompts: UserPrompt[] = [];
  const compactSummaries: string[] = [];

  for (const line of finalLines) {
    if (!line) continue;

    if (line.type === "user") {
      // Check for compact summary marker (regardless of isMeta)
      if (line.isCompactSummary) {
        const userContent = extractUserContent(line.message);
        if (userContent) {
          compactSummaries.push(userContent);
        }
      }

      // Only process non-meta user lines as genuine prompts
      if (!line.isMeta) {
        const userContent = extractUserContent(line.message);

        if (userContent) {
          // Check if this is a tool_result-only message (plumbing, not a prompt)
          const msg = line.message as Record<string, unknown> | undefined;
          const content = msg?.content;
          const isToolResultOnly =
            Array.isArray(content) &&
            content.every(
              (c) =>
                typeof c === "object" &&
                c !== null &&
                (c as Record<string, unknown>).type === "tool_result"
            );

          // Also exclude slash commands (text beginning with "<command-name>" or "<local-command")
          const isSlashCommand =
            userContent.match(/^<\w+/) !== null;

          // Exclude empty/whitespace-only
          const isEmpty = userContent.trim().length === 0;

          if (!isToolResultOnly && !isSlashCommand && !isEmpty) {
            userPrompts.push({ text: userContent, timestamp: line.timestamp });
          }
        }
      }
    } else if (line.type === "assistant") {
      const msg = line.message as Record<string, unknown> | undefined;

      // Extract assistant text from content blocks (may be empty for tool_use-only)
      let assistantText = "";
      const msgContent = msg?.content as unknown[] | undefined;
      if (Array.isArray(msgContent)) {
        for (const block of msgContent) {
          if (
            typeof block === "object" &&
            block !== null &&
            "text" in block &&
            typeof (block as Record<string, unknown>).text === "string"
          ) {
            assistantText += (block as Record<string, unknown>).text;
          }
        }
      }

      // Extract tool uses from content blocks
      const turnToolUses: Array<{ name: string; input: unknown }> = [];
      if (Array.isArray(msgContent)) {
        for (const block of msgContent) {
          if (
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            (block as Record<string, unknown>).type === "tool_use"
          ) {
            const toolName = (block as Record<string, unknown>)?.name;
            const toolInput = (block as Record<string, unknown>)?.input;
            if (typeof toolName === "string") {
              turnToolUses.push({ name: toolName, input: toolInput });
              toolUses.push({ name: toolName, input: toolInput });
            }
          }
        }
      }

      // Extract usage from message.usage
      let usage: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens: number;
        cache_read_input_tokens: number;
      } | undefined = undefined;
      const msgUsage = msg?.usage as Record<string, unknown> | undefined;
      if (msgUsage && typeof msgUsage === "object") {
        usage = {
          input_tokens: (msgUsage.input_tokens as number) ?? 0,
          output_tokens: (msgUsage.output_tokens as number) ?? 0,
          cache_creation_input_tokens:
            (msgUsage.cache_creation_input_tokens as number) ?? 0,
          cache_read_input_tokens:
            (msgUsage.cache_read_input_tokens as number) ?? 0,
        };
      }

      // Create turn
      const turn: Turn = {
        timestamp: line.timestamp,
        model: msg?.model ? String(msg.model) : undefined,
        assistantText: assistantText,
        toolUses: turnToolUses.length > 0 ? turnToolUses : undefined,
        usage,
      };
      turns.push(turn);
    }
  }

  return {
    meta: { sessionId, slug, model, gitBranch, cwd, version, firstTs, lastTs },
    turns,
    userPrompts,
    toolUses,
    compactSummaries,
    parseErrors,
    lineCount,
  };
}

/**
 * Extract user content from message field.
 * Handles both string and ContentBlock[] formats.
 * Returns concatenated text, or empty if only tool_result blocks.
 */
function extractUserContent(msg: unknown): string {
  if (typeof msg === "string") {
    return msg;
  }

  if (typeof msg === "object" && msg !== null) {
    const msgObj = msg as Record<string, unknown>;
    const content = msgObj.content;

    if (typeof content === "string") {
      return content;
    }

    if (Array.isArray(content)) {
      const textParts: string[] = [];
      for (const block of content) {
        if (
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          "text" in block &&
          typeof (block as Record<string, unknown>).text === "string"
        ) {
          textParts.push((block as Record<string, unknown>).text as string);
        }
      }
      return textParts.join("\n");
    }
  }

  return "";
}

/**
 * Newest .jsonl inside an already-resolved project directory (that is, a
 * `projects/<munged>/` folder). Callers that are walking `projects/` already
 * hold this path; munging it a second time would produce a directory that does
 * not exist.
 */
export function newestSessionIn(projectDir: string): string | undefined {
  if (!existsSync(projectDir)) {
    return undefined;
  }

  let latestFile: string | undefined;
  let latestMtime = 0;

  try {
    for (const file of readdirSync(projectDir)) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = join(projectDir, file);
      const mtime = statSync(filePath).mtime.getTime();
      if (mtime > latestMtime) {
        latestMtime = mtime;
        latestFile = filePath;
      }
    }
  } catch {
    return undefined;
  }

  return latestFile;
}

/**
 * Find the latest session for a working directory in a config directory.
 * Returns the path to the newest .jsonl file under projects/<munged-cwd>/
 */
export function latestSession(
  configDir: string,
  cwd: string
): string | undefined {
  return newestSessionIn(join(projectsDirFor(configDir), mungeCwd(cwd)));
}

/**
 * Extract the context tokens from a usage entry.
 * = input + cache_read + cache_creation
 */
export function contextTokensOf(
  usage:
    | {
        input_tokens?: number | undefined;
        cache_read_input_tokens?: number | undefined;
        cache_creation_input_tokens?: number | undefined;
      }
    | undefined
): number {
  if (!usage) return 0;
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

/**
 * Get the latest context tokens: for the last turn whose total usage > 0,
 * return that total. Otherwise 0.
 * Excludes synthetic messages and zero-usage turns.
 */
export function latestContextTokens(parsed: ParsedSession): number {
  for (let i = parsed.turns.length - 1; i >= 0; i--) {
    const turn = parsed.turns[i];
    if (turn && turn.usage) {
      const total = contextTokensOf(turn.usage);
      if (total > 0) {
        return total;
      }
    }
  }
  return 0;
}
