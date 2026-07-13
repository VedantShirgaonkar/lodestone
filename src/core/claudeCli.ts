import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProfileInfo } from "./profiles.js";

/**
 * Find the claude CLI on PATH.
 * Returns the path if found, or "claude" (will fail at runtime if not available).
 */
export function claudePath(): string {
  const envOverride = process.env.LODESTONE_CLAUDE_BIN;
  if (envOverride) {
    return envOverride;
  }

  try {
    const result = execSync("which claude", { encoding: "utf8", stdio: "pipe" });
    return result.trim();
  } catch {
    // not on PATH, return default name
    return "claude";
  }
}

/**
 * Get the version of the claude CLI.
 * Returns undefined if not available or error.
 */
export function versionOf(claudeBin: string = claudePath()): string | undefined {
  try {
    const result = spawnSync(claudeBin, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (result.status === 0) {
      return result.stdout.trim();
    }
  } catch {
    // Silent fail
  }
  return undefined;
}

/**
 * Launch claude interactively with a profile.
 * Spawns claude with CLAUDE_CONFIG_DIR set and stdio inherited.
 * Returns the exit code.
 */
export function launchInteractive(
  profile: ProfileInfo,
  args: string[] = [],
  opts?: { cwd?: string }
): number {
  const claudeBin = claudePath();
  const env = { ...process.env, CLAUDE_CONFIG_DIR: profile.configDir };

  try {
    const result = spawnSync(claudeBin, args, {
      cwd: opts?.cwd,
      env,
      stdio: "inherit",
      timeout: 0, // No timeout for interactive
    });
    return result.status ?? 1;
  } catch (err) {
    return 1;
  }
}

/**
 * Run a distillation prompt against a session.
 * Spawns: claude --resume <sessionId> --fork-session -p <prompt> --output-format json --max-turns 1
 * Returns the parsed result text, or undefined on error.
 * Timeout: 120s.
 */
export function distill(
  profile: ProfileInfo,
  sessionId: string,
  template: string,
  opts?: { cwd?: string }
): string | undefined {
  const claudeBin = claudePath();
  const env = { ...process.env, CLAUDE_CONFIG_DIR: profile.configDir };

  try {
    const result = spawnSync(
      claudeBin,
      [
        "--resume",
        sessionId,
        "--fork-session",
        "-p",
        template,
        "--output-format",
        "json",
        "--max-turns",
        "1",
      ],
      {
        cwd: opts?.cwd,
        env,
        encoding: "utf8",
        timeout: 120000,
        stdio: "pipe",
      }
    );

    if (result.status !== 0) {
      return undefined;
    }

    // Parse JSON result
    try {
      const output = JSON.parse(result.stdout);
      // Extract text from the output
      if (output.result && typeof output.result === "string") {
        return output.result;
      } else if (output.content) {
        return String(output.content);
      }
    } catch {
      // Try raw stdout if not JSON
      return result.stdout;
    }
  } catch {
    // Silent fail
  }

  return undefined;
}
