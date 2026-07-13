import { execSync, spawnSync } from "node:child_process";

type CommandCache = Record<string, { output: string; time: number }>;
const cache: CommandCache = {};
const CACHE_TTL_MS = 60 * 1000; // 60s cache per command

/**
 * Locate the lodestone CLI binary.
 * 1. Check env LODESTONE_BIN override
 * 2. Try to spawn 'lodestone' via PATH
 * 3. Return null if missing
 */
export async function locateCliAsync(): Promise<string | null> {
  if (process.env.LODESTONE_BIN) {
    return process.env.LODESTONE_BIN;
  }

  try {
    // Try running 'lodestone --version' to probe PATH
    execSync("lodestone --version", { stdio: "pipe", timeout: 5000 });
    return "lodestone";
  } catch {
    return null;
  }
}

/**
 * Synchronous fallback for locating CLI (for extension init).
 */
export function locateCli(): string | null {
  if (process.env.LODESTONE_BIN) {
    return process.env.LODESTONE_BIN;
  }

  try {
    // Try running 'lodestone --version' to probe PATH
    execSync("lodestone --version", { stdio: "pipe" });
    return "lodestone";
  } catch {
    return null;
  }
}

/**
 * Run a CLI command and return JSON output.
 * Never throws; returns undefined on any failure.
 * Caches results for 60s per command.
 */
export async function runJsonAsync(
  cmd: string,
  args?: string[]
): Promise<string | undefined> {
  const cliPath = await locateCliAsync();
  if (!cliPath) {
    return undefined;
  }

  const fullCmd = [cliPath, cmd, ...(args ?? []), "--json"].join(" ");

  // Check cache
  if (cache[fullCmd]) {
    const { output, time } = cache[fullCmd];
    if (Date.now() - time < CACHE_TTL_MS) {
      return output;
    }
  }

  try {
    const output = execSync(fullCmd, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60 * 1000,
      encoding: "utf8",
    });

    // Store in cache
    cache[fullCmd] = { output, time: Date.now() };
    return output;
  } catch {
    return undefined;
  }
}

/**
 * Synchronous version of runJsonAsync (for extension.ts where we need sync).
 * Uses same caching.
 */
export function runJson(cmd: string, args?: string[]): string | undefined {
  const cliPath = locateCli();
  if (!cliPath) {
    return undefined;
  }

  const fullCmd = [cliPath, cmd, ...(args ?? []), "--json"].join(" ");

  // Check cache
  if (cache[fullCmd]) {
    const { output, time } = cache[fullCmd];
    if (Date.now() - time < CACHE_TTL_MS) {
      return output;
    }
  }

  try {
    const output = execSync(fullCmd, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60 * 1000,
      encoding: "utf8",
    });

    // Store in cache
    cache[fullCmd] = { output, time: Date.now() };
    return output;
  } catch {
    return undefined;
  }
}

/**
 * Clear the command cache (useful for testing or manual refresh).
 */
export function clearCache(): void {
  for (const key in cache) {
    delete cache[key];
  }
}
