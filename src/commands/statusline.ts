import { stdin, stdout } from "node:process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { projectsDirFor } from "../core/paths.js";
import { latestContextTokens, parseSession } from "../core/transcript.js";
import { resolveActingProfile } from "../core/profiles.js";
import { windowBurn } from "../core/usage.js";
import { loadConfig } from "../core/config.js";

interface StatuslineInput {
  session_id?: string;
  transcript_path?: string;
  model?: string;
  workspace?: string;
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
      console.log("⇄ cchandoff");
      return 0;
    }

    const typedInput = input as StatuslineInput;

    // Build output line
    const profile = resolveActingProfile()?.name ?? "?";
    const contextPctStr = typedInput.context_window?.used_percentage
      ? ` · ctx ${typedInput.context_window.used_percentage}%`
      : "";

    // Calculate window burn (skip if projects dir has >400 jsonl files)
    let windowBurnStr = "";
    const currentProfile = resolveActingProfile();
    if (currentProfile) {
      const projectsDir = projectsDirFor(currentProfile.configDir);
      const hasManySessions = projectsHasManySessions(projectsDir);

      if (!hasManySessions) {
        try {
          const burnResult = await windowBurn(currentProfile.configDir, new Date());
          const burnPct = Math.round((burnResult.burn / 200000) * 100); // Default pro budget
          windowBurnStr = ` · 5h ≈${burnPct}%`;
        } catch {
          windowBurnStr = " · 5h ?%";
        }
      } else {
        windowBurnStr = " · 5h ?%";
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

    const line = `⇄ ${profile}${contextPctStr}${windowBurnStr}${switchTaxStr}`;
    console.log(line);
    return 0;
  } catch {
    console.log("⇄ cchandoff");
    return 0;
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
