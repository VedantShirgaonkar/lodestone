import { join } from "node:path";
import { parseArgs } from "node:util";
import { latestSession, parseSession, findSessionById } from "../core/transcript.js";
import { resolveActingProfile } from "../core/profiles.js";
import { findProjectRoot, mungeCwd } from "../core/paths.js";
import { captureGitInfo, extractSnapshot } from "../core/extract.js";
import { saveHandoff } from "../core/handoffFile.js";
import { composeHandoff } from "../core/composeHandoff.js";

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
  quality?: number;
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
        console.error(`lodestone snapshot: profile not found: ${opts.profile}`);
      } else {
        console.error(
          `lodestone snapshot: no profiles registered — run: lodestone profile add <name>`
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
          `lodestone snapshot: no session found for this project on profile ${profileInfo.name}`
        );
        return 1;
      }
    } else {
      sessionPath = latestSession(configDir, process.cwd());
      if (!sessionPath) {
        console.error(
          `lodestone snapshot: no session found for this project on profile ${profileInfo.name}`
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

    // The munged project name, the same thing every other writer stores. This
    // field used to be given the git branch, which is not a project and is
    // already recorded in `branch` two lines below.
    const projectMeta = mungeCwd(projectRoot);
    // The real session id, never the slug. `sourceSession` is a resume target:
    // `handoff --distill` hands it to `claude --resume`, and a friendly slug
    // like "declarative-dancing-cat" resumes nothing.
    const sourceSessionId = parsed.meta.sessionId || sessionId || "unknown";

    // Compose the handoff (unified render + quality score)
    const composed = composeHandoff(extracted, {
      sourceProfile: profileInfo.name,
      sourceSession: sourceSessionId,
      project: projectMeta,
      branch: extracted.gitInfo.branch,
      contextTokens: extracted.metrics.contextTokens,
      distilled: false,
      created: new Date().toISOString(),
    });

    const { markdown, meta, tokens: handoffTokens, quality } = composed;

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
        const output: SnapshotOutput & { quality: number } = {
          path: outPath || join(projectRoot, ".claude/handoff/latest.md"),
          tokens: handoffTokens,
          sessionId: sourceSessionId,
          contextTokens: extracted.metrics.contextTokens,
          created: meta.created,
          quality,
        };
        console.log(JSON.stringify(output));
      } else {
        const displayPath = outPath
          ? outPath
          : `.claude/handoff/latest.md (~${handoffTokens} tokens)`;
        console.log(`snapshot: ${displayPath}`);
        console.log(
          `~${handoffTokens} tokens · session ${sourceSessionId} · context ${extracted.metrics.contextTokens} tokens`
        );
        console.log(`handoff quality: ${quality}/5`);
        if (quality <= 2) {
          console.log(`thin handoff — run /handoff in-session or use --distill for a better one`);
        }
      }
    }

    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`lodestone snapshot: ${msg}`);
    return 1;
  }
}

