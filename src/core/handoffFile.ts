import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { handoffDirFor } from "./paths.js";

export interface HandoffMeta {
  schema: number;
  created: string;
  sourceProfile: string;
  sourceSession: string;
  project: string;
  branch?: string | undefined;
  contextTokens: number;
  distilled: boolean;
  consumed: boolean;
  consumedBy?: { profile: string; session: string; at: string } | undefined;
  quality?: number;
}

const TARGET_TOKENS = 2500;
const HARD_CAP_TOKENS = 4000;

/**
 * Estimate token count from character count.
 * Rough estimate: 1 token ≈ 3.6 chars
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

/**
 * Render a handoff markdown file with frontmatter and content.
 * Sections: Goal, State of work, Key decisions & constraints, Files in play,
 * Last exchange, Next steps, Open questions.
 * Target ≤2500 tokens, hard cap 4000; truncate oldest-first with notice.
 */
export function renderHandoff(snapshot: {
  goal: string;
  state: string;
  decisions: string;
  files: string;
  lastExchange: string;
  nextSteps: string;
  openQuestions: string;
  sourceProfile: string;
  sourceSession: string;
  project: string;
  branch?: string | undefined;
  contextTokens: number;
  distilled: boolean;
  created?: string | undefined;
}): { markdown: string; meta: HandoffMeta } {
  const created = snapshot.created ?? new Date().toISOString();

  const content = `# Handoff Snapshot

## Goal
${snapshot.goal}

## State of work
${snapshot.state}

## Key decisions & constraints
${snapshot.decisions}

## Files in play
${snapshot.files}

## Last exchange
${snapshot.lastExchange}

## Next steps
${snapshot.nextSteps}

## Open questions
${snapshot.openQuestions}
`;

  // Estimate and truncate if needed
  let finalContent = content;
  let tokenCount = estimateTokens(content);

  if (tokenCount > HARD_CAP_TOKENS) {
    // Truncate oldest sections first (Goal, State, Decisions)
    const sections = [
      "## Goal",
      "## State of work",
      "## Key decisions & constraints",
    ];
    for (const section of sections) {
      if (tokenCount <= TARGET_TOKENS) break;
      const idx = finalContent.indexOf(section);
      if (idx >= 0) {
        const nextSectionIdx = finalContent.indexOf("\n##", idx + 1);
        if (nextSectionIdx >= 0) {
          finalContent =
            finalContent.substring(0, idx) +
            `[Truncated for length]\n` +
            finalContent.substring(nextSectionIdx);
          tokenCount = estimateTokens(finalContent);
        }
      }
    }
  }

  const frontmatter = `---
created: ${created}
sourceProfile: ${snapshot.sourceProfile}
sourceSession: ${snapshot.sourceSession}
project: ${snapshot.project}
branch: ${snapshot.branch ?? "unknown"}
contextTokens: ${snapshot.contextTokens}
distilled: ${snapshot.distilled}
---

`;

  const markdown = frontmatter + finalContent;

  const meta: HandoffMeta = {
    schema: 1,
    created,
    sourceProfile: snapshot.sourceProfile,
    sourceSession: snapshot.sourceSession,
    project: snapshot.project,
    branch: snapshot.branch,
    contextTokens: snapshot.contextTokens,
    distilled: snapshot.distilled,
    consumed: false,
  };

  return { markdown, meta };
}

/**
 * Save a handoff to disk and archive older versions.
 * Writes to <projectRoot>/.claude/handoff/latest.md
 * and <projectRoot>/.claude/handoff/latest.meta.json
 * Archives to <projectRoot>/.claude/handoff/archive/<timestamp>.md
 * Keeps 20 most recent archives.
 */
