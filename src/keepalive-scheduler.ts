#!/usr/bin/env node
/**
 * lodestone keepalive scheduler — the detached child that actually sends pings.
 *
 * `lodestone keepalive <profile>` spawns this file with its plan in the
 * environment, then returns. From then on this process is the feature: it
 * waits out each interval, re-checks the quota guardrail, resumes the session
 * as a fork with a trivial prompt so Anthropic's cache TTL resets, records the
 * outcome, and exits when the duration ends, the ping cap is reached, the
 * guardrail trips, or it is told to stop.
 *
 * It has to exist. For four releases it did not: the spawn pointed at this
 * filename, no such file had ever been written, the detached child died on
 * MODULE_NOT_FOUND with stdio ignored, and "Keepalive started (pid N)" printed
 * a pid that was already dead. Every layer above it — the CLI plan output, the
 * README row, the extension's "Keep Current Account Warm" action — described
 * a scheduler that was never there.
 *
 * Why a fork-session ping keeps the cache warm: the cache is keyed on the
 * conversation prefix, and a `--resume <id> --fork-session` request re-sends
 * exactly that prefix. The prefix is served as a cache read (~0.1×), the fork
 * means the ping never appends a junk turn to the user's real transcript, and
 * a cache read renews the entry's TTL. That renewal is the entire product of
 * this process.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "./core/config.js";
import { expandTilde } from "./core/paths.js";
import { claudePath, versionOf } from "./core/claudeCli.js";
import { isFiveHourLimitReached, type KeepaliveState } from "./core/keepalive.js";
import { logInfo, logError } from "./util/log.js";

const PING_PROMPT = "Reply with exactly: ok";
const PING_TIMEOUT_MS = 120_000;

interface Plan {
  profile: string;
  sessionId: string;
  durationMs: number;
  maxPings: number;
  intervalMs: number;
  stateFile: string;
}

function planFromEnv(): Plan | undefined {
  const profile = process.env.LODESTONE_KEEPALIVE_PROFILE;
  const sessionId = process.env.LODESTONE_KEEPALIVE_SESSION_ID;
  const durationMs = Number(process.env.LODESTONE_KEEPALIVE_DURATION_MS);
  const maxPings = Number(process.env.LODESTONE_KEEPALIVE_MAX_PINGS);
  const intervalMs = Number(process.env.LODESTONE_KEEPALIVE_INTERVAL_MS);
  const stateFile = process.env.LODESTONE_KEEPALIVE_STATE_FILE;

  if (!profile || !sessionId || !stateFile) return undefined;
  if (!(durationMs > 0) || !(maxPings > 0) || !(intervalMs > 0)) return undefined;

  return { profile, sessionId, durationMs, maxPings, intervalMs, stateFile };
}

/** Append one ping outcome to the state file the parent wrote. */
function recordPing(stateFile: string, exitCode: number): void {
  try {
    if (!existsSync(stateFile)) return;
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as KeepaliveState;
    state.pings.push({ timestamp: Date.now(), exitCode });
    writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    logError(`keepalive-scheduler: could not record ping: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** One cache-refreshing request. Returns the claude exit code. */
function ping(configDir: string, sessionId: string): number {
  const result = spawnSync(
    claudePath(),
    [
      "--resume",
      sessionId,
      "--fork-session",
      "-p",
      PING_PROMPT,
      "--output-format",
      "json",
      "--max-turns",
      "1",
    ],
    {
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      encoding: "utf8",
      timeout: PING_TIMEOUT_MS,
      stdio: "pipe",
    }
  );
  return result.status ?? 1;
}

async function main(): Promise<void> {
  const plan = planFromEnv();
  if (!plan) {
    logError("keepalive-scheduler: launched without a complete plan in the environment");
    process.exit(1);
  }

  const config = loadConfig();
  const profileCfg = config.profiles[plan.profile];
  if (!profileCfg) {
    logError(`keepalive-scheduler: profile disappeared: ${plan.profile}`);
    process.exit(1);
  }
  const configDir = expandTilde(profileCfg.configDir);
  const until = Date.now() + plan.durationMs;

  let stopped = false;
  process.on("SIGTERM", () => {
    stopped = true;
  });
  process.on("SIGINT", () => {
    stopped = true;
  });

  const every =
    plan.intervalMs >= 60_000
      ? `${Math.round(plan.intervalMs / 60000)}m`
      : `${Math.round(plan.intervalMs / 1000)}s`;
  logInfo(
    `keepalive-scheduler: ${plan.profile}/${plan.sessionId.slice(0, 8)} — up to ${plan.maxPings} ping(s), every ${every}, until ${new Date(until).toISOString()}`
  );

  const claudeVersion = versionOf();

  for (let i = 0; i < plan.maxPings; i++) {
    await sleep(plan.intervalMs);

    if (stopped) {
      logInfo("keepalive-scheduler: stopped by request");
      return;
    }
    if (Date.now() > until) {
      logInfo("keepalive-scheduler: duration elapsed, exiting");
      return;
    }

    // The guardrail is re-checked before every ping, not only at start:
    // a keepalive that pings a window already near its limit would spend the
    // very budget it exists to protect.
    if (await isFiveHourLimitReached(configDir, claudeVersion)) {
      logInfo("keepalive-scheduler: 5h window over guardrail, exiting without pinging");
      return;
    }

    const code = ping(configDir, plan.sessionId);
    recordPing(plan.stateFile, code);
    logInfo(
      `keepalive-scheduler: ping ${i + 1}/${plan.maxPings} for ${plan.profile} exited ${code}`
    );
  }

  logInfo("keepalive-scheduler: ping cap reached, exiting");
}

main().catch((err) => {
  logError(`keepalive-scheduler: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
