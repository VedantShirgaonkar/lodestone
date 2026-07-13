import { parseArgs } from "node:util";
import { statSync } from "node:fs";
import { join } from "node:path";
import { latestSession, parseSession } from "../core/transcript.js";
import { resolveActingProfile } from "../core/profiles.js";
import { findProjectRoot } from "../core/paths.js";
import { snapshot } from "./snapshot.js";
import { distill } from "../core/claudeCli.js";
import {
  loadLatestHandoff,
  estimateTokens,
  saveHandoff,
} from "../core/handoffFile.js";

interface CommandOptions {
  json: boolean;
  profile?: string | undefined;
}

interface HandoffOutput {
  path: string;
  tokens: number;
  sessionId: string;
  contextTokens: number;
  created: string;
  distilled?: boolean;
}

export async function handoff(
  args: string[],
  opts: CommandOptions
): Promise<number> {
  try {
    const { values: parsedOpts } = parseArgs({
      args,
      options: {
        distill: { type: "boolean" },
        force: { type: "boolean" },
        session: { type: "string" },
        quiet: { type: "boolean" },
      },
      allowPositionals: false,
      strict: true,
    });

    const doDistill = (parsedOpts.distill as boolean) ?? false;
    const force = (parsedOpts.force as boolean) ?? false;
    const sessionId = (parsedOpts.session as string) ?? undefined;
    const quiet = (parsedOpts.quiet as boolean) ?? false;

    // First, run snapshot
    const snapshotArgs = [];
    if (sessionId) {
      snapshotArgs.push("--session", sessionId);
    }
    snapshotArgs.push("--quiet");

    const snapshotResult = await snapshot(snapshotArgs, opts);
    if (snapshotResult !== 0) {
      return snapshotResult;
    }

    // If no distill, we're done (just return the snapshot)
    if (!doDistill) {
      if (!quiet) {
        const projectRoot = findProjectRoot(process.cwd());
        const handoff = loadLatestHandoff(projectRoot);
        if (handoff) {
          const markdown = handoff.markdown;
          const handoffTokens = estimateTokens(markdown);
          const meta = handoff.meta;

          if (opts.json) {
            const output: HandoffOutput = {
              path: join(projectRoot, ".claude/handoff/latest.md"),
              tokens: handoffTokens,
              sessionId: meta.sourceSession,
              contextTokens: meta.contextTokens,
              created: meta.created,
              distilled: false,
            };
            console.log(JSON.stringify(output));
          } else {
            console.log(
              `snapshot: .claude/handoff/latest.md (~${handoffTokens} tokens)`
            );
            console.log(
              `~${handoffTokens} tokens · session ${meta.sourceSession} · context ${meta.contextTokens} tokens`
            );
          }
        }
      }

      return 0;
    }

    // Distill path
    const profileInfo = resolveActingProfile(opts.profile);
    if (!profileInfo) {
      if (opts.profile) {
        console.error(`lodestone handoff: profile not found: ${opts.profile}`);
      } else {
        console.error(
          `lodestone handoff: no profiles registered — run: lodestone profile add <name>`
        );
      }
      return 1;
    }

    const projectRoot = findProjectRoot(process.cwd());
    const handoffData = loadLatestHandoff(projectRoot);
    if (!handoffData) {
      console.error("lodestone handoff: failed to load handoff file");
      return 1;
    }

    const meta = handoffData.meta;
    const sourceSessionId = meta.sourceSession;

    // Locate the source session file to check its mtime for cold-cache guard
    const sessionPath = sessionId
      ? findSessionById(profileInfo.configDir, process.cwd(), sessionId)
      : latestSession(profileInfo.configDir, process.cwd());

    let idleMinutes = 0;
    if (sessionPath) {
      try {
        const stat = statSync(sessionPath);
        const lastMtimeMs = stat.mtime.getTime();
        const nowMs = Date.now();
        idleMinutes = Math.round((nowMs - lastMtimeMs) / (1000 * 60));
      } catch {
        // If we can't stat the file, proceed without the guard
      }
    }
    const maxIdleMinutes = 55;

    if (idleMinutes > maxIdleMinutes && !force) {
      const msg =
        `distill refused: session idle ${idleMinutes} min — the 1h server cache has likely expired, ` +
        `so distilling now would re-send ~${meta.contextTokens} tokens at full price. ` +
        `Re-run with --force to do it anyway, or use the deterministic snapshot (already written).`;
      if (opts.json) {
        console.log(
          JSON.stringify({
            error: "cold_cache",
            message: msg,
            idleMinutes,
          })
        );
      } else {
        console.log(msg);
      }
      return 1;
    }

    // Proceed with distillation
    const distillTemplate = `Rewrite the following six sections (≤2000 tokens total) based on what's been discussed since the last checkpoint:

1. **Goal** (what the user is ultimately trying to accomplish)
2. **State of work** (current status of the main task, recent progress)
3. **Key decisions & constraints** (important decisions made or architectural notes)
4. **Files in play** (key files being worked on and their roles)
5. **Last exchange** (what was just discussed, conclusions)
6. **Next steps** (what should happen next)

Output ONLY the rewritten sections in this format:

## Goal
[rewritten goal]

## State of work
[rewritten state]

## Key decisions & constraints
[rewritten decisions]

## Files in play
[rewritten files]

## Last exchange
[rewritten exchange]

## Next steps
[rewritten next steps]`;

    if (!quiet && !opts.json) {
      const estimatedCost = Math.round(meta.contextTokens * 0.1);
      console.log(
        `distilling on profile ${profileInfo.name} (est. ~${estimatedCost} weighted tokens — cache reads are cheap)…`
      );
    }

    const distilledResult = distill(profileInfo, sourceSessionId, distillTemplate, {
      cwd: process.cwd(),
    });

    if (!distilledResult) {
      // Distillation failed, but handoff already exists; treat as success
      if (!quiet && !opts.json) {
        console.log(
          "distillation failed, but deterministic handoff preserved at .claude/handoff/latest.md"
        );
      }
      return 0;
    }

    // Merge distilled content: replace narrative sections, keep deterministic sections
    const originalMarkdown = handoffData.markdown;

    // Simple merge: extract distilled sections and replace in original
    const distilledMarkdown = replaceNarrativeSections(
      originalMarkdown,
      distilledResult
    );

    // Update meta to mark as distilled
    const updatedMeta = { ...meta, distilled: true };

    // Save updated handoff
    saveHandoff(projectRoot, distilledMarkdown, updatedMeta);

    const handoffTokens = estimateTokens(distilledMarkdown);

    if (!quiet) {
      if (opts.json) {
        const output: HandoffOutput = {
          path: join(projectRoot, ".claude/handoff/latest.md"),
          tokens: handoffTokens,
          sessionId: sourceSessionId,
          contextTokens: meta.contextTokens,
          created: meta.created,
          distilled: true,
        };
        console.log(JSON.stringify(output));
      } else {
        console.log(
          `distilled: .claude/handoff/latest.md (~${handoffTokens} tokens)`
        );
      }
    }

    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`lodestone handoff: ${msg}`);
    return 1;
  }
}

