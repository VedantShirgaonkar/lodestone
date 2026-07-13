import { parseArgs } from "node:util";
import { join } from "node:path";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { loadConfig } from "../core/config.js";
import { windowBurn, asPctOfWindow, switchTax } from "../core/usage.js";
import { parseSession, latestSession, latestContextTokens } from "../core/transcript.js";
import { expandTilde, projectsDirFor, mungeCwd } from "../core/paths.js";
import {
  loadLatestHandoff,
  estimateTokens,
} from "../core/handoffFile.js";
import { findProjectRoot } from "../core/paths.js";
import { progressBar } from "../util/ansi.js";
import { resolveActingProfile, adoptDefault } from "../core/profiles.js";

interface CommandOptions {
  json: boolean;
  profile?: string | undefined;
}

interface SessionInfo {
  project: string;
  contextTokens: number;
  idleMinutes: number;
}

interface WindowInfo {
  burn: number;
  pct: number;
  windowStartIso: string | undefined;
  minutesRemaining: number;
}

interface ProfileStatus {
  name: string;
  configDir: string;
  login: string;
  window: WindowInfo | null;
  sessions: SessionInfo[];
}

interface StatusOutput {
  profiles: ProfileStatus[];
  switchTax?: {
    naive: number;
    handoff: number;
  } | null;
}

export async function status(
  args: string[],
  opts: CommandOptions
): Promise<number> {
  try {
    const { values: _parsedOpts } = parseArgs({
      args,
      options: {},
      allowPositionals: false,
      strict: true,
    });

    adoptDefault();
    const config = loadConfig();

    const profiles: ProfileStatus[] = [];
    const now = new Date();

    // Process each profile
    for (const [name, profileCfg] of Object.entries(config.profiles)) {
      const configDir = expandTilde(profileCfg.configDir);

      // Get login hint
      const { loggedInHint } = await import("../core/profiles.js");
      const profileInfo = { name, configDir, label: profileCfg.label };
      const login = loggedInHint(profileInfo);

      // Calculate window burn
      const burnResult = await windowBurn(configDir, now);
      const burn = burnResult.burn;
      const windowStartIso = burnResult.windowStartIso;
      const minutesRemaining = burnResult.minutesRemaining;

      // Calculate as percentage of window
      const plan = (config.settings as Record<string, unknown>)
        ?.plan as string | undefined || "pro";
      const pct = asPctOfWindow(burn, plan as "pro" | "max5" | "max20" | "team");

      const window =
        burn === 0 && minutesRemaining === 0
          ? null
          : {
              burn,
              pct,
              windowStartIso,
              minutesRemaining,
            };

      // Get recent sessions (< 24h, cap 3)
      const sessions = getRecentSessions(configDir, now);

      profiles.push({
        name,
        configDir: expandTilde(configDir),
        login,
        window,
        sessions,
      });
    }

    // Check if we're inside a project with a live source session
    let switchTaxInfo: { naive: number; handoff: number } | null = null;
    try {
      const projectRoot = findProjectRoot(process.cwd());
      const currentProf = resolveActingProfile(opts.profile);

      if (currentProf) {
        const sessionPath = latestSession(currentProf.configDir, process.cwd());
        if (sessionPath) {
          const parsed = await parseSession(sessionPath);
          const contextTokens = latestContextTokens(parsed);

          if (contextTokens > 0) {
            const handoffData = loadLatestHandoff(projectRoot);
            const handoffTokens = handoffData
              ? estimateTokens(handoffData.markdown)
              : undefined;
            switchTaxInfo = switchTax(contextTokens, handoffTokens);
          }
        }
      }
    } catch {
      // Not in a project context, skip
    }

    // Output
    if (opts.json) {
      const output: StatusOutput = {
        profiles,
        switchTax: switchTaxInfo,
      };
      console.log(JSON.stringify(output));
    } else {
      // Human-readable output
      for (const profile of profiles) {
        console.log(
          `${profile.name}  ${expandTilde(profile.configDir)}      ${profile.login}`
        );

        if (profile.window) {
          const bar = progressBar(profile.window.pct, 100, 22);
          console.log(`  5h window: ${bar} est`);
          if (profile.window.windowStartIso) {
            console.log(
              `  started ${formatDate(profile.window.windowStartIso)}, ~${profile.window.minutesRemaining}m left`
            );
          }
        } else {
          console.log(`  5h window: no recent activity`);
        }

        // Show recent sessions (cap 3, newest first)
        for (let i = 0; i < Math.min(3, profile.sessions.length); i++) {
          const sess = profile.sessions[i];
          if (sess) {
            const cacheWarmth = Math.max(0, 60 - sess.idleMinutes);
            const warmthStr =
              cacheWarmth <= 0
                ? "cache cold"
                : `cache warm ~${cacheWarmth}m left`;
            console.log(
              `  ${sess.project}: ctx ${sess.contextTokens.toLocaleString()} tok · last turn ${sess.idleMinutes}m ago (${warmthStr})`
            );
          }
        }

        console.log();
      }

      // Footer when in a project with live session
      if (switchTaxInfo) {
        console.log(
          `switch tax now: ≈ ${switchTaxInfo.naive.toLocaleString()} weighted tokens naive vs ≈ ${switchTaxInfo.handoff.toLocaleString()} with handoff`
        );
      }
    }

    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`lodestone status: ${msg}`);
    return 1;
  }
}

