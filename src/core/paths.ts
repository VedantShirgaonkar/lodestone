import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";

/**
 * Munge a filesystem path to Claude Code's project directory naming:
 * replace `/` with `-` to create a flat project dir name.
 * E.g. `/Users/rahul/Desktop/mem` -> `-Users-rahul-Desktop-mem`
 */
export function mungeCwd(cwd: string): string {
  return cwd.split("/").join("-");
}

/**
 * Get the projects directory for a given config dir.
 * E.g. `/home/user/.claude` -> `/home/user/.claude/projects`
 */
export function projectsDirFor(configDir: string): string {
  return join(configDir, "projects");
}

/**
 * Get the handoff directory for a project root.
 * E.g. `/home/user/my-project` -> `/home/user/my-project/.claude/handoff`
 */
export function handoffDirFor(projectRoot: string): string {
  return join(projectRoot, ".claude", "handoff");
}

/**
 * Get the warmswap config path.
 * $XDG_CONFIG_HOME/warmswap/config.json, fallback to ~/.config/warmswap/config.json
 */
export function warmswapConfigPath(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const configDir = xdgConfigHome
    ? join(xdgConfigHome, "warmswap")
    : join(homedir(), ".config", "warmswap");
  return join(configDir, "config.json");
}

/**
 * Expand `~` to the home directory.
 */
export function expandTilde(path: string): string {
  if (path.startsWith("~")) {
    return join(homedir(), path.slice(1));
  }
  return path;
}

/**
 * Find the nearest ancestor directory with `.git`, or return cwd if not found.
 */
export function findProjectRoot(cwd: string): string {
  let current = resolve(cwd);
  while (current !== dirname(current)) {
    // Check if .git exists in current
    const gitPath = join(current, ".git");
    if (existsSync(gitPath)) {
      return current;
    }
    current = dirname(current);
  }
  // Reached filesystem root without finding .git
  return resolve(cwd);
}
