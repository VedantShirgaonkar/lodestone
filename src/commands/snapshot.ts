import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { latestSession, parseSession } from "../core/transcript.js";
import { resolveActingProfile } from "../core/profiles.js";
import { findProjectRoot, mungeCwd, projectsDirFor } from "../core/paths.js";
import { captureGitInfo, extractSnapshot } from "../core/extract.js";
import { renderHandoff, saveHandoff, estimateTokens } from "../core/handoffFile.js";

interface CommandOptions {
  json: boolean;
  profile?: string | undefined;
}

interface SnapshotOutput {
  path: string;
  tokens: number;
  sessionId: string;
  contextTokens: number;
  created: string;
}

export async function snapshot(
  args: string[],
  opts: CommandOptions
): Promise<number> {
  try {
    const { values: parsedOpts } = parseArgs({
      args,
      options: {
        session: { type: "string" },
        out: { type: "string" },
        quiet: { type: "boolean" },
      },
      allowPositionals: false,
      strict: true,
    });

    const sessionId = (parsedOpts.session as string) ?? undefined;
    const outPath = (parsedOpts.out as string) ?? undefined;
    const quiet = (parsedOpts.quiet as boolean) ?? false;

    // Resolve the profile
    const profileInfo = resolveActingProfile(opts.profile);
    if (!profileInfo) {
      if (opts.profile) {
        console.error(`cchandoff snapshot: profile not found: ${opts.profile}`);
      } else {
        console.error(
          `cchandoff snapshot: no profiles registered — run: cchandoff profile add <name>`
        );
      }
      return 1;
    }

    const configDir = profileInfo.configDir;
    const projectRoot = findProjectRoot(process.cwd());

    // Find the session
    let sessionPath: string | undefined;
    if (sessionId) {
      // Explicit session ID: locate it
      sessionPath = findSessionById(configDir, process.cwd(), sessionId);
      if (!sessionPath) {
        console.error(
          `cchandoff snapshot: no session found for this project on profile ${profileInfo.name}`
        );
        return 1;
      }
    } else {
      sessionPath = latestSession(configDir, process.cwd());
      if (!sessionPath) {
        console.error(
          `cchandoff snapshot: no session found for this project on profile ${profileInfo.name}`
        );
        return 1;
      }
    }

    // Parse the session
    const parsed = await parseSession(sessionPath);

    // Capture git info
    const gitInfo = captureGitInfo(projectRoot);

    // Extract the snapshot
    const extracted = extractSnapshot(parsed, { gitInfo });

    // Determine the project name for meta
    const projectMeta = extracted.gitInfo.branch || "unknown";
    const sourceSessionSlug = parsed.meta.slug || parsed.meta.sessionId || sessionId || "unknown";

    // Render the handoff markdown
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
            extracted.filesRead
              .map((f) => `- ${f} (read)`)
              .join("\n"),
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
      sourceProfile: profileInfo.name,
      sourceSession: sourceSessionSlug,
      project: projectMeta,
      ...(extracted.gitInfo.branch ? { branch: extracted.gitInfo.branch } : {}),
      contextTokens: extracted.metrics.contextTokens,
      distilled: false,
      created: new Date().toISOString(),
    });

    const { markdown, meta } = renderResult;
    const handoffTokens = estimateTokens(markdown);

    // Write the file
    if (outPath) {
      // --out: write only markdown, skip meta and archive
      const fs = await import("node:fs");
      fs.writeFileSync(outPath, markdown, "utf8");
    } else {
      // Standard flow: write to handoff dir with meta and archive
      saveHandoff(projectRoot, markdown, meta);
    }

    // Output results
    if (!quiet) {
      if (opts.json) {
        const output: SnapshotOutput = {
          path: outPath || join(projectRoot, ".claude/handoff/latest.md"),
          tokens: handoffTokens,
          sessionId: sourceSessionSlug,
          contextTokens: extracted.metrics.contextTokens,
          created: meta.created,
        };
        console.log(JSON.stringify(output));
      } else {
        const displayPath = outPath
          ? outPath
          : `.claude/handoff/latest.md (~${handoffTokens} tokens)`;
        console.log(`snapshot: ${displayPath}`);
        console.log(
          `~${handoffTokens} tokens · session ${sourceSessionSlug} · context ${extracted.metrics.contextTokens} tokens`
        );
      }
    }

    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`cchandoff snapshot: ${msg}`);
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
