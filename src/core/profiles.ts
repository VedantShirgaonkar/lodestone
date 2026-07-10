import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "./config.js";
import { expandTilde } from "./paths.js";

const DEFAULT_PROFILES_DIR = join(homedir(), ".claude-profiles");

export interface ProfileInfo {
  name: string;
  configDir: string;
  label?: string | undefined;
}

/**
 * Add a profile to the registry.
 * If configDir is not provided, defaults to ~/.claude-profiles/<name>
 * Rejects if the profile name already exists or if the dir is registered as another profile.
 */
export function addProfile(
  name: string,
  opts?: { configDir?: string }
): void {
  const config = loadConfig();

  if (config.profiles[name]) {
    throw new Error(
      `Profile "${name}" already exists. Use "remove" first if you need to replace it.`
    );
  }

  const configDir = expandTilde(opts?.configDir ?? join(DEFAULT_PROFILES_DIR, name));

  // Check if this dir is already registered as a different profile
  for (const [pName, pCfg] of Object.entries(config.profiles)) {
    if (pCfg.configDir === configDir && pName !== name) {
      throw new Error(
        `Directory "${configDir}" is already registered as profile "${pName}".`
      );
    }
  }

  // Create the directory if it doesn't exist
  try {
    mkdirSync(configDir, { recursive: true });
  } catch {
    // Might already exist, silent fail
  }

  // Register it
  config.profiles[name] = { configDir };
  saveConfig(config);
}

/**
 * Adopt the default ~/.claude profile if it exists and is not already registered.
 * Only registers it; does not create it.
 */
export function adoptDefault(): void {
  const defaultDir = join(homedir(), ".claude");
  if (!existsSync(defaultDir)) {
    return;
  }

  const config = loadConfig();

  // Check if any profile already points to this dir
  for (const pCfg of Object.values(config.profiles)) {
    if (pCfg.configDir === defaultDir) {
      return; // Already registered
    }
  }

  // Register it as "personal"
  config.profiles["personal"] = { configDir: defaultDir };
  saveConfig(config);
}

/**
 * Remove a profile from the registry.
 * NEVER deletes the config directory itself.
 */
export function removeProfile(name: string): void {
  const config = loadConfig();

  if (!config.profiles[name]) {
    throw new Error(`Profile "${name}" not found.`);
  }

  delete config.profiles[name];
  saveConfig(config);
}

/**
 * Get the currently active profile based on CLAUDE_CONFIG_DIR env var.
 * Falls back to the first registered profile (arbitrary order) or undefined.
 */
export function currentProfile(): ProfileInfo | undefined {
  const envConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const config = loadConfig();

  if (envConfigDir) {
    // Find a profile matching the env var
    for (const name of Object.keys(config.profiles)) {
      const pCfg = config.profiles[name];
      if (pCfg && pCfg.configDir === envConfigDir) {
        return { name, configDir: pCfg.configDir, label: pCfg.label };
      }
    }
    // env var set but doesn't match any registered profile
    return undefined;
  }

  // No env var; return first profile if any
  const names = Object.keys(config.profiles);
  if (names.length > 0 && names[0]) {
    const name = names[0];
    const pCfg = config.profiles[name];
    if (pCfg) {
      return { name, configDir: pCfg.configDir, label: pCfg.label };
    }
  }

  return undefined;
}

/**
 * Get a hint about whether a profile is logged in.
 * Reads the profile's .claude.json oauthAccount fields if present.
 * Returns email + organization name if available, otherwise "not logged in".
 */
export function loggedInHint(profileInfo: ProfileInfo): string {
  const claudeJsonPath = join(profileInfo.configDir, ".claude.json");
  if (!existsSync(claudeJsonPath)) {
    return "not logged in";
  }

  try {
    const raw = readFileSync(claudeJsonPath, "utf8");
    const data = JSON.parse(raw);
    const account = data?.oauthAccount;

    if (!account) {
      return "not logged in";
    }

    const email = account.emailAddress;
    const org = account.organizationName;

    if (email && org) {
      return `${email} (${org})`;
    } else if (email) {
      return email;
    } else if (org) {
      return org;
    } else {
      return "logged in";
    }
  } catch {
    return "not logged in";
  }
}
