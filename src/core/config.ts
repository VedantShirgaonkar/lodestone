import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";
import { lodestoneConfigPath } from "./paths.js";

export interface ProfileConfig {
  configDir: string;
  label?: string;
}

export interface AdvisorSettings {
  fiveHourPct?: number;
  weeklyPct?: number;
  trailStaleMinutes?: number;
  criticalPct?: number;
}

export interface KeepaliveSettings {
  maxWindowPct?: number;
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
  keepalive?: KeepaliveSettings;
}

export interface LodestoneConfig {
  schema: number;
  profiles: Record<string, ProfileConfig>;
  settings: SettingsConfig;
}

/**
 * Load the lodestone config from disk.
 * Returns a default config if the file doesn't exist.
 */
export function loadConfig(configPath?: string): LodestoneConfig {
  const path = configPath ?? lodestoneConfigPath();
  if (!existsSync(path)) {
    return defaultConfig();
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    return parsed as LodestoneConfig;
  } catch {
    return defaultConfig();
  }
}

/**
 * Save the lodestone config to disk atomically (write to tmp, then rename).
 * Creates a backup (.bak) before overwriting.
 */
export function saveConfig(
  config: LodestoneConfig,
  configPath?: string
): void {
  const path = configPath ?? lodestoneConfigPath();
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

function defaultConfig(): LodestoneConfig {
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
