import { parseArgs } from "node:util";
import { stdout, stderr } from "node:process";
import { isatty } from "node:tty";
import { join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { loadConfig } from "../core/config.js";
import {
  getQuota,
  readUsageCache,
  usageCachePath,
} from "../core/realUsage.js";
import { windowBurn, asPctOfWindow, switchTax } from "../core/usage.js";
import {
  parseSession,
  latestSession,
  latestContextTokens,
  type ParsedSession,
} from "../core/transcript.js";
import { expandTilde, projectsDirFor, mungeCwd, findProjectRoot } from "../core/paths.js";
import {
  loadLatestHandoff,
  estimateTokens,
} from "../core/handoffFile.js";
import {
  progressBar,
  bold,
  dim,
  red,
  green,
  yellow,
} from "../util/ansi.js";
import { resolveActingProfile, adoptDefault, loggedInHint } from "../core/profiles.js";
import { versionOf } from "../core/claudeCli.js";

interface CommandOptions {
  json: boolean;
  profile?: string | undefined;
}

interface DashFrame {
  timestamp: string;
  profiles: ProfileQuotaBlock[];
  switchTax?: SwitchTaxPanel | null;
  advisorLine?: string | null;
  keepaliveStatus?: string | null;
}

interface ProfileQuotaBlock {
  name: string;
  login: string;
  fiveHour: QuotaBar;
  sevenDay: QuotaBar;
  sessions: SessionLine[];
}

interface QuotaBar {
  used: number;
  hasData: boolean;
  resetIn: string;
  source: string;
  pacing?: number;
}

interface SessionLine {
  project: string;
  contextTokens: number;
  cacheTTL: string;
}

interface SwitchTaxPanel {
  naive: number;
  handoff: number;
  savings: number;
}

/**
 * lodestone dash — live full-screen TUI (ANSI, zero deps, 2s refresh)
 * --once flag: render single frame and exit (for tests)
 */
export async function dash(
  args: string[],
  opts: CommandOptions
): Promise<number> {
  try {
    const { values: parsedOpts } = parseArgs({
      args,
      options: {
        once: { type: "boolean", default: false },
      },
      allowPositionals: false,
      strict: true,
    });

    const once = (parsedOpts.once as boolean | undefined) ?? false;

    adoptDefault();
    const config = loadConfig();
    const claudeVersion = await versionOf();
    const now = new Date();

    if (once) {
      // Single frame for testing
      const frame = await buildFrame(
        config,
        claudeVersion,
        now,
        process.cwd()
      );
      renderFrame(frame);
      return 0;
    }

    // Interactive mode (not tested in phase 5, kept for future)
    // For now, same as --once
    const frame = await buildFrame(config, claudeVersion, now, process.cwd());
    renderFrame(frame);
    return 0;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);
    stderr.write(`lodestone dash: ${message}\n`);
    return 1;
  }
}

