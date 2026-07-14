import { spawnSync } from "node:child_process";

type CommandCache = Record<string, { output: string; time: number }>;
const cache: CommandCache = {};
const CACHE_TTL_MS = 60 * 1000; // 60s cache per command

/**
 * Every call here spawns the binary directly with an argument array and
 * shell: false. No command string is ever assembled, so nothing the user's
 * environment contains can be interpreted as shell syntax, and paths with
 * spaces work. Do not reintroduce exec/execSync.
 */
function run(bin: string, args: string[], timeoutMs: number, cwd?: string) {
  return spawnSync(bin, args, {
    shell: false,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    // Per-project commands (trail status, refresh, switch tax) resolve their
    // project from the process cwd. The extension host's own cwd is the app
    // bundle, not the workspace, so without this every per-project answer was
    // computed for a directory the user has never seen: trail status always
    // said "not installed", which is why the toggle could only ever turn on.
    cwd,
  });
}

/**
 * Locate the lodestone CLI: explicit override first, then PATH.
 * Returns null when the CLI is not installed.
 */
export function locateCli(): string | null {
  const override = process.env.LODESTONE_BIN;
  const candidate = override && override.trim().length > 0 ? override : "lodestone";

  const probe = run(candidate, ["--version"], 5000);
  if (probe.error || probe.status !== 0) {
    return null;
  }
  return candidate;
}

/**
 * Run a lodestone command that emits JSON on stdout.
 * Never throws; returns undefined on any failure. Results cached for 60s.
 */
export function runJson(
  cmd: string,
  args?: string[],
  opts?: { cwd?: string; fresh?: boolean }
): string | undefined {
  const bin = locateCli();
  if (!bin) {
    return undefined;
  }

  const argv = [cmd, ...(args ?? []), "--json"];
  const key = [bin, ...argv, opts?.cwd ?? ""].join(" "); // cache key only, never a command
  if (!opts?.fresh) {
    const hit = cache[key];
    if (hit && Date.now() - hit.time < CACHE_TTL_MS) {
      return hit.output;
    }
  }

  const result = run(bin, argv, 60_000, opts?.cwd);
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    return undefined;
  }

  cache[key] = { output: result.stdout, time: Date.now() };
  return result.stdout;
}

/**
 * Clear the command cache (manual refresh).
 */
export function clearCache(): void {
  for (const key in cache) {
    delete cache[key];
  }
}