export function saveHandoff(
  projectRoot: string,
  markdown: string,
  meta: HandoffMeta
): void {
  const handoffDir = handoffDirFor(projectRoot);
  const autoDir = join(handoffDir, "auto");
  const archiveDir = join(handoffDir, "archive");

  mkdirSync(handoffDir, { recursive: true });
  mkdirSync(autoDir, { recursive: true });
  mkdirSync(archiveDir, { recursive: true });

  // Save latest
  const latestPath = join(handoffDir, "latest.md");
  const metaPath = join(handoffDir, "latest.meta.json");

  writeFileSync(latestPath, markdown, "utf8");
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");

  // Archive
  const archiveName = `${meta.created.replace(/[:.]/g, "-")}.md`;
  const archivePath = join(archiveDir, archiveName);
  writeFileSync(archivePath, markdown, "utf8");

  // Rotate: keep 20 most recent
  try {
    const files = readdirSync(archiveDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({
        name: f,
        mtime: statSync(join(archiveDir, f)).mtime.getTime(),
      }))
      .sort((a, b) => b.mtime - a.mtime);

    for (let i = 20; i < files.length; i++) {
      const file = files[i];
      if (file) {
        const obsolete = join(archiveDir, file.name);
        unlinkSync(obsolete);
      }
    }
  } catch {
    // Silent fail on rotation
  }
}

/**
 * Read the latest handoff markdown and meta.
 */
export function loadLatestHandoff(
  projectRoot: string
): { markdown: string; meta: HandoffMeta } | undefined {
  const handoffDir = handoffDirFor(projectRoot);
  const latestPath = join(handoffDir, "latest.md");
  const metaPath = join(handoffDir, "latest.meta.json");

  if (!existsSync(latestPath) || !existsSync(metaPath)) {
    return undefined;
  }

  try {
    const markdown = readFileSync(latestPath, "utf8");
    const rawMeta = readFileSync(metaPath, "utf8");
    const meta = JSON.parse(rawMeta) as HandoffMeta;
    return { markdown, meta };
  } catch {
    return undefined;
  }
}

/**
 * Mark a handoff as consumed.
 */
export function markConsumed(
  projectRoot: string,
  byProfile: string,
  bySession: string
): void {
  const handoffDir = handoffDirFor(projectRoot);
  const metaPath = join(handoffDir, "latest.meta.json");

  if (!existsSync(metaPath)) {
    return;
  }

  try {
    const rawMeta = readFileSync(metaPath, "utf8");
    const meta = JSON.parse(rawMeta) as HandoffMeta;
    meta.consumed = true;
    meta.consumedBy = {
      profile: byProfile,
      session: bySession,
      at: new Date().toISOString(),
    };
    writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
  } catch {
    // Silent fail
  }
}

/**
 * Find the freshest handoff: explicit latest.md else newest auto/<session>.md
 */
export function freshest(projectRoot: string): { markdown: string; meta: HandoffMeta } | undefined {
  const handoffDir = handoffDirFor(projectRoot);
  const latestPath = join(handoffDir, "latest.md");
  const autoDir = join(handoffDir, "auto");

  // Check latest first
  if (existsSync(latestPath)) {
    const loaded = loadLatestHandoff(projectRoot);
    if (loaded) return loaded;
  }

  // Check auto/
  if (!existsSync(autoDir)) {
    return undefined;
  }

  try {
    let newestFile: string | undefined;
    let newestMtime = 0;

    const files = readdirSync(autoDir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const filePath = join(autoDir, file);
      const stat = statSync(filePath);
      if (stat.mtime.getTime() > newestMtime) {
        newestMtime = stat.mtime.getTime();
        newestFile = filePath;
      }
    }

    if (newestFile) {
      const markdown = readFileSync(newestFile, "utf8");
      // Try to parse meta if it exists as .json sibling
      const metaFile = newestFile.replace(".md", ".meta.json");
      if (existsSync(metaFile)) {
        try {
          const rawMeta = readFileSync(metaFile, "utf8");
          const meta = JSON.parse(rawMeta) as HandoffMeta;
          return { markdown, meta };
        } catch {
          // Fall through
        }
      }
    }
  } catch {
    // Silent fail
  }

  return undefined;
}
