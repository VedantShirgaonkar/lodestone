import { stdin, stdout } from "node:process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { projectsDirFor } from "../core/paths.js";
import { latestContextTokens, latestSession, parseSession } from "../core/transcript.js";
import { resolveActingProfile } from "../core/profiles.js";
import { windowBurn } from "../core/usage.js";
import { loadConfig } from "../core/config.js";
import { writeUsageCache } from "../core/realUsage.js";

interface RateLimitsSegment {
  used_percentage?: number;
  utilization?: number;
  resets_at?: number;
}

interface StatuslineInput {
  session_id?: string;
  transcript_path?: string;
  model?: string;
  workspace?: {
    current_dir?: string;
  } | string;
  version?: string;
  cost?: {
    total_cost_usd?: number;
    total_input_tokens?: number;
    total_output_tokens?: number;
  };
  context_window?: {
    used_percentage?: number;
    token_counts?: Record<string, number>;
    exceeds_200k_tokens?: boolean;
    current_usage?: number;
  };
  rate_limits?: {
    five_hour?: RateLimitsSegment;
    seven_day?: RateLimitsSegment;
  };
}

/**
 * Calculate switch tax as percentage.
 * switchTax.naive = 2 * context_tokens (rewrite cost)
 * switchTax.handoff = 2 * (handoff_tokens + summary_tokens)
 */
function calculateSwitchTaxPercent(
  contextTokens: number,
  planBudget: number
): number {
  const naiveCost = 2 * contextTokens;
  return Math.round((naiveCost / planBudget) * 100);
}

/**
 * Parse plan budget from plan name.
 * Rough estimates: pro ~200k, max5 ~1000k, max20 ~4000k, team ~2000k
 */
function planBudgetTokens(planName?: string): number {
  if (!planName) return 200000; // Default pro
  const lower = planName.toLowerCase();
  if (lower.includes("max20")) return 4000000;
  if (lower.includes("max5")) return 1000000;
  if (lower.includes("team")) return 2000000;
  return 200000; // pro default
}

export async function statusline(): Promise<number> {
  try {
    // Read stdin with timeout
    const input = await readStdinWithTimeout(150);
    if (!input) {
      console.log("⇄ warmswap");
      return 0;
    }

    const typedInput = input as StatuslineInput;

    // Build output line (v2: prefer rate_limits, add weekly, pacing, advisor glyph)
    const profile = resolveActingProfile()?.name ?? "?";
    const contextPctStr = typedInput.context_window?.used_percentage
      ? ` · ctx ${typedInput.context_window.used_percentage}%`
      : "";

    // Cache warmth segment: locate latest session for workspace and show TTL
    let cacheWarmthStr = "";
    const currentProfile = resolveActingProfile();
    if (currentProfile) {
      const workspaceCwd =
        typeof typedInput.workspace === "object" && typedInput.workspace?.current_dir
          ? typedInput.workspace.current_dir
          : process.cwd();
      cacheWarmthStr = getCacheWarmthSegment(currentProfile.configDir, workspaceCwd);
    }

    // Real rate_limits take priority over estimate
    let fiveHourStr = "";
    let weeklyStr = "";
    let pacingMarker = "";
    let advisorGlyph = "";

    if (typedInput.rate_limits) {
      // Write to usage cache for other tools
      if (currentProfile) {
        const cacheData: {
          source: "statusline" | "oauth";
          five_hour?: { used_percentage?: number | undefined; resets_at_ts?: number | undefined } | undefined;
          seven_day?: { used_percentage?: number | undefined; resets_at_ts?: number | undefined } | undefined;
        } = {
          source: "statusline",
        };

        if (typedInput.rate_limits.five_hour) {
          cacheData.five_hour = {
            used_percentage: typedInput.rate_limits.five_hour.used_percentage,
            resets_at_ts: typedInput.rate_limits.five_hour.resets_at,
          };
        }

        if (typedInput.rate_limits.seven_day) {
          cacheData.seven_day = {
            used_percentage: typedInput.rate_limits.seven_day.used_percentage,
            resets_at_ts: typedInput.rate_limits.seven_day.resets_at,
          };
        }

        writeUsageCache(currentProfile.configDir, cacheData);
      }

      // 5h segment with pacing
      const fiveHourPct = typedInput.rate_limits.five_hour?.used_percentage;
      if (fiveHourPct !== undefined) {
        // Calculate pacing target: elapsed / window_length
        // For now, show if we're above target (>50% at 2.5h = 50% of window)
        const isPacing =
          fiveHourPct > 50 ? "▲" + Math.min(fiveHourPct, 99) : "";
        fiveHourStr = ` · 5h ${fiveHourPct}%${isPacing}`;

        // Show countdown to reset if present
        if (typedInput.rate_limits.five_hour?.resets_at) {
          const resetEpoch = typedInput.rate_limits.five_hour.resets_at;
          const nowEpoch = Math.floor(Date.now() / 1000);
          const minutesRemaining = Math.max(
            0,
            Math.round((resetEpoch - nowEpoch) / 60)
          );
          if (minutesRemaining > 0 && minutesRemaining < 300) {
            // Only show if <5h
            fiveHourStr += ` (${formatDuration(minutesRemaining * 60)})`;
          }
        }

        // Advisor glyph: warn at threshold
        const config = loadConfig();
        const advisorThreshold = config.settings.advisor?.fiveHourPct ?? 85;
        if (fiveHourPct >= advisorThreshold) {
          advisorGlyph = " ⚠ handoff?";
        }
      }

      // 7d segment
      const weeklyPct = typedInput.rate_limits.seven_day?.used_percentage;
      if (weeklyPct !== undefined) {
        weeklyStr = ` · wk ${weeklyPct}%`;

        // Check weekly threshold for advisor
        if (!advisorGlyph) {
          const config = loadConfig();
          const weeklyThreshold = config.settings.advisor?.weeklyPct ?? 90;
          if (weeklyPct >= weeklyThreshold) {
            advisorGlyph = " ⚠ handoff?";
          }
        }
      }
    } else {
      // Fallback: estimate from window burn (skip if >400 jsonl files)
      if (currentProfile) {
        const projectsDir = projectsDirFor(currentProfile.configDir);
        const hasManySessions = projectsHasManySessions(projectsDir);

        if (!hasManySessions) {
          try {
            const burnResult = await windowBurn(currentProfile.configDir, new Date());
            const burnPct = Math.round((burnResult.burn / 200000) * 100); // Default pro budget
            fiveHourStr = ` · 5h ≈${burnPct}%`;
          } catch {
            fiveHourStr = " · 5h ?%";
          }
        } else {
          fiveHourStr = " · 5h ?%";
        }
      }
    }

    // Calculate switch tax
    let switchTaxStr = "";
    if (typedInput.transcript_path) {
      try {
        const parsed = await parseSession(typedInput.transcript_path);
        const contextTokens = latestContextTokens(parsed);
        const config = loadConfig();
        const plan = config.settings.plan ?? "pro";
        const budget = planBudgetTokens(plan);
        const taxPct = calculateSwitchTaxPercent(contextTokens, budget);
        switchTaxStr = ` · switch ≈${taxPct}%`;
      } catch {
        // Silent fail, omit switch segment
      }
    }

    const line =
      `⇄ ${profile}${contextPctStr}${cacheWarmthStr}${fiveHourStr}${weeklyStr}${switchTaxStr}${advisorGlyph}`;
    console.log(line);
    return 0;
  } catch {
    console.log("⇄ warmswap");
    return 0;
  }
}

