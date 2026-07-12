import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseSession } from "./transcript.js";
import { projectsDirFor } from "./paths.js";

export interface WeightTable {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
}

const DEFAULT_WEIGHTS: WeightTable = {
  input: 1,
  cacheCreation: 2,
  cacheRead: 0.1,
  output: 5,
};

export interface ModelPriceRatios {
  opus: number;
  sonnet: number;
  haiku: number;
  fable: number;
}

const DEFAULT_PRICE_RATIOS: ModelPriceRatios = {
  opus: 5,
  sonnet: 1,
  haiku: 0.25,
  fable: 0.25,
};

/**
 * Calculate weighted burn for a usage entry.
 * Uses the formula: input*w.input + cache_creation*w.cacheCreation +
 *                  cache_read*w.cacheRead + output*w.output
 */
export function weightedBurn(
  usage: {
    input_tokens?: number | undefined;
    output_tokens?: number | undefined;
    cache_creation_input_tokens?: number | undefined;
    cache_read_input_tokens?: number | undefined;
  },
  weights: WeightTable = DEFAULT_WEIGHTS
): number {
  return (
    (usage.input_tokens ?? 0) * weights.input +
    (usage.output_tokens ?? 0) * weights.output +
    (usage.cache_creation_input_tokens ?? 0) * weights.cacheCreation +
    (usage.cache_read_input_tokens ?? 0) * weights.cacheRead
  );
}

/**
 * Apply per-model price ratio to weighted burn.
 */
export function applyModelRatio(
  weightedBurn: number,
  model: string | undefined,
  ratios: ModelPriceRatios = DEFAULT_PRICE_RATIOS
): number {
  if (!model) return weightedBurn;

  // Extract base model name (e.g., "claude-3-5-sonnet" -> "sonnet")
  const lowerModel = model.toLowerCase();
  if (lowerModel.includes("opus")) return weightedBurn * ratios.opus;
  if (lowerModel.includes("sonnet")) return weightedBurn * ratios.sonnet;
  if (lowerModel.includes("haiku")) return weightedBurn * ratios.haiku;
  if (lowerModel.includes("fable")) return weightedBurn * ratios.fable;

  return weightedBurn;
}

export interface WindowBurnResult {
  burn: number;
  windowStartIso: string | undefined;
  minutesRemaining: number;
}

/**
 * Scan all sessions in a config directory and calculate burn within a 5-hour window.
 * Window algorithm (per Anthropic):
 *   - Session starts with first message, lasts 5 hours
 *   - If now >= windowStart + 5h, window has expired → burn = 0, minutesRemaining = 0
 *   - Otherwise burn = Σ weighted usage of all turns with timestamp >= windowStart
 *
 * Per-turn timestamps and models are used (from Turn objects).
 */
