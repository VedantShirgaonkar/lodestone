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
 *
 * Idempotent, and self-repairing: an exact copy of the command we are about to
 * install is never added twice, a stale hook of ours is updated in place rather
 * than duplicated, and pre-existing duplicates left by older versions are
 * collapsed. Backs up to settings.json.bak before writing.
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

/** Every command hook registered under one event, with a way to rewrite it. */
function* hookCommandsOf(
  existing: unknown
): Generator<{ cmd: string; set: (h: SettingsHook) => void }> {
  if (!Array.isArray(existing)) return;
  for (const entry of existing) {
    if (typeof entry !== "object" || entry === null || !("hooks" in entry)) {
      continue;
    }
    const innerHooks = (entry as Record<string, unknown>).hooks;
    if (!Array.isArray(innerHooks)) continue;
    for (let i = 0; i < innerHooks.length; i++) {
      const ih = innerHooks[i];
      if (
        typeof ih === "object" &&
        ih !== null &&
        typeof (ih as Record<string, unknown>).command === "string"
      ) {
        const idx = i;
        yield {
          cmd: (ih as Record<string, unknown>).command as string,
          set: (h: SettingsHook) => {
            innerHooks[idx] = h;
          },
        };
      }
    }
  }
}

/**
 * Drop repeated copies of a hook we own, keeping one. Older versions
 * appended instead of updating whenever the installed command did not contain
 * the marker substring, so a settings file can already carry many copies of the
 * same hook, each firing on every event. Running `init` should repair that, not
 * merely decline to make it worse. Only touches commands we recognize as ours.
 */
function dedupeOurHooks(existing: unknown, command: string): boolean {
  if (!Array.isArray(existing)) return false;

  const seen = new Set<string>();
  let removed = 0;

  for (let i = existing.length - 1; i >= 0; i--) {
    const entry = existing[i];
    if (typeof entry !== "object" || entry === null || !("hooks" in entry)) {
      continue;
    }
    const inner = (entry as Record<string, unknown>).hooks;
    if (!Array.isArray(inner)) continue;

    const kept = inner.filter((h) => {
      const cmd = (h as { command?: unknown }).command;
      if (typeof cmd !== "string") return true;
      const ours = cmd === command || cmd.includes("lodestone hook");
      if (!ours) return true;
      if (seen.has(cmd)) {
        removed++;
        return false;
      }
      seen.add(cmd);
      return true;
    });

    if (kept.length === 0) {
      existing.splice(i, 1);
    } else if (kept.length !== inner.length) {
      (entry as Record<string, unknown>).hooks = kept;
    }
  }

  return removed > 0;
}

function createOrUpdateHook(
  command: string,
  eventName: string,
  hooksObj: Record<string, unknown>,
  matcher?: string
): { changed: boolean } {
  const existing = hooksObj[eventName];
  const repaired = dedupeOurHooks(existing, command);

  const newHook: SettingsHook = { type: "command", command, timeout: 30 };
  if (matcher) {
    newHook.matcher = matcher;
  }

  // Is this exact command already registered? Check this first, and for ANY
  // hook rather than only ones we recognize as ours. The ownership marker below
  // is a substring of the default command, so a caller that installs under a
  // different command (an absolute path, `node dist/cli.js`, LODESTONE_HOOK_CMD
  // in a dev build) was never recognized as already-installed, and every run
  // appended another identical copy. That is how a settings file ends up with a
  // hundred of the same hook, each one firing on every event.
  for (const { cmd } of hookCommandsOf(existing)) {
    if (cmd === command) {
      return { changed: repaired };
    }
  }

  // Ours, but stale (the binary moved, or the command changed): update in place
  // rather than adding a second one.
  for (const hook of hookCommandsOf(existing)) {
    if (hook.cmd.includes("lodestone hook")) {
      hook.set(newHook);
      return { changed: true };
    }
  }

  const hookEntry = { hooks: [newHook] };
  if (Array.isArray(existing)) {
    existing.push(hookEntry);
  } else {
    hooksObj[eventName] = [hookEntry];
  }

  return { changed: true };
}
