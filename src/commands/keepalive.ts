import { parseArgs } from "node:util";
import { stderr } from "node:process";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { expandTilde, findProjectRoot } from "../core/paths.js";
import {
  latestSession,
  latestContextTokens,
  parseSession,
} from "../core/transcript.js";
import { loadConfig } from "../core/config.js";
import { resolveActingProfile, adoptDefault } from "../core/profiles.js";
import { versionOf } from "../core/claudeCli.js";
import {
  keepalivePidfilePath,
  computePingSchedule,
  readKeepaliveState,
  writeKeepaliveState,
  spawnKeepaliveScheduler,
  killKeepaliveScheduler,
  isFiveHourLimitReached,
} from "../core/keepalive.js";

interface CommandOptions {
  json: boolean;
  profile?: string | undefined;
}

/**
 * cchandoff keepalive — manage session TTL refresh pings
 *
 * keepalive <profile> [--for 90m] [--max-pings 3]
 * keepalive --stop [<profile>]
 * keepalive --status
 */
export async function keepalive(
  args: string[],
  opts: CommandOptions
): Promise<number> {
  try {
    const { values: parsedOpts, positionals } = parseArgs({
      args,
      options: {
        for: { type: "string" },
        "max-pings": { type: "string", default: "3" },
        stop: { type: "boolean", default: false },
        status: { type: "boolean", default: false },
      },
      allowPositionals: true,
      strict: true,
    });

    adoptDefault();
    const config = loadConfig();
    const homeDir = process.env.HOME || "";
    if (!homeDir) {
      throw new Error("HOME not set");
    }

    const claudeVersion = await versionOf();

    // Handle --status
    if ((parsedOpts.status as boolean) ?? false) {
      return handleStatus(homeDir, config);
    }

    // Handle --stop
    if ((parsedOpts.stop as boolean) ?? false) {
      const targetProfile = positionals[0];
      return handleStop(homeDir, config, targetProfile);
    }

    // Handle start keepalive
    const targetProfile = positionals[0];
    if (!targetProfile) {
      throw new Error("keepalive requires a profile name or --stop");
    }

    if (!config.profiles[targetProfile]) {
      throw new Error(`Profile not found: ${targetProfile}`);
    }

    const durationStr = (parsedOpts.for as string) || "90m";
    const maxPings = parseInt((parsedOpts["max-pings"] as string) || "3", 10);

    const durationMs = parseDuration(durationStr);
    if (durationMs <= 0) {
      throw new Error(`Invalid duration: ${durationStr}`);
    }

    return await handleStart(
      homeDir,
      config,
      targetProfile,
      durationMs,
      maxPings,
      claudeVersion
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);
    stderr.write(`cchandoff keepalive: ${message}\n`);
    return 1;
  }
}

