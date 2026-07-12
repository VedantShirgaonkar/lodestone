import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { handoffDirFor, trailHandoffPathFor, trailMetaPathFor } from "./paths.js";
import { loadConfig } from "./config.js";

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
  /** Trail only: mtime (ms) of trail.md at consumption. A later trail update
   *  (newer mtime) makes the trail eligible for injection again. */
  consumedTrailMtimeMs?: number;
}

/** Which store freshest() picked — each has its own consumption marker. */
export type HandoffOrigin = "latest" | "trail" | "auto";

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
 * Mark trail as consumed.
 */
export function markTrailConsumed(
  projectRoot: string,
  byProfile: string,
  bySession: string
): void {
  const trailMetaPath = trailMetaPathFor(projectRoot);
  const trailPath = trailHandoffPathFor(projectRoot);

  try {
    // First consumption has no meta yet — create it, or the trail
    // re-injects on every session start forever.
    let meta: HandoffMeta;
    if (existsSync(trailMetaPath)) {
      meta = JSON.parse(readFileSync(trailMetaPath, "utf8")) as HandoffMeta;
    } else {
      meta = {
        schema: 1,
        created: new Date().toISOString(),
        sourceProfile: "trail",
        sourceSession: "trail",
        project: projectRoot,
        contextTokens: 0,
        distilled: false,
        consumed: false,
      };
    }
    meta.consumed = true;
    meta.consumedBy = {
      profile: byProfile,
      session: bySession,
      at: new Date().toISOString(),
    };
    // Record WHICH version of the trail was consumed: a later update revives it.
    meta.consumedTrailMtimeMs = existsSync(trailPath)
      ? statSync(trailPath).mtime.getTime()
      : Date.now();
    writeFileSync(trailMetaPath, JSON.stringify(meta, null, 2), "utf8");
  } catch {
    // Silent fail
  }
}

/**
 * Mark an auto-snapshot as consumed (its own .meta.json sibling).
 */
export function markAutoConsumed(
  projectRoot: string,
  autoMdPath: string,
  byProfile: string,
  bySession: string
): void {
  try {
    const metaFile = autoMdPath.replace(/\.md$/, ".meta.json");
    let meta: HandoffMeta;
    if (existsSync(metaFile)) {
      meta = JSON.parse(readFileSync(metaFile, "utf8")) as HandoffMeta;
    } else {
      meta = {
        schema: 1,
        created: new Date().toISOString(),
        sourceProfile: "auto",
        sourceSession: "auto",
        project: projectRoot,
        contextTokens: 0,
        distilled: false,
        consumed: false,
      };
    }
    meta.consumed = true;
    meta.consumedBy = {
      profile: byProfile,
      session: bySession,
      at: new Date().toISOString(),
    };
    writeFileSync(metaFile, JSON.stringify(meta, null, 2), "utf8");
  } catch {
    // Silent fail
  }
}

/**
 * Find the freshest handoff: explicit latest.md (unconsumed) > fresh trail.md
 * (unconsumed at its current mtime) > newest UNCONSUMED auto/<session>.md.
 * Returns the origin so the caller can mark the right store consumed —
 * marking latest.meta.json for a trail/auto injection would loop forever.
 */
export function freshest(projectRoot: string): { markdown: string; meta: HandoffMeta; origin: HandoffOrigin; path: string } | undefined {
  const handoffDir = handoffDirFor(projectRoot);
  const latestPath = join(handoffDir, "latest.md");
  const trailPath = trailHandoffPathFor(projectRoot);
  const trailMetaPath = trailMetaPathFor(projectRoot);
  const autoDir = join(handoffDir, "auto");

  // Check latest first (unconsumed only)
  if (existsSync(latestPath)) {
    const loaded = loadLatestHandoff(projectRoot);
    if (loaded && !loaded.meta.consumed) {
      return { ...loaded, origin: "latest", path: latestPath };
    }
  }

  // Check trail.md next (if fresh)
  if (existsSync(trailPath)) {
    try {
      const config = loadConfig();
      const maxAgeDays = config.settings.maxAgeDays ?? 7;
      const stat = statSync(trailPath);
      const ageMs = Date.now() - stat.mtime.getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);

      if (ageDays <= maxAgeDays) {
        const markdown = readFileSync(trailPath, "utf8");
        // Load trail meta if it exists, or construct a basic one
        let meta: HandoffMeta | undefined;
        if (existsSync(trailMetaPath)) {
          try {
            const rawMeta = readFileSync(trailMetaPath, "utf8");
            meta = JSON.parse(rawMeta) as HandoffMeta;
          } catch {
            // Fall through
          }
        }

        // Consumed at this exact version? Skip to auto/ — but a NEWER trail
        // update (Claude kept writing after consumption) revives eligibility.
        const consumedAtThisVersion =
          meta?.consumed === true &&
          (meta.consumedTrailMtimeMs === undefined ||
            stat.mtime.getTime() <= meta.consumedTrailMtimeMs);

        if (!consumedAtThisVersion) {
          if (!meta) {
            // Create a basic meta for trail
            meta = {
              schema: 1,
              created: new Date(stat.mtime).toISOString(),
              sourceProfile: "trail",
              sourceSession: "trail",
              project: "unknown",
              contextTokens: 0, // Trail doesn't have a quantifiable token count
              distilled: false,
              consumed: false,
            };
          }
          return { markdown, meta, origin: "trail", path: trailPath };
        }
      }
    } catch {
      // Fall through
    }
  }

  // Check auto/
  if (!existsSync(autoDir)) {
    return undefined;
  }

  try {
    // Newest-first over UNCONSUMED autos only — a consumed auto that stayed
    // newest would otherwise re-inject on every session start.
    const candidates = readdirSync(autoDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => {
        const filePath = join(autoDir, f);
        return { filePath, mtime: statSync(filePath).mtime.getTime() };
      })
      .sort((a, b) => b.mtime - a.mtime);

    for (const { filePath } of candidates) {
      const metaFile = filePath.replace(/\.md$/, ".meta.json");
      let meta: HandoffMeta | undefined;
      if (existsSync(metaFile)) {
        try {
          meta = JSON.parse(readFileSync(metaFile, "utf8")) as HandoffMeta;
        } catch {
          meta = undefined;
        }
      }
      if (meta?.consumed) continue;
      if (meta) {
        const markdown = readFileSync(filePath, "utf8");
        return { markdown, meta, origin: "auto", path: filePath };
      }
      // No parseable meta: usable, but build a minimal one
      const markdown = readFileSync(filePath, "utf8");
      return {
        markdown,
        meta: {
          schema: 1,
          created: new Date().toISOString(),
          sourceProfile: "auto",
          sourceSession: "auto",
          project: projectRoot,
          contextTokens: 0,
          distilled: false,
          consumed: false,
        },
        origin: "auto",
        path: filePath,
      };
    }
  } catch {
    // Silent fail
  }

  return undefined;
}
