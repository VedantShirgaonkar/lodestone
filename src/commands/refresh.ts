import { parseArgs } from "node:util";
import { stderr } from "node:process";
import { basename } from "node:path";
import { findProjectRoot, mungeCwd } from "../core/paths.js";
import { saveHandoff } from "../core/handoffFile.js";
import { resolveActingProfile, adoptDefault } from "../core/profiles.js";
import { latestSession, parseSession, latestContextTokens } from "../core/transcript.js";
import { extractSnapshot, captureGitInfo } from "../core/extract.js";
import { composeHandoff } from "../core/composeHandoff.js";
import { handoff } from "./handoff.js";

interface CommandOptions {
  json: boolean;
  profile?: string;
}

/**
 * lodestone refresh — ensure a fresh handoff for /clear-based carry
 *
 * refresh [--distill]
 *
 * Composes a handoff from the current session and saves it, then instructs
 * the user to clear and re-attach for a fresh-context carry.
 */
export async function refresh(args: string[], opts: CommandOptions): Promise<number> {
  try {
    const { values: parsedOpts } = parseArgs({
      args,
      options: {
        distill: { type: "boolean", default: false },
      },
      allowPositionals: false,
      strict: true,
    });

    const distill = (parsedOpts.distill as boolean) ?? false;

    adoptDefault();
    const cwd = process.cwd();
    const projectRoot = findProjectRoot(cwd);
    const profile = resolveActingProfile();

    if (!profile) {
      throw new Error("No active profile found. Set CLAUDE_CONFIG_DIR or run: lodestone profile add");
    }

    // --distill delegates to the one real distillation path. This command used
    // to accept the flag, skip the distillation entirely, and stamp
    // `distilled: true` into the metadata anyway — false provenance that audit
    // and the panels would then repeat as fact. handoff --distill snapshots,
    // prints the cost estimate before spending (ADR-003), applies the
    // cold-cache refusal, and marks the meta only when it actually distilled.
    if (distill) {
      const result = await handoff(["--distill"], opts);
      if (result !== 0) {
        return result;
      }
      console.log("Handoff saved. Next steps:");
      console.log("1. In Claude Code, type: /clear");
      console.log("2. The handoff will load automatically in your fresh session");
      return 0;
    }

    // Find the latest session
    const sessionPath = latestSession(profile.configDir, cwd);
    if (!sessionPath) {
      throw new Error(
        "No session found for current project. You must be in an active Claude Code session."
      );
    }

    // Parse the session
    const parsed = await parseSession(sessionPath);

    // Get git info
    const gitInfo = captureGitInfo(cwd);

    // Extract snapshot
    const extracted = extractSnapshot(parsed, { gitInfo });

    // Compute project name from cwd (munged format)
    const project = mungeCwd(projectRoot);

    // Compose handoff. distilled is a fact about how this markdown was made,
    // and this path never distills.
    const composed = composeHandoff(extracted, {
      sourceProfile: profile.name,
      sourceSession: parsed.meta.sessionId || "unknown",
      project,
      branch: gitInfo.branch,
      contextTokens: latestContextTokens(parsed),
      distilled: false,
    });

    // Save handoff
    saveHandoff(projectRoot, composed.markdown, composed.meta);

    // Output instructions
    console.log("Handoff saved. Next steps:");
    console.log("1. In Claude Code, type: /clear");
    console.log("2. The handoff will load automatically in your fresh session");

    if (opts.json) {
      console.log(
        JSON.stringify({
          saved: true,
          handoffPath: `${projectRoot}/.claude/handoff/latest.md`,
          contextTokens: composed.meta.contextTokens,
        })
      );
    }

    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`lodestone refresh: ${message}\n`);
    return 1;
  }
}