/**
 * Get recent sessions (< 24h old, cap 3, newest first).
 * Returns: project name (best-effort de-munge), context tokens, idle minutes.
 */
function getRecentSessions(
  configDir: string,
  now: Date
): SessionInfo[] {
  const projectsDir = projectsDirFor(configDir);
  const sessions: SessionInfo[] = [];

  if (!existsSync(projectsDir)) {
    return sessions;
  }

  const nowMs = now.getTime();
  const twentyFourHoursMs = 24 * 60 * 60 * 1000;

  try {
    const projects = readdirSync(projectsDir);

    for (const project of projects) {
      const projectPath = join(projectsDir, project);
      if (!statSync(projectPath).isDirectory()) continue;

      const files = readdirSync(projectPath);
      let newestFile: string | undefined;
      let newestMtime = 0;

      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;

        const filePath = join(projectPath, file);
        const stat = statSync(filePath);
        if (stat.mtime.getTime() > newestMtime) {
          newestMtime = stat.mtime.getTime();
          newestFile = filePath;
        }
      }

      // Check if file is < 24h old
      if (newestFile && nowMs - newestMtime < twentyFourHoursMs) {
        // Parse to get context tokens and idle time
        try {
          const parsed = parseSessionSync(newestFile);
          if (parsed) {
            const contextTokens = parsed.contextTokens;
            const lastTsMs = new Date(parsed.lastTs ?? now).getTime();
            const idleMinutes = Math.round((nowMs - lastTsMs) / (1000 * 60));

            // De-munge project name (best effort)
            const projectName = deMungeCwd(project);

            sessions.push({
              project: projectName,
              contextTokens,
              idleMinutes,
            });
          }
        } catch {
          // Skip unparseable sessions
        }
      }
    }
  } catch {
    // Silent fail
  }

  // Sort by idle time (newest first) and cap at 3
  sessions.sort((a, b) => a.idleMinutes - b.idleMinutes);
  return sessions.slice(0, 3);
}

/**
 * Synchronously parse a session file (small fixture for status purposes).
 */
function parseSessionSync(
  filePath: string
): { contextTokens: number; lastTs: string | undefined } | undefined {
  try {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n");

    let lastTs: string | undefined;
    let contextTokens = 0;

    // Scan backward for the most recent usage info
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;

      try {
        const entry = JSON.parse(line);
        if (!lastTs && entry.timestamp) {
          lastTs = entry.timestamp;
        }

        // Extract context tokens from last turn with usage
        if (
          contextTokens === 0 &&
          entry.type === "assistant" &&
          entry.message?.usage
        ) {
          const usage = entry.message.usage;
          contextTokens =
            (usage.input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0);
        }

        if (lastTs && contextTokens > 0) {
          break;
        }
      } catch {
        // Skip malformed lines
      }
    }

    return { contextTokens, lastTs };
  } catch {
    return undefined;
  }
}

/**
 * Best-effort de-munge: reverse the mungeCwd transformation.
 * mungeCwd replaces "/" with "-", so we reverse that but can't reliably
 * recover the original path. Return basename or best guess.
 */
function deMungeCwd(munged: string): string {
  // Simple heuristic: if it starts with -, strip leading -, then take the last component
  if (munged.startsWith("-")) {
    munged = munged.slice(1);
  }
  // Take the last component after splitting by -
  const parts = munged.split("-");
  return parts[parts.length - 1] ?? munged;
}

/**
 * Format timestamp as HH:MM
 */
function formatDate(iso: string): string {
  try {
    const date = new Date(iso);
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}