async function handleStart(
  homeDir: string,
  config: any,
  profile: string,
  durationMs: number,
  maxPings: number,
  claudeVersion: string | undefined
): Promise<number> {
  // Find the newest session for the current project
  const cwd = process.cwd();
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) {
    throw new Error("Not in a Claude Code project directory");
  }

  const profileCfg = config.profiles[profile] as Record<string, unknown>;
  if (!profileCfg) {
    throw new Error(`Profile not found: ${profile}`);
  }

  const configDir = expandTilde(profileCfg.configDir as string);

  // Pass cwd to latestSession (it will munge it to find the project directory)
  const sessionPath = latestSession(configDir, cwd);
  if (!sessionPath) {
    throw new Error(
      `No session found in project for profile: ${profile}`
    );
  }

  const parsed = await parseSession(sessionPath);
  const sessionId = parsed.meta.sessionId;
  if (!sessionId) {
    throw new Error("No session ID in parsed session");
  }

  const contextTokens = latestContextTokens(parsed);

  if (contextTokens === 0) {
    throw new Error("Cannot keep alive: no context tokens recorded");
  }

  // Check if 5h window is already ≥80%
  const limitReached = await isFiveHourLimitReached(
    configDir,
    claudeVersion,
    80
  );
  if (limitReached) {
    console.log(
      `Keepalive skipped: ${profile}'s 5-hour window is ≥80% (guardrail)`
    );
    return 0;
  }

  // Compute schedule
  const schedule = computePingSchedule(contextTokens, durationMs, maxPings);

  console.log(`Keepalive plan for ${profile}:`);
  console.log(`  Duration: ${formatDuration(durationMs)}`);
  console.log(`  Session: ${sessionId.substring(0, 8)}…`);
  console.log(
    `  Context tokens: ${contextTokens} · Pings scheduled: ${schedule.totalPingsToSchedule}`
  );
  console.log(
    `  Cost per ping: ~${schedule.estimatedCostPerPing} tokens (~0.1× context)`
  );
  console.log(
    `  Break-even: ping ~${schedule.estimatedCostPerPing} vs cold return ~${contextTokens * 2}; worth it if return > ${schedule.breakEvenPct}% likely`
  );
  console.log(`  Interval: every ${formatDuration(schedule.pingIntervalMs)}`);

  // Spawn scheduler
  const pid = spawnKeepaliveScheduler(
    profile,
    sessionId,
    contextTokens,
    durationMs,
    maxPings,
    schedule
  );

  // Write state file
  const state: {
    pid?: number;
    profile: string;
    sessionId: string;
    pings: Array<{
      timestamp: number;
      exitCode: number;
    }>;
    cap: number;
    until: number;
    created: number;
  } = {
    pid,
    profile,
    sessionId,
    pings: [],
    cap: maxPings,
    until: Date.now() + durationMs,
    created: Date.now(),
  };

  writeKeepaliveState(homeDir, profile, state);

  console.log(`Keepalive started (pid ${pid})`);
  return 0;
}

function handleStop(
  homeDir: string,
  config: any,
  targetProfile?: string
): number {
  if (targetProfile) {
    // Stop a specific profile
    const { killed, pid } = killKeepaliveScheduler(homeDir, targetProfile);
    if (killed) {
      console.log(`Stopped keepalive for ${targetProfile} (was pid ${pid})`);
    } else {
      console.log(`No active keepalive for ${targetProfile}`);
    }
    return 0;
  }

  // Stop all
  let count = 0;
  for (const profileName of Object.keys(config.profiles)) {
    const { killed } = killKeepaliveScheduler(homeDir, profileName);
    if (killed) {
      count++;
    }
  }

  if (count > 0) {
    console.log(`Stopped ${count} keepalive scheduler(s)`);
  } else {
    console.log("No active keepalive schedulers");
  }
  return 0;
}

function handleStatus(homeDir: string, _config: any): number {
  const keepaliveDir = join(homeDir, ".config", "cchandoff");
  if (!existsSync(keepaliveDir)) {
    console.log("No active keepalive schedulers");
    return 0;
  }

  const files = readdirSync(keepaliveDir);
  const keepaliveFiles = files.filter(
    (f) => f.startsWith("keepalive-") && f.endsWith(".json")
  );

  if (keepaliveFiles.length === 0) {
    console.log("No active keepalive schedulers");
    return 0;
  }

  let found = false;
  for (const file of keepaliveFiles) {
    const profileName = file.replace("keepalive-", "").replace(".json", "");
    const state = readKeepaliveState(homeDir, profileName);
    if (state) {
      found = true;
      console.log(
        `${state.profile}: ${state.pings.length}/${state.cap} pings (until ${new Date(state.until).toISOString()})`
      );
    }
  }

  if (!found) {
    console.log("No active keepalive schedulers");
  }
  return 0;
}

function parseDuration(str: string): number {
  const match = str.match(/^(\d+)([smhd])$/);
  if (!match || !match[1] || !match[2]) {
    return -1;
  }

  const num = parseInt(match[1], 10);
  const unit = match[2];

  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return num * (multipliers[unit] || -1);
}

function formatDuration(ms: number): string {
  if (ms < 60 * 1000) {
    return `${Math.round(ms / 1000)}s`;
  }
  if (ms < 60 * 60 * 1000) {
    return `${Math.round(ms / (60 * 1000))}m`;
  }
  if (ms < 24 * 60 * 60 * 1000) {
    return `${Math.round(ms / (60 * 60 * 1000))}h`;
  }
  return `${Math.round(ms / (24 * 60 * 60 * 1000))}d`;
}
