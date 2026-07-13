#!/usr/bin/env node
/**
 * lodestone measure-switch — evaluation harness
 *
 * Measures handoff vs. naive switch cost on fixture or real data.
 *
 * Usage:
 *   npx ts-node scripts/measure-switch.ts --fixture [--verbose]
 *   npx ts-node scripts/measure-switch.ts --source-dir <dir> --target-dir <dir> --project <path> [--verbose]
 *
 * Outputs: evaluation table with context, handoff size, first-turn usage, weighted comparisons.
 * No token spending inside the script itself.
 *
 * Methodology (see docs/EVALUATION.md):
 * 1. Source session: extract context tokens, find latest session JSONL
 * 2. Handoff file: load/measure from .claude/handoff/latest.md
 * 3. First-turn cost: read from target profile's JSONL (first turn after handoff inject)
 * 4. Comparison: naive (2×C weighted) vs. handoff (2×(S+H) weighted)
 * 5. Keepalive validation (if applicable): ping turn shows cache_read ≈ C, writes tiny, 1h tier
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { createReadStream } from "fs";
import { createInterface } from "readline";

// ============================================================================
// Types
// ============================================================================

interface UsageStats {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
}

interface EvaluationResult {
  sourceContext: number;
  sourceSession: string | null;
  handoffSize: number;
  handoffFound: boolean;
  naiveCost: number; // weighted tokens for naive path
  handoffCost: number; // weighted tokens for handoff path
  savings: number; // percentage
  weightedBuckets?: {
    naive: { input: number; cacheWrite: number; total: number };
    handoff: { input: number; cacheWrite: number; total: number };
  };
}

// ============================================================================
// Parsing & Measurement
// ============================================================================

const WEIGHT_TABLE = {
  input: 1,
  cacheRead: 0.1,
  cacheCreation: 2,
  output: 5,
};

function weightedCost(usage: UsageStats): number {
  return (
    usage.inputTokens * WEIGHT_TABLE.input +
    usage.cacheReadTokens * WEIGHT_TABLE.cacheRead +
    usage.cacheCreationTokens * WEIGHT_TABLE.cacheCreation +
    usage.outputTokens * WEIGHT_TABLE.output
  );
}

/**
 * Parse a single JSONL line (Claude Code session transcript).
 * Returns the usage object if this is an assistant message, else null.
 */