/**
 * Format duration in seconds as human-readable string
 */
function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  if (hours > 0) {
    return `${hours}h${mins > 0 ? mins + "m" : ""}`;
  }
  return `${mins}m`;
}

/**
 * Calculate cache warmth segment for the current workspace.
 * Returns "· cache XXm" or "· cache cold" or empty string if no session.
 * Computes idleMinutes from file mtime only (not by parsing transcript).
 * TTL is 1 hour, so remaining = max(0, 60 - idleMinutes).
 */
function getCacheWarmthSegment(
  configDir: string,
  workspaceCwd?: string
): string {
  if (!workspaceCwd) {
    return ""; // No workspace dir provided, omit segment
  }

  try {
    const sessionPath = latestSession(configDir, workspaceCwd);
    if (!sessionPath) {
      return ""; // No session exists for this directory
    }

    // Get file mtime
    const stat = statSync(sessionPath);
    const mtime = stat.mtime.getTime();
    const now = Date.now();
    const idleMinutes = Math.floor((now - mtime) / 1000 / 60);

    // Calculate remaining time: 1h TTL = 60 minutes
    const remainingMinutes = Math.max(0, 60 - idleMinutes);

    if (remainingMinutes === 0) {
      return " · cache cold";
    }
    return ` · cache ${remainingMinutes}m`;
  } catch {
    return ""; // Silently omit on error
  }
}

/**
 * Read stdin JSON with timeout (150ms target).
 * Returns parsed JSON or undefined on timeout/error.
 */
async function readStdinWithTimeout(timeoutMs: number): Promise<unknown> {
  return new Promise((resolve) => {
    let data = "";
    let timeoutId: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      stdin.removeAllListeners();
    };

    timeoutId = setTimeout(() => {
      cleanup();
      resolve(undefined);
    }, timeoutMs);

    stdin.on("data", (chunk) => {
      if (timeoutId) clearTimeout(timeoutId);
      data += chunk.toString();
    });

    stdin.on("end", () => {
      cleanup();
      try {
        const parsed = JSON.parse(data) as unknown;
        resolve(parsed);
      } catch {
        resolve(undefined);
      }
    });

    stdin.on("error", () => {
      cleanup();
      resolve(undefined);
    });

    // If stdin is a TTY, timeout immediately
    if (stdin.isTTY) {
      setTimeout(() => {
        cleanup();
        resolve(undefined);
      }, 10);
    }
  });
}

/**
 * Check if projects directory has more than 400 JSONL files.
 * Guard: skip window burn calculation if true.
 */
function projectsHasManySessions(projectsDir: string): boolean {
  if (!existsSync(projectsDir)) {
    return false;
  }

  try {
    let count = 0;
    const projects = readdirSync(projectsDir);
    for (const project of projects) {
      const projectPath = join(projectsDir, project);
      if (!statSync(projectPath).isDirectory()) continue;

      const files = readdirSync(projectPath);
      for (const file of files) {
        if (file.endsWith(".jsonl")) {
          count++;
          if (count > 400) {
            return true;
          }
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}
