import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";
import { warmswapConfigPath } from "./paths.js";

export interface ProfileConfig {
  configDir: string;
  label?: string;
}

export interface AdvisorSettings {
  fiveHourPct?: number;
  weeklyPct?: number;
}

export interface SettingsConfig {
  maxAgeDays?: number;
  injectOn?: string[];
  autoSnapshot?: boolean;
  distillModel?: string;
  plan?: string; // "pro" | "max5" | "max20" | "team"
  weights?: Record<string, number>;
  realUsage?: boolean;
  advisor?: AdvisorSettings;
}

export interface WarmswapConfig {
  schema: number;
  profiles: Record<string, ProfileConfig>;
  settings: SettingsConfig;
}

/**
 * Load the warmswap config from disk.
 * Returns a default config if the file doesn't exist.
 */
export function loadConfig(configPath?: string): WarmswapConfig {
  const path = configPath ?? warmswapConfigPath();
  if (!existsSync(path)) {
    return defaultConfig();
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    return parsed as WarmswapConfig;
  } catch {
    return defaultConfig();
  }
}

/**
 * Save the warmswap config to disk atomically (write to tmp, then rename).
 * Creates a backup (.bak) before overwriting.
 */
export function saveConfig(
  config: WarmswapConfig,
  configPath?: string
): void {
  const path = configPath ?? warmswapConfigPath();
  const dir = dirname(path);

  // Ensure directory exists
  mkdirSync(dir, { recursive: true });

  // Back up existing file before overwriting
  if (existsSync(path)) {
    const backupPath = `${path}.bak`;
    copyFileSync(path, backupPath);
  }

  // Atomic write: write to temp file, then rename
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf8");
  // Rename is atomic on POSIX
  renameSync(tmpPath, path);
}

function defaultConfig(): WarmswapConfig {
  return {
    schema: 1,
    profiles: {},
    settings: {
      maxAgeDays: 7,
      injectOn: ["startup", "clear"],
      autoSnapshot: true,
    },
  };
}
