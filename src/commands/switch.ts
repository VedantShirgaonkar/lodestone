import { parseArgs } from "node:util";
import { join } from "node:path";
import { resolveActingProfile } from "../core/profiles.js";
import { loadConfig } from "../core/config.js";
import { findProjectRoot } from "../core/paths.js";
import { handoff } from "./handoff.js";
import { keepalive } from "./keepalive.js";
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
        "keep-warm": { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });

    const doDistill = (parsedOpts.distill as boolean) ?? false;
    const force = (parsedOpts.force as boolean) ?? false;
    const stay = (parsedOpts.stay as boolean) ?? false;
    const keepWarm = (parsedOpts["keep-warm"] as string) ?? undefined;
    const targetProfileName = positionals[0] as string | undefined;

    if (!targetProfileName) {
      console.error("lodestone switch: missing target profile name");
      return 2;
    }

    // Resolve current and target profiles
    const currentProfileInfo = resolveActingProfile(opts.profile);
    if (!currentProfileInfo) {
      if (opts.profile) {
        console.error(`lodestone switch: profile not found: ${opts.profile}`);
      } else {
        console.error(
          `lodestone switch: no profiles registered — run: lodestone profile add <name>`
        );
      }
      return 1;
    }

    // Validate target profile exists
    const config = loadConfig();
    const targetProfileCfg = config.profiles[targetProfileName];
    if (!targetProfileCfg) {
      console.error(
        `lodestone switch: profile not found: ${targetProfileName}`
      );
      return 1;
    }

    // Check that target differs from current
    if (currentProfileInfo.name === targetProfileName) {
      console.error(
        `lodestone switch: target profile is the same as current (${targetProfileName})`
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

    // Run handoff (snapshot ± distill).
    //
    // --quiet only on the free path. Distilling spends real tokens, and the
    // cost estimate handoff prints before it spends is the ADR-003 contract;
    // passing --quiet here was silencing exactly that line.
    const handoffArgs: string[] = [];
    if (doDistill) {
      handoffArgs.push("--distill");
      if (force) {
        handoffArgs.push("--force");
      }
    }
    // In --json mode, quiet regardless: switch emits the one JSON document,
    // and a second one from handoff would corrupt the stream.
    if (!doDistill || opts.json) {
      handoffArgs.push("--quiet");
    }

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

    // --keep-warm <duration>: schedule cache pings on the account being LEFT,
    // so coming back to it within the duration is a cache read, not a rebuild.
    // This flag was documented in the README's feature table long before the
    // command accepted it. Delegating to `keepalive` gets its plan output (the
    // per-ping cost, the break-even) and its 80% guardrail for free. A failure
    // here stops the switch: launching Claude over the top of it would bury
    // the one line telling the user their keep-warm never started.
    if (keepWarm) {
      const keepaliveResult = await keepalive(
        [currentProfileInfo.name, "--for", keepWarm],
        { json: false }
      );
      if (keepaliveResult !== 0) {
        console.error(
          `lodestone switch: --keep-warm failed; not launching ${targetProfileName}. ` +
            `Fix the keepalive error above, or run \`lodestone switch ${targetProfileName}\` without it.`
        );
        return keepaliveResult;
      }
    }

    // If --stay, stop here
    if (stay) {
      if (!opts.json) {
        console.log();
        console.log(
          "tip: run `lodestone init` once and the new session picks this up automatically"
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
    console.error(`lodestone switch: ${msg}`);
    return 1;
  }
}
