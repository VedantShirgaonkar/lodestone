import { spawn } from "node:child_process";
import { existsSync, writeFileSync, readFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lodestoneConfigPath } from "./paths.js";
import { loadConfig } from "./config.js";
import { getQuota } from "./realUsage.js";

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
 * Where keepalive state lives: beside the lodestone config. Derived from
 * lodestoneConfigPath() so it honors XDG_CONFIG_HOME and works where HOME does
 * not exist (Windows), instead of hardcoding `$HOME/.config` as it used to.
 */
export function keepaliveStateDir(): string {
  return dirname(lodestoneConfigPath());
}

/**
 * Get keepalive pidfile path for a profile
 */
export function keepalivePidfilePath(profile: string): string {
  return join(keepaliveStateDir(), `keepalive-${profile}.json`);
}

/** Is a recorded scheduler pid actually alive? Signal 0 probes without killing. */
export function pidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else; still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
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
    parseInt(process.env.LODESTONE_KEEPALIVE_INTERVAL_MS || "", 10) ||
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
export function readKeepaliveState(profile: string): KeepaliveState | null {
  const pidfile = keepalivePidfilePath(profile);
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
  profile: string,
  state: KeepaliveState
): void {
  const pidfile = keepalivePidfilePath(profile);
  const dir = dirname(pidfile);

  mkdirSync(dir, { recursive: true });
  writeFileSync(pidfile, JSON.stringify(state, null, 2), "utf8");
}

/**
 * Spawn the detached keepalive scheduler.
 *
 * Throws when the scheduler file is missing rather than spawning into the
 * void. The old version spawned first and asked questions never: the file it
 * pointed at had not been written, the detached child died silently on
 * MODULE_NOT_FOUND, and the command reported "Keepalive started" with a pid
 * that was already dead. A feature must not be able to report success without
 * its own executable existing.
 */
export function spawnKeepaliveScheduler(
  profile: string,
  sessionId: string,
  durationMs: number,
  maxPings: number,
  schedule: ReturnType<typeof computePingSchedule>
): number {
  // Compiled layout: this file is dist/core/keepalive.js, the scheduler is
  // dist/keepalive-scheduler.js. fileURLToPath, never a string-replace on the
  // URL: %20-encoded paths and Windows drive letters both break the naive way.
  const schedulerPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "keepalive-scheduler.js"
  );
  if (!existsSync(schedulerPath)) {
    throw new Error(`keepalive scheduler missing at ${schedulerPath} — reinstall lodestone-cli`);
  }

  const env = {
    ...process.env,
    LODESTONE_KEEPALIVE_PROFILE: profile,
    LODESTONE_KEEPALIVE_SESSION_ID: sessionId,
    LODESTONE_KEEPALIVE_DURATION_MS: String(durationMs),
    LODESTONE_KEEPALIVE_MAX_PINGS: String(maxPings),
    LODESTONE_KEEPALIVE_INTERVAL_MS: String(schedule.pingIntervalMs),
    LODESTONE_KEEPALIVE_STATE_FILE: keepalivePidfilePath(profile),
  };

  const child = spawn(process.execPath, [schedulerPath], {
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
  profile: string
): { killed: boolean; pid?: number } {
  const state = readKeepaliveState(profile);
  if (!state || !state.pid) {
    return { killed: false };
  }

  const pid = state.pid;
  const pidfile = keepalivePidfilePath(profile);

  // A dead scheduler still deserves its pidfile cleaned up, and killing a
  // live one must report killed even if the file removal then fails. The old
  // version called require("node:fs") here — this is an ES module, so the
  // kill landed, the require threw, and the caller was told nothing died.
  const wasAlive = pidAlive(pid);
  if (wasAlive) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // raced with its own exit; treat as already gone
    }
  }
  try {
    if (existsSync(pidfile)) unlinkSync(pidfile);
  } catch {
    // state file is advisory; the kill is what matters
  }

  return wasAlive ? { killed: true, pid } : { killed: false, pid };
}

/**
 * Check if a profile's 5h window exceeds threshold (from config.keepalive.maxWindowPct, default 80)
 */
export async function isFiveHourLimitReached(
  configDir: string,
  claudeVersion: string | undefined,
  overrideThreshold?: number
): Promise<boolean> {
  try {
    const config = loadConfig();
    const threshold = overrideThreshold ?? config.settings.keepalive?.maxWindowPct ?? 80;
    const quota = await getQuota(configDir, claudeVersion, false);
    const utilization = quota.fiveHourUtilization ?? 0;
    return utilization >= threshold;
  } catch {
    return false;
  }
}