export async function windowBurn(
  configDir: string,
  now: Date,
  weights: WeightTable = DEFAULT_WEIGHTS
): Promise<WindowBurnResult> {
  const projectsDir = projectsDirFor(configDir);

  if (!existsSync(projectsDir)) {
    return { burn: 0, windowStartIso: undefined, minutesRemaining: 0 };
  }

  const allTurns: Array<{
    timestamp: string | undefined;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    };
    model: string | undefined;
  }> = [];

  // Collect all turns from all sessions using per-turn timestamps
  try {
    const projects = readdirSync(projectsDir);
    for (const project of projects) {
      const projectPath = join(projectsDir, project);
      if (!statSync(projectPath).isDirectory()) continue;

      const files = readdirSync(projectPath);
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;

        const filePath = join(projectPath, file);
        try {
          const parsed = await parseSession(filePath);
          for (let i = 0; i < parsed.turns.length; i++) {
            const turn = parsed.turns[i];
            if (turn && turn.usage && turn.timestamp) {
              // Skip zero-usage turns (synthetic, errors, interrupts)
              const total = (turn.usage.input_tokens ?? 0) +
                (turn.usage.cache_read_input_tokens ?? 0) +
                (turn.usage.cache_creation_input_tokens ?? 0) +
                (turn.usage.output_tokens ?? 0);
              if (total > 0) {
                allTurns.push({
                  timestamp: turn.timestamp,
                  usage: turn.usage,
                  model: turn.model,
                });
              }
            }
          }
        } catch {
          // Skip unparseable sessions
        }
      }
    }
  } catch {
    return { burn: 0, windowStartIso: undefined, minutesRemaining: 0 };
  }

  if (allTurns.length === 0) {
    return { burn: 0, windowStartIso: undefined, minutesRemaining: 0 };
  }

  // Sort by timestamp
  allTurns.sort(
    (a, b) =>
      new Date(a.timestamp ?? "").getTime() -
      new Date(b.timestamp ?? "").getTime()
  );

  // Anthropic's session model: a window opens at the first message and lasts
  // 5 hours; the next message AFTER expiry opens a new window. Under
  // continuous use the window still rolls every 5h — an idle-gap scan alone
  // would let long marathons "expire" their own window and zero the meter.
  const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
  let windowStart = allTurns[0]?.timestamp ?? new Date().toISOString();
  let windowStartTime = new Date(windowStart).getTime();

  for (let i = 1; i < allTurns.length; i++) {
    const currTurn = allTurns[i];
    if (currTurn?.timestamp) {
      const curr = new Date(currTurn.timestamp).getTime();
      if (curr >= windowStartTime + FIVE_HOURS_MS) {
        // This turn opens a new window (whether after idle or mid-marathon).
        windowStart = currTurn.timestamp;
        windowStartTime = curr;
      }
    }
  }

  // Check if window has expired
  const nowMs = now.getTime();
  if (nowMs >= windowStartTime + FIVE_HOURS_MS) {
    // Window expired
    return {
      burn: 0,
      windowStartIso: windowStart,
      minutesRemaining: 0,
    };
  }

  // Calculate burn for turns in the window
  let burn = 0;
  for (const turn of allTurns) {
    if (turn.timestamp) {
      const ts = new Date(turn.timestamp).getTime();
      if (ts >= windowStartTime && ts <= nowMs) {
        const wb = weightedBurn(turn.usage, weights);
        burn += applyModelRatio(wb, turn.model);
      }
    }
  }

  // Calculate minutes remaining
  const minutesRemaining = Math.round(
    (windowStartTime + FIVE_HOURS_MS - nowMs) / (60 * 1000)
  );

  return {
    burn,
    windowStartIso: windowStart,
    minutesRemaining: Math.max(0, minutesRemaining),
  };
}

/**
 * Estimate switch tax: {naive, handoff}
 * naive = 2 * contextTokens (full rewrite on source + full consume on target)
 * handoff = 2 * (preambleTokens + handoffTokens)
 *
 * @param contextTokens - current live context size
 * @param handoffTokens - measured size of handoff snapshot (default 2500)
 * @param preambleTokens - system preamble size (default 20000)
 */
export function switchTax(
  contextTokens: number,
  handoffTokens: number = 2500,
  preambleTokens: number = 20000
): { naive: number; handoff: number } {
  return {
    naive: 2 * contextTokens,
    handoff: 2 * (preambleTokens + handoffTokens),
  };
}

/**
 * Format burn as percentage of a budget window.
 * Recalibrated budgets (weighted-token-equivalents):
 * - pro: 500_000 tokens
 * - max5: 2_500_000 tokens
 * - max20: 10_000_000 tokens
 * - team: 500_000 tokens (rough estimate)
 *
 * Calibration note: ~150k-context naive switch (≈300k weighted) should land
 * in observed 40–80%-of-Pro-window range; these are rough community estimates,
 * configurable per user.
 */
export function asPctOfWindow(
  burn: number,
  plan: "pro" | "max5" | "max20" | "team"
): number {
  const budgets: Record<string, number> = {
    pro: 500_000,
    max5: 2_500_000,
    max20: 10_000_000,
    team: 500_000,
  };
  const budget = budgets[plan] ?? 500_000;
  return Math.round((burn / budget) * 100);
}
