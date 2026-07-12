import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { expandTilde, findProjectRoot } from "./paths.js";
import { latestSession, latestContextTokens } from "./transcript.js";
import { loadConfig } from "./config.js";
import { getQuota } from "./realUsage.js";
import { weightedBurn } from "./usage.js";

export interface KeepaliveState {
  pid?: number;
  profile: string;
  sessionId: string;
  pings: Array<{
    timestamp: number;
    exitCode: number;
  }>;
  cap: number;
  until: number; // Unix ms timestamp
  created: number;
}

/**
 * Get keepalive pidfile path for a profile
 */
export function keepalivePidfilePath(homeDir: string, profile: string): string {
  return join(homeDir, ".config", "warmswap", `keepalive-${profile}.json`);
}

/**
 * Compute ping schedule for keepalive
 * Returns: { pingIntervalMs, totalPingsToSchedule, estimatedCostPerPing }
 */
export function computePingSchedule(
  contextTokens: number,
  durationMs: number,
  maxPings: number
): {
  pingIntervalMs: number;
  totalPingsToSchedule: number;
  estimatedCostPerPing: number;
  breakEvenPct: number;
} {
  // Ping interval: 52 minutes by default, overridable via env
  const pingIntervalMs =
    parseInt(process.env.WARMSWAP_KEEPALIVE_INTERVAL_MS || "", 10) ||
    52 * 60 * 1000;

  // How many pings fit in the duration?
  const totalPingsToSchedule = Math.min(
    Math.floor(durationMs / pingIntervalMs),
    maxPings
  );

  // Cost per ping: ~0.1x context tokens (weighted)
  // Weighted formula: input=1, cache_creation=2, cache_read=0.1, output=5
  // A ping is mostly cache_read (we're resuming an existing session)
  // Estimate: ~0.1 * contextTokens for a warm cache hit
  const estimatedCostPerPing = Math.round(contextTokens * 0.1);

  // Break-even: cold return costs ~2x, so a ping is worth it if return is >5% likely
  const breakEvenPct = Math.round((estimatedCostPerPing * 100) / (contextTokens * 2));

  return {
    pingIntervalMs,
    totalPingsToSchedule,
    estimatedCostPerPing,
    breakEvenPct,
  };
}

/**
 * Read active keepalive state for a profile
 */
export function readKeepaliveState(
  homeDir: string,
  profile: string
): KeepaliveState | null {
  const pidfile = keepalivePidfilePath(homeDir, profile);
  if (!existsSync(pidfile)) {
    return null;
  }

  try {
    const data = JSON.parse(readFileSync(pidfile, "utf8")) as KeepaliveState;
    return data;
  } catch {
    return null;
  }
}

/**
 * Write keepalive state file
 */
export function writeKeepaliveState(
  homeDir: string,
  profile: string,
  state: KeepaliveState
): void {
  const pidfile = keepalivePidfilePath(homeDir, profile);
  const dir = dirname(pidfile);

  mkdirSync(dir, { recursive: true });
  writeFileSync(pidfile, JSON.stringify(state, null, 2), "utf8");
}

/**
 * Spawn detached keepalive scheduler child process
 */
export function spawnKeepaliveScheduler(
  profile: string,
  sessionId: string,
  contextTokens: number,
  durationMs: number,
  maxPings: number,
  schedule: ReturnType<typeof computePingSchedule>
): number {
  // Spawn a detached child that runs the scheduler
  // The child will manage pings and state file updates
  const nodeArgs = [join(import.meta.url.replace("file://", ""), "..", "..", "keepalive-scheduler.js")];

  const env = {
    ...process.env,
    WARMSWAP_KEEPALIVE_PROFILE: profile,
    WARMSWAP_KEEPALIVE_SESSION_ID: sessionId,
    WARMSWAP_KEEPALIVE_CONTEXT_TOKENS: String(contextTokens),
    WARMSWAP_KEEPALIVE_DURATION_MS: String(durationMs),
    WARMSWAP_KEEPALIVE_MAX_PINGS: String(maxPings),
    WARMSWAP_KEEPALIVE_INTERVAL_MS: String(schedule.pingIntervalMs),
  };

  const child = spawn(process.execPath, nodeArgs, {
    detached: true,
    stdio: "ignore",
    env,
  });

  const pid = child.pid;
  child.unref();

  return pid ?? -1;
}

/**
 * Kill a running keepalive scheduler by profile
 */
export function killKeepaliveScheduler(
  homeDir: string,
  profile: string
): { killed: boolean; pid?: number } {
  const state = readKeepaliveState(homeDir, profile);
  if (!state || !state.pid) {
    return { killed: false };
  }

  const pid = state.pid;
  try {
    process.kill(pid, "SIGTERM");
    // Also remove the pidfile
    const pidfile = keepalivePidfilePath(homeDir, profile);
    if (existsSync(pidfile)) {
      require("node:fs").unlinkSync(pidfile);
    }
    return { killed: true, pid };
  } catch {
    return { killed: false, pid };
  }
}

/**
 * Check if a profile's 5h window exceeds threshold (80% by default)
 */
export async function isFiveHourLimitReached(
  configDir: string,
  claudeVersion: string | undefined,
  threshold: number = 80
): Promise<boolean> {
  try {
    const quota = await getQuota(configDir, claudeVersion, false);
    const utilization = quota.fiveHourUtilization ?? 0;
    return utilization >= threshold;
  } catch {
    return false;
  }
}
