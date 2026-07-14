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

export type DistillOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/**
 * Run a distillation prompt against a session.
 * Spawns: claude --resume <sessionId> --fork-session -p <prompt> --output-format json --max-turns 1
 *
 * The system-prompt addition matters: the fork wakes up inside a working
 * session and, asked to summarize, a model will happily reach for a tool
 * first. With --max-turns 1 that tool call IS the one turn, the run ends as
 * `error_max_turns` with no result text, and the distillation dies. Telling
 * it up front that no tools exist keeps the single turn for the answer.
 *
 * Failures return a reason instead of undefined. This used to swallow every
 * diagnostic — non-zero exits, error-subtype JSON, timeouts all collapsed to
 * "distillation failed" with nothing to act on, which is exactly how it
 * reached a user before it reached a log.
 */
export function distill(
  profile: ProfileInfo,
  sessionId: string,
  template: string,
  opts?: { cwd?: string }
): DistillOutcome {
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
        "--append-system-prompt",
        "Answer directly from the conversation in a single reply. Do not use any tools.",
      ],
      {
        cwd: opts?.cwd,
        env,
        encoding: "utf8",
        timeout: 240000,
        stdio: "pipe",
      }
    );

    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      return {
        ok: false,
        reason:
          code === "ETIMEDOUT"
            ? "timed out after 240s"
            : `could not run claude: ${result.error.message}`,
      };
    }

    if (result.status !== 0) {
      const stderrTail = (result.stderr ?? "").trim().split("\n").slice(-2).join(" ");
      return {
        ok: false,
        reason: `claude exited ${result.status}${stderrTail ? `: ${stderrTail}` : ""}`,
      };
    }

    try {
      const output = JSON.parse(result.stdout) as {
        subtype?: string;
        is_error?: boolean;
        result?: unknown;
        content?: unknown;
      };

      if (typeof output.result === "string" && output.result.length > 0) {
        return { ok: true, text: output.result };
      }
      if (output.content) {
        return { ok: true, text: String(output.content) };
      }

      // Parsed fine but carries no text: an error-subtype result. Name it.
      if (output.subtype === "error_max_turns") {
        return {
          ok: false,
          reason:
            "the model tried to use tools instead of answering (error_max_turns) — run /handoff inside the session instead",
        };
      }
      return {
        ok: false,
        reason: `claude returned ${output.subtype ?? "a result"} with no text`,
      };
    } catch {
      const raw = result.stdout.trim();
      if (raw.length > 0) {
        // Not JSON but not empty: take it as the answer.
        return { ok: true, text: raw };
      }
      return { ok: false, reason: "claude produced no output" };
    }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