/**
 * Find a session by ID in a config directory, within the current project.
 */
function findSessionById(
  configDir: string,
  cwd: string,
  sessionId: string
): string | undefined {
  const { mungeCwd, projectsDirFor } = require("../core/paths.js");
  const { readdirSync, existsSync } = require("node:fs");
  const { join } = require("node:path");

  const munged = mungeCwd(cwd);
  const projectsDir = projectsDirFor(configDir);
  const projectDir = join(projectsDir, munged);

  if (!existsSync(projectDir)) {
    return undefined;
  }

  const files = readdirSync(projectDir);

  for (const file of files) {
    if (file === `${sessionId}.jsonl`) {
      return join(projectDir, file);
    }
  }

  return undefined;
}

/**
 * Replace narrative sections in original markdown with distilled versions.
 * Keeps frontmatter and "Files in play" section deterministic.
 */
function replaceNarrativeSections(
  originalMarkdown: string,
  distilledSections: string
): string {
  // Extract frontmatter
  const frontmatterMatch = originalMarkdown.match(/^---\n([\s\S]*?)\n---\n/);
  const frontmatter = frontmatterMatch ? frontmatterMatch[0] : "";

  // Extract the Files in play section from original
  const filesMatch = originalMarkdown.match(
    /## Files in play\n([\s\S]*?)(?=\n## |$)/
  );
  const filesSection = filesMatch ? `## Files in play\n${filesMatch[1]}\n` : "";

  // Combine: frontmatter + distilled sections + files section
  const combined = frontmatter + "\n" + distilledSections + "\n" + filesSection;

  return combined;
}