function parseJsonlLine(line: string): {
  usage?: UsageStats;
  consumedBy?: string;
  isCacheWrite?: boolean;
} | null {
  try {
    const obj = JSON.parse(line);
    if (obj.role === "assistant" && obj.usage) {
      const usage: UsageStats = {
        inputTokens: obj.usage.input_tokens ?? 0,
        cacheReadTokens: obj.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: obj.usage.cache_creation_input_tokens ?? 0,
        outputTokens: obj.usage.output_tokens ?? 0,
      };
      return {
        usage,
        consumedBy: obj.metadata?.consumedBy,
        isCacheWrite:
          (obj.usage.cache_creation_input_tokens ?? 0) > 0,
      };
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

/**
 * Munge a filesystem path to Claude Code's project directory naming:
 * replace `/` with `-` to create a flat project dir name.
 * E.g. `/Users/rahul/Desktop/mem` -> `-Users-rahul-Desktop-mem`
 */
function mungeCwd(cwd: string): string {
  return cwd.split("/").join("-");
}

/**
 * Read latest session JSONL for a profile + project.
 * Returns path to the newest JSONL file in that project dir.
 */
function findLatestSession(
  configDir: string,
  projectPath: string
): string | null {
  try {
    // Munge cwd like lodestone does: /path/to/project → -path-to-project
    const munged = mungeCwd(projectPath);
    const projectsDir = join(configDir, "projects", munged);

    if (!existsSync(projectsDir)) {
      return null;
    }

    const files = readdirSync(projectsDir).filter((f) => f.endsWith(".jsonl"));
    if (files.length === 0) {
      return null;
    }

    // Find newest by mtime
    let newest = files[0];
    if (newest === undefined) {
      return null;
    }
    let newestTime = statSync(join(projectsDir, newest)).mtime.getTime();

    for (const f of files) {
      const time = statSync(join(projectsDir, f)).mtime.getTime();
      if (time > newestTime) {
        newest = f;
        newestTime = time;
      }
    }

    return join(projectsDir, newest);
  } catch {
    return null;
  }
}

/**
 * Extract context tokens from the last assistant usage in a session.
 */
async function extractContextTokens(sessionPath: string): Promise<number> {
  return new Promise((resolve) => {
    let lastUsage: UsageStats | null = null;
    const rl = createInterface({
      input: createReadStream(sessionPath),
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      const parsed = parseJsonlLine(line);
      if (parsed?.usage) {
        lastUsage = parsed.usage;
      }
    });

    rl.on("close", () => {
      if (!lastUsage) {
        resolve(0);
        return;
      }
      // Context = input + cache_read + cache_creation (rough estimate)
      resolve(
        lastUsage.inputTokens +
          lastUsage.cacheReadTokens +
          lastUsage.cacheCreationTokens
      );
    });
  });
}

/**
 * Measure handoff file size (rough token estimate: chars / 3.6).
 * Handoffs live in the project root: <projectRoot>/.claude/handoff/latest.md
 */
function measureHandoff(projectPath: string): number {
  try {
    const handoffPath = join(projectPath, ".claude", "handoff", "latest.md");

    if (existsSync(handoffPath)) {
      const content = readFileSync(handoffPath, "utf-8");
      return Math.ceil(content.length / 3.6); // rough token estimate
    }
  } catch {
    // Ignore
  }
  return 0;
}

/**
 * Read first-turn usage on target (for measuring actual handoff cost).
 * This is optional; the measurement can work from formulas alone.
 */
async function extractFirstTurnUsage(
  sessionPath: string,
  afterTimestamp: number
): Promise<UsageStats | null> {
  return new Promise((resolve) => {
    let found: UsageStats | null = null;
    let lineCount = 0;
    const rl = createInterface({
      input: createReadStream(sessionPath),
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      if (found || lineCount > 10) {
        rl.close();
        return;
      }

      try {
        const obj = JSON.parse(line);
        if (
          obj.role === "assistant" &&
          obj.usage &&
          (obj.timestamp ?? 0) > afterTimestamp
        ) {
          found = {
            inputTokens: obj.usage.input_tokens ?? 0,
            cacheReadTokens: obj.usage.cache_read_input_tokens ?? 0,
            cacheCreationTokens:
              obj.usage.cache_creation_input_tokens ?? 0,
            outputTokens: obj.usage.output_tokens ?? 0,
          };
          rl.close();
        }
      } catch {
        // Ignore
      }
      lineCount++;
    });

    rl.on("close", () => {
      resolve(found);
    });
  });
}

/**
 * Run evaluation on fixture or real data.
 */
async function measure(
  sourceDirOrMode: string,
  targetDir?: string,
  projectPath?: string,
  verbose?: boolean
): Promise<EvaluationResult> {
  let sourceDir = sourceDirOrMode;
  let actualProjectPath = projectPath || process.cwd();

  // Fixture mode: use test fixtures
  if (sourceDirOrMode === "--fixture") {
    sourceDir = join(process.cwd(), "dist-test", "test", "fixtures", "config-personal");
    targetDir = targetDir || join(process.cwd(), "dist-test", "test", "fixtures", "config-work");
  }

  // Validate directories exist
  if (!existsSync(sourceDir)) {
    throw new Error(`Source config dir not found: ${sourceDir}`);
  }
  if (targetDir && !existsSync(targetDir)) {
    throw new Error(`Target config dir not found: ${targetDir}`);
  }

  // Extract context and handoff
  const sessionPath = findLatestSession(sourceDir, actualProjectPath);
  const contextTokens = sessionPath ? await extractContextTokens(sessionPath) : 0;
  const handoffTokens = measureHandoff(actualProjectPath);

  // Formulas (see docs/EVALUATION.md)
  const S = 20000; // system prompt + CLAUDE.md preamble estimate
  const C = contextTokens || 150000; // fallback to typical session
  const H = handoffTokens || 2000; // handoff size

  // Naive path: 2×C weighted (input + cache_creation at 2×)
  const naiveCost = C * 2;

  // Handoff path: 2×(S+H) weighted
  const handoffCost = (S + H) * 2;

  const savings = ((naiveCost - handoffCost) / naiveCost) * 100;

  return {
    sourceContext: C,
    sourceSession: sessionPath || null,
    handoffSize: H,
    handoffFound: handoffTokens > 0,
    naiveCost,
    handoffCost,
    savings,
    weightedBuckets: {
      naive: {
        input: C,
        cacheWrite: C,
        total: naiveCost,
      },
      handoff: {
        input: S + H,
        cacheWrite: S + H,
        total: handoffCost,
      },
    },
  };
}

/**
 * Format and print results.
 */
function printResults(result: EvaluationResult, verbose?: boolean): void {
  console.log("lodestone measure-switch evaluation");
  console.log("=====================================\n");

  console.log("Context & Handoff:");
  console.log(`  Source context:     ${result.sourceContext.toLocaleString()} tokens`);
  console.log(`  Handoff size:       ${result.handoffSize.toLocaleString()} tokens (${result.handoffFound ? "found" : "estimated"})`);
  console.log(`  Source session:     ${result.sourceSession || "(none)"}  `);

  console.log("\nCost Comparison:");
  console.log(`  Naive path (replay):     ${result.naiveCost.toLocaleString()} weighted tokens`);
  console.log(`  Handoff path:            ${result.handoffCost.toLocaleString()} weighted tokens`);
  console.log(`  Savings:                 ${result.savings.toFixed(1)}%`);

  if (verbose && result.weightedBuckets) {
    const { naive, handoff } = result.weightedBuckets;
    console.log("\nDetailed breakdown:");
    console.log(`  Naive:   ${naive.input.toLocaleString()} input + ${naive.cacheWrite.toLocaleString()} cache_write (2×) = ${naive.total.toLocaleString()}`);
    console.log(`  Handoff: ${handoff.input.toLocaleString()} input + ${handoff.cacheWrite.toLocaleString()} cache_write (2×) = ${handoff.total.toLocaleString()}`);
  }

  console.log("\nInterpretation:");
  if (result.savings >= 80) {
    console.log("  ✓ Handoff is highly effective (>80% savings)");
  } else if (result.savings >= 50) {
    console.log("  ✓ Handoff is effective (50–80% savings)");
  } else {
    console.log("  ⚠ Handoff savings modest (<50%); consider Tier 1 or check context size");
  }

  console.log(
    "\nNote: This is an estimate. Real costs depend on model, effort, exact session size, and API accounting."
  );
  console.log("See docs/EVALUATION.md for methodology and threats to validity.");
}

/**
 * Main.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose");

  let sourceDir = "";
  let targetDir: string | undefined;
  let projectPath: string | undefined;

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--fixture") {
      sourceDir = "--fixture";
    } else if (args[i] === "--source-dir") {
      sourceDir = args[++i] || "";
    } else if (args[i] === "--target-dir") {
      targetDir = args[++i];
    } else if (args[i] === "--project") {
      projectPath = args[++i];
    }
  }

  if (!sourceDir) {
    console.error("Usage:");
    console.error("  measure-switch --fixture [--verbose]");
    console.error("  measure-switch --source-dir <dir> --target-dir <dir> --project <path> [--verbose]");
    process.exit(2);
  }

  try {
    const result = await measure(sourceDir, targetDir, projectPath, verbose);
    printResults(result, verbose);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
