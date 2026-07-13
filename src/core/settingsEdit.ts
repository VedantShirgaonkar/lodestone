import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export interface SettingsHook {
  type: string;
  command: string;
  timeout?: number;
  matcher?: string;
}

export interface SettingsConfig {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Install hooks into a settings.json file.
 * Idempotent: detects existing hooks by command substring ("lodestone hook <type>").
 * If our subcommand exists but the full command differs, UPDATES it in place.
 * Backs up to settings.json.bak before writing.
 * Throws on invalid JSON or write error.
 */
export function installHooks(
  configDirOrSettingsPath: string,
  opts: {
    sessionStartCmd?: string;
    sessionStartMatcher?: string;
    sessionEndCmd?: string;
    preCompactCmd?: string;
  }
): void {
  const settingsPath = isSettingsPath(configDirOrSettingsPath)
    ? configDirOrSettingsPath
    : join(configDirOrSettingsPath, "settings.json");

  // Read existing settings
  let settings: SettingsConfig = {};
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, "utf8");
    try {
      settings = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Invalid JSON in ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Ensure hooks object exists
  if (!settings.hooks) {
    settings.hooks = {};
  }

  const hooksObj = settings.hooks as Record<string, unknown>;
  let changed = false;

  // SessionStart hook (with matcher)
  if (opts.sessionStartCmd) {
    const result = createOrUpdateHook(
      opts.sessionStartCmd,
      "SessionStart",
      hooksObj,
      opts.sessionStartMatcher ?? "startup|clear"
    );
    if (result.changed) {
      changed = true;
    }
  }

  // SessionEnd hook (no matcher)
  if (opts.sessionEndCmd) {
    const result = createOrUpdateHook(
      opts.sessionEndCmd,
      "SessionEnd",
      hooksObj
    );
    if (result.changed) {
      changed = true;
    }
  }

  // PreCompact hook (no matcher)
  if (opts.preCompactCmd) {
    const result = createOrUpdateHook(
      opts.preCompactCmd,
      "PreCompact",
      hooksObj
    );
    if (result.changed) {
      changed = true;
    }
  }

  if (!changed) {
    // Nothing to do
    return;
  }

  // Backup original
  if (existsSync(settingsPath)) {
    copyFileSync(settingsPath, `${settingsPath}.bak`);
  }

  // Write new settings
  try {
    const dir = dirname(settingsPath);
    mkdirSync(dir, { recursive: true });
  } catch {
    // Silent fail on mkdir
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
}

/**
 * Uninstall hooks from settings.json.
 * Removes entries containing "lodestone hook" substring.
 * Idempotent.
 */
export function uninstallHooks(configDirOrSettingsPath: string): void {
  const settingsPath = isSettingsPath(configDirOrSettingsPath)
    ? configDirOrSettingsPath
    : join(configDirOrSettingsPath, "settings.json");

  if (!existsSync(settingsPath)) {
    return;
  }

  const raw = readFileSync(settingsPath, "utf8");
  let settings: SettingsConfig = {};
  try {
    settings = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${settingsPath}`);
  }

  const hooksObj = settings.hooks as Record<string, unknown>;
  if (!hooksObj || typeof hooksObj !== "object") {
    return;
  }

  let changed = false;

  for (const [eventName, eventHooks] of Object.entries(hooksObj)) {
    if (Array.isArray(eventHooks)) {
      const filtered = eventHooks.filter((h) => {
        if (typeof h === "object" && h !== null && "hooks" in h) {
          const innerHooks = (h as Record<string, unknown>).hooks;
          if (Array.isArray(innerHooks)) {
            return !innerHooks.some(
              (ih) =>
                typeof ih === "object" &&
                ih !== null &&
                "command" in ih &&
                typeof (ih as Record<string, unknown>).command === "string" &&
                ((ih as Record<string, unknown>).command as string).includes(
                  "lodestone hook"
                )
            );
          }
        }
        return true;
      });

      if (filtered.length !== eventHooks.length) {
        changed = true;
        if (filtered.length === 0) {
          delete hooksObj[eventName];
        } else {
          hooksObj[eventName] = filtered;
        }
      }
    }
  }

  if (!changed) {
    return;
  }

  // Backup and write
  copyFileSync(settingsPath, `${settingsPath}.bak`);
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
}

/**
 * Helper: check if path looks like settings.json (not a config dir).
 */
function isSettingsPath(path: string): boolean {
  return path.endsWith("settings.json") || path.endsWith("settings.local.json");
}

/**
 * Helper: create or update hook in hooksObj.
 * Idempotent by command substring matching.
 * If our lodestone hook subcommand exists but the full command differs, UPDATE it in place.
 * Returns {changed: boolean}.
 */
function createOrUpdateHook(
  command: string,
  eventName: string,
  hooksObj: Record<string, unknown>,
  matcher?: string
): { changed: boolean } {
  // Check if this command subcommand already exists
  const existing = hooksObj[eventName];
  if (Array.isArray(existing)) {
    for (let entryIdx = 0; entryIdx < existing.length; entryIdx++) {
      const entry = existing[entryIdx];
      if (typeof entry === "object" && entry !== null && "hooks" in entry) {
        const innerHooks = (entry as Record<string, unknown>).hooks;
        if (Array.isArray(innerHooks)) {
          for (let hookIdx = 0; hookIdx < innerHooks.length; hookIdx++) {
            const ih = innerHooks[hookIdx];
            if (
              typeof ih === "object" &&
              ih !== null &&
              "command" in ih &&
              typeof (ih as Record<string, unknown>).command === "string"
            ) {
              const existingCmd = (ih as Record<string, unknown>)
                .command as string;
              // Detect if this is our hook by lodestone hook substring
              if (existingCmd.includes("lodestone hook")) {
                // Check if it's the same command
                if (existingCmd === command) {
                  return { changed: false }; // Already present, no change needed
                }
                // Different command with same subcommand → UPDATE in place
                const newHook: SettingsHook = {
                  type: "command",
                  command,
                  timeout: 30,
                };
                if (matcher) {
                  newHook.matcher = matcher;
                }
                innerHooks[hookIdx] = newHook;
                return { changed: true };
              }
            }
          }
        }
      }
    }
  }

  // Not found → add new hook
  const newHook: SettingsHook = {
    type: "command",
    command,
    timeout: 30,
  };
  if (matcher) {
    newHook.matcher = matcher;
  }

  const hookEntry = {
    hooks: [newHook],
  };

  if (Array.isArray(existing)) {
    existing.push(hookEntry);
  } else {
    hooksObj[eventName] = [hookEntry];
  }

  return { changed: true };
}