async function buildFrame(
  config: any,
  claudeVersion: string | undefined,
  now: Date,
  cwd: string
): Promise<DashFrame> {
  const profiles: ProfileQuotaBlock[] = [];
  let switchTaxPanel: SwitchTaxPanel | null = null;
  let advisorLine: string | null = null;
  let keepaliveStatus: string | null = null;

  // Process each profile
  for (const [name, profileCfg] of Object.entries(config.profiles)) {
    const cfgObj = profileCfg as Record<string, unknown>;
    const configDir = expandTilde(cfgObj.configDir as string);

    // Get login hint
    const loginHint = loggedInHint({
      name,
      configDir,
      label: cfgObj.label as string | undefined,
    });

    // Get quota
    const realUsageOptedIn =
      ((config.settings as Record<string, unknown>)
        ?.realUsage as boolean | undefined) ?? false;
    const quota = await getQuota(
      configDir,
      claudeVersion,
      realUsageOptedIn
    );

    // getQuota's estimate branch returns no figures by design — the caller
    // owns the fallback. Fill the 5h numbers from the local burn model so
    // the bar shows the estimate instead of a misleading 0%.
    if (quota.source === "estimate") {
      try {
        const burnResult = await windowBurn(configDir, now);
        if (burnResult.minutesRemaining > 0) {
          const plan = (((config.settings as Record<string, unknown>)
            ?.plan as string | undefined) ?? "pro") as
            | "pro"
            | "max5"
            | "max20"
            | "team";
          quota.fiveHourUtilization = asPctOfWindow(burnResult.burn, plan);
          quota.fiveHourResetsAt =
            Math.floor(now.getTime() / 1000) + burnResult.minutesRemaining * 60;
        }
      } catch {
        // leave undefined; bar renders "?"
      }
    }

    // Build 5h bar
    const fiveHourBar = buildQuotaBar(quota, "fiveHour");

    // Build 7d bar
    const sevenDayBar = buildQuotaBar(quota, "sevenDay");

    // Get recent sessions for this profile
    const sessions = await getRecentSessions(configDir, now);

    profiles.push({
      name,
      login: loginHint,
      fiveHour: fiveHourBar,
      sevenDay: sevenDayBar,
      sessions,
    });

    // Check for advisor line (≥85% on 5h or ≥90% on 7d)
    if (
      (fiveHourBar.used >= 85 || sevenDayBar.used >= 90) &&
      !advisorLine
    ) {
      const label =
        fiveHourBar.used >= 85 ? "5h" : "weekly";
      advisorLine = `⚠ ${name}: ${label} at ${fiveHourBar.used}% — consider /handoff`;
    }
  }

  // Switch tax panel (if cwd is a project with a source session)
  if (findProjectRoot(cwd)) {
    try {
      const sourceProfile = resolveActingProfile();
      if (sourceProfile) {
        const configDir = expandTilde(sourceProfile.configDir);
        // Pass cwd to latestSession (it will munge it to find the project directory)
        const sessionPath = latestSession(configDir, cwd);
        if (sessionPath) {
          const parsed = await parseSession(sessionPath);
          const contextTokens = latestContextTokens(parsed);
          if (contextTokens > 0) {
            const tax = switchTax(contextTokens);
            const savings = Math.round(
              ((tax.naive - tax.handoff) / tax.naive) * 100
            );
            switchTaxPanel = {
              naive: tax.naive,
              handoff: tax.handoff,
              savings,
            };
          }
        }
      }
    } catch {
      // Silent fail on switch tax
    }
  }

  // Check for keepalive status
  keepaliveStatus = getKeepaliveStatus();

  return {
    timestamp: formatTime(now),
    profiles,
    switchTax: switchTaxPanel,
    advisorLine,
    keepaliveStatus,
  };
}

function buildQuotaBar(
  quota: any,
  field: "fiveHour" | "sevenDay"
): QuotaBar {
  const isSevenDay = field === "sevenDay";
  const utilField = isSevenDay ? "sevenDayUtilization" : "fiveHourUtilization";
  const resetField = isSevenDay ? "sevenDayResetsAt" : "fiveHourResetsAt";

  const usedVal = (quota as Record<string, unknown>)[utilField];
  const hasData = usedVal !== undefined && usedVal !== null;
  const used = hasData ? (usedVal as number) : 0;
  const resetsAtTs = (quota as Record<string, unknown>)[resetField] as number | undefined;
  const sourceVal = (quota as Record<string, unknown>).source;
  const source = (sourceVal !== undefined && sourceVal !== null) ? (sourceVal as string) : "estimate";

  // Calculate reset-in time
  let resetIn = "?";
  if (resetsAtTs && typeof resetsAtTs === "number") {
    const secs = resetsAtTs - Math.floor(Date.now() / 1000);
    if (secs > 0) {
      const mins = Math.floor(secs / 60);
      const hours = Math.floor(mins / 60);
      if (hours > 0) {
        resetIn = `${hours}h ${mins % 60}m`;
      } else {
        resetIn = `${mins}m`;
      }
    } else {
      resetIn = "now";
    }
  }

  // Pacing marker: where we "should" be if consuming linearly
  const windowMinutes = isSevenDay ? 7 * 24 * 60 : 5 * 60;
  let pacing = 50; // Default to ~middle
  if (resetsAtTs && typeof resetsAtTs === "number") {
    const remainingSecs = Math.max(0, resetsAtTs - Math.floor(Date.now() / 1000));
    const remainingMins = remainingSecs / 60;
    pacing = Math.round((100 * (windowMinutes - remainingMins)) / windowMinutes);
  }

  return {
    used: Math.round(used),
    hasData,
    resetIn,
    source: source === "statusline" ? "live" : source === "oauth" ? "live" : "est",
    pacing,
  };
}

