import { parseArgs } from "node:util";
import { join } from "node:path";
import { resolveActingProfile } from "../core/profiles.js";
import { loadConfig } from "../core/config.js";
import { findProjectRoot } from "../core/paths.js";
import { handoff } from "./handoff.js";
import { launchInteractive } from "../core/claudeCli.js";
import { loadLatestHandoff, estimateTokens } from "../core/handoffFile.js";
import { switchTax } from "../core/usage.js";
import { latestSession } from "../core/transcript.js";

interface CommandOptions {
  json: boolean;
  profile?: string | undefined;
}

interface SwitchOutput {
  from: string;
  to: string;
  handoffPath: string;
  handoffTokens: number;
  contextTokens: number;
  naive: number;
  handoff: number;
  launched: boolean;
}

export async function switchCmd(
  args: string[],
  opts: CommandOptions
): Promise<number> {
  try {
    const { values: parsedOpts, positionals } = parseArgs({
      args,
      options: {
        distill: { type: "boolean" },
        force: { type: "boolean" },
        stay: { type: "boolean" },
      },
      allowPositionals: true,
      strict: true,
    });

    const doDistill = (parsedOpts.distill as boolean) ?? false;
    const force = (parsedOpts.force as boolean) ?? false;
    const stay = (parsedOpts.stay as boolean) ?? false;
    const targetProfileName = positionals[0] as string | undefined;

    if (!targetProfileName) {
      console.error("cchandoff switch: missing target profile name");
      return 2;
    }

    // Resolve current and target profiles
    const currentProfileInfo = resolveActingProfile(opts.profile);
    if (!currentProfileInfo) {
      if (opts.profile) {
        console.error(`cchandoff switch: profile not found: ${opts.profile}`);
      } else {
        console.error(
          `cchandoff switch: no profiles registered — run: cchandoff profile add <name>`
        );
      }
      return 1;
    }

    // Validate target profile exists
    const config = loadConfig();
    const targetProfileCfg = config.profiles[targetProfileName];
    if (!targetProfileCfg) {
      console.error(
        `cchandoff switch: profile not found: ${targetProfileName}`
      );
      return 1;
    }

    // Check that target differs from current
    if (currentProfileInfo.name === targetProfileName) {
      console.error(
        `cchandoff switch: target profile is the same as current (${targetProfileName})`
      );
      return 1;
    }

    const projectRoot = findProjectRoot(process.cwd());

    // Check if there's a session to handoff from
    const sessionPath = latestSession(currentProfileInfo.configDir, process.cwd());
    if (!sessionPath) {
      // No session; print message and launch target (unless --stay)
      if (!opts.json) {
        console.log(
          `nothing to hand off (no session for this project on ${currentProfileInfo.name})`
        );
      }

      if (!stay) {
        const targetProfile = {
          name: targetProfileName,
          configDir: targetProfileCfg.configDir,
          label: targetProfileCfg.label,
        };
        const exitCode = launchInteractive(targetProfile, [], {
          cwd: process.cwd(),
        });
        return exitCode;
      }
      return 0;
    }

    // Run handoff (snapshot ± distill)
    const handoffArgs: string[] = [];
    if (doDistill) {
      handoffArgs.push("--distill");
      if (force) {
        handoffArgs.push("--force");
      }
    }
    handoffArgs.push("--quiet");

    const handoffResult = await handoff(handoffArgs, opts);
    if (handoffResult !== 0) {
      // Handoff failed; return that code
      return handoffResult;
    }

    // Load the handoff file to compute switch tax
    const handoffData = loadLatestHandoff(projectRoot);
    let handoffTokens = 0;
    let contextTokens = 0;

    if (handoffData) {
      handoffTokens = estimateTokens(handoffData.markdown);
      contextTokens = handoffData.meta.contextTokens;
    }

    // Compute switch tax
    const tax = switchTax(contextTokens, handoffTokens);

    // Print results
    const handoffPath = join(projectRoot, ".claude/handoff/latest.md");
    if (!opts.json) {
      console.log(
        `handoff ready: .claude/handoff/latest.md (~${handoffTokens} tokens)`
      );
      console.log();
      console.log(
        `switching ${currentProfileInfo.name} → ${targetProfileName} in ${projectRoot}`
      );
      if (tax.naive > 0) {
        console.log(
          `  replaying the conversation there would cost  ≈ ${tax.naive.toLocaleString()} weighted tokens`
        );
        console.log(
          `  starting fresh with this handoff costs       ≈ ${tax.handoff.toLocaleString()} weighted tokens  (${Math.round(((tax.naive - tax.handoff) / tax.naive) * 100)}% less)`
        );
        console.log(
          "(estimates; cache writes are billed 2× — see docs/explainer)"
        );
      }
    }

    // If --stay, stop here
    if (stay) {
      if (!opts.json) {
        console.log();
        console.log(
          "tip: paste .claude/handoff/latest.md into the new session, or run cchandoff init (Phase 3) for automatic injection"
        );
      }

      if (opts.json) {
        const output: SwitchOutput = {
          from: currentProfileInfo.name,
          to: targetProfileName,
          handoffPath,
          handoffTokens,
          contextTokens,
          naive: tax.naive,
          handoff: tax.handoff,
          launched: false,
        };
        console.log(JSON.stringify(output));
      }

      return 0;
    }

    // Otherwise, launch the target profile
    const targetProfile = {
      name: targetProfileName,
      configDir: targetProfileCfg.configDir,
      label: targetProfileCfg.label,
    };

    if (opts.json) {
      const output: SwitchOutput = {
        from: currentProfileInfo.name,
        to: targetProfileName,
        handoffPath,
        handoffTokens,
        contextTokens,
        naive: tax.naive,
        handoff: tax.handoff,
        launched: true,
      };
      console.log(JSON.stringify(output));
    }

    const exitCode = launchInteractive(targetProfile, [], {
      cwd: process.cwd(),
    });

    return exitCode;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`cchandoff switch: ${msg}`);
    return 1;
  }
}