async function getRecentSessions(
  configDir: string,
  now: Date
): Promise<SessionLine[]> {
  const sessions: SessionLine[] = [];

  try {
    const projectsDir = projectsDirFor(configDir);
    if (!existsSync(projectsDir)) {
      return sessions;
    }

    const projects = readdirSync(projectsDir);
    for (const projectMunged of projects) {
      const projectPath = join(projectsDir, projectMunged);
      if (!statSync(projectPath).isDirectory()) continue;

      const sessionPath = latestSession(configDir, projectPath);
      if (!sessionPath) continue;

      try {
        const parsed = await parseSession(sessionPath);

        // Only include if < 24h old
        if (parsed.meta.lastTs) {
          const ageMs = now.getTime() - new Date(parsed.meta.lastTs).getTime();
          if (ageMs > 24 * 60 * 60 * 1000) continue;
        }

        const contextTokens = latestContextTokens(parsed);
        const idleMinutes = parsed.meta.lastTs
          ? Math.floor(
              (now.getTime() - new Date(parsed.meta.lastTs).getTime()) /
                60000
            )
          : 0;

        const cacheTTL = Math.max(0, 60 - idleMinutes);
        const ttlStr = cacheTTL <= 0 ? "cold" : `${cacheTTL}m`;

        sessions.push({
          project: projectMunged,
          contextTokens,
          cacheTTL: ttlStr,
        });
      } catch {
        // Skip on parse error
      }
    }
  } catch {
    // Silent fail
  }

  return sessions.slice(0, 3); // Cap at 3 recent sessions
}

function getKeepaliveStatus(): string | null {
  try {
    // Check for keepalive pidfile in ~/.config/lodestone/keepalive-*.json
    const homeDir = process.env.HOME;
    if (!homeDir) return null;

    const keepaliveDir = join(homeDir, ".config", "lodestone");
    if (!existsSync(keepaliveDir)) return null;

    const files = readdirSync(keepaliveDir);
    const keepaliveFiles = files.filter((f) =>
      f.startsWith("keepalive-") && f.endsWith(".json")
    );

    if (keepaliveFiles.length === 0) return null;

    // Read the first active one
    for (const file of keepaliveFiles) {
      try {
        const data = JSON.parse(
          readFileSync(join(keepaliveDir, file), "utf8")
        ) as {
          profile?: string;
          pings?: unknown[];
          cap?: number;
        };
        if (data.profile) {
          const pingCount = (data.pings as unknown[])?.length ?? 0;
          const cap = data.cap ?? 3;
          return `keepalive ${data.profile}: ${pingCount}/${cap} pings`;
        }
      } catch {
        // Skip on parse error
      }
    }
  } catch {
    // Silent fail
  }

  return null;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function renderFrame(frame: DashFrame): void {
  const lines: string[] = [];

  // Header
  lines.push(
    `lodestone dash · ${frame.timestamp} · q quit · r refresh`
  );
  lines.push("");

  // Per-profile blocks
  for (const profile of frame.profiles) {
    lines.push(bold(`${profile.name}`) + ` · ${dim(profile.login)}`);

    // 5h quota bar
    lines.push(renderQuotaBar("5h", profile.fiveHour));

    // 7d quota bar
    lines.push(renderQuotaBar("wk", profile.sevenDay));

    // Sessions
    for (const session of profile.sessions) {
      const cacheLine =
        session.cacheTTL === "cold"
          ? red(session.cacheTTL)
          : green(session.cacheTTL);
      lines.push(
        dim(
          `  · ${session.project} · ctx ${session.contextTokens} · ${cacheLine}`
        )
      );
    }

    lines.push("");
  }

  // Switch tax panel
  if (frame.switchTax !== null && frame.switchTax !== undefined) {
    lines.push(
      `switch tax: naive ~${frame.switchTax.naive} vs handoff ~${frame.switchTax.handoff} (−${frame.switchTax.savings}%)`
    );
    lines.push("");
  }

  // Advisor line
  if (frame.advisorLine) {
    lines.push(yellow(frame.advisorLine));
    lines.push("");
  }

  // Keepalive status
  if (frame.keepaliveStatus) {
    lines.push(dim(frame.keepaliveStatus));
    lines.push("");
  }

  console.log(lines.join("\n"));
}

function renderQuotaBar(label: string, q: QuotaBar): string {
  if (!q.hasData) {
    return `  ${label} ${dim("no recent data")} · ${dim(`(${q.source})`)}`;
  }
  // Estimates can legitimately exceed 100% (burn model vs plan budget);
  // clamp the bar fill but show the true percentage as text.
  const bar = progressBar(Math.max(0, Math.min(q.used, 100)), 100, 15);
  const over = q.used > 100 ? ` ${q.used}%` : "";
  let line = `  ${label} ${bar}${over} · resets in ${q.resetIn} · ${dim(`(${q.source}`)}`;

  if (q.pacing !== undefined && q.pacing > 0) {
    line += dim(`, target ${q.pacing}%`);
  }

  line += dim(")");
  return line;
}
