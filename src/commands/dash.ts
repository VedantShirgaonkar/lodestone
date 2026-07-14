import { parseArgs } from "node:util";
import { stdout, stderr } from "node:process";
import { isatty } from "node:tty";
import { basename, join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { loadConfig } from "../core/config.js";
import {
  getQuota,
  readUsageCache,
  usageCachePath,
} from "../core/realUsage.js";
import { windowBurn, switchTax } from "../core/usage.js";
import {
  parseSession,
  latestSession,
  newestSessionIn,
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
import { keepaliveStateDir, pidAlive } from "../core/keepalive.js";

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
  /** Model-specific weekly buckets, only when the usage endpoint returns them. */
  perModelWeekly?: Array<{ model: string; pct?: number; resetsAt?: number }>;
  sessions: SessionLine[];
}

interface QuotaBar {
  used: number;
  hasData: boolean;
  resetIn: string;
  source: string;
  pacing?: number;
  /** Measured weighted tokens from the local burn model, shown when there is
   *  no live percentage. Never converted to a % of a guessed plan budget. */
  estBurnTokens?: number;
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
    // owns the fallback. Report what the burn model actually measured, in
    // weighted tokens. This used to convert the burn into a percentage of a
    // guessed plan budget and render it on the same bar as live data, which
    // is the exact fabrication the hard rules ban and status.ts refuses:
    // dividing a real measurement by an assumption produces "9297%".
    let estimateBurnTokens: number | undefined;
    if (quota.source === "estimate") {
      try {
        const burnResult = await windowBurn(configDir, now);
        if (burnResult.minutesRemaining > 0 && burnResult.burn > 0) {
          estimateBurnTokens = burnResult.burn;
          // The reset time IS measured (window start from our own
          // transcripts plus the five-hour constant), so it can be shown.
          quota.fiveHourResetsAt =
            Math.floor(now.getTime() / 1000) + burnResult.minutesRemaining * 60;
        }
      } catch {
        // leave undefined; bar renders "no recent data"
      }
    }

    // Build 5h bar
    const fiveHourBar = buildQuotaBar(quota, "fiveHour", estimateBurnTokens);

    // Build 7d bar
    const sevenDayBar = buildQuotaBar(quota, "sevenDay");

    // Get recent sessions for this profile
    const sessions = await getRecentSessions(configDir, now);

    const block: ProfileQuotaBlock = {
      name,
      login: loginHint,
      fiveHour: fiveHourBar,
      sevenDay: sevenDayBar,
      sessions,
    };
    if (quota.perModelWeekly) {
      block.perModelWeekly = quota.perModelWeekly;
    }
    profiles.push(block);

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
  field: "fiveHour" | "sevenDay",
  estimateBurnTokens?: number
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

  const bar: QuotaBar = {
    used: Math.round(used),
    hasData,
    resetIn,
    source: source === "statusline" ? "live" : source === "oauth" ? "live" : "est",
    pacing,
  };
  if (!hasData && estimateBurnTokens !== undefined) {
    bar.estBurnTokens = estimateBurnTokens;
  }
  return bar;
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

      // projectPath is already the projects/<munged>/ directory. latestSession
      // takes a working directory and munges it, so passing this would munge it
      // twice and resolve to nothing: the session list would always be empty.
      const sessionPath = newestSessionIn(projectPath);
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

        // Name the project from the transcript's cwd, like status does. The
        // munged directory name is truthful but unreadable, and reversing it
        // is impossible.
        sessions.push({
          project: parsed.meta.cwd ? basename(parsed.meta.cwd) : projectMunged,
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
    // The same rules as `keepalive --status`: the real state dir (honors
    // XDG_CONFIG_HOME, no HOME required), and a pid is a claim to verify, not
    // a fact to repeat — the dash must not display a scheduler that died.
    const keepaliveDir = keepaliveStateDir();
    if (!existsSync(keepaliveDir)) return null;

    const files = readdirSync(keepaliveDir);
    const keepaliveFiles = files.filter((f) =>
      f.startsWith("keepalive-") && f.endsWith(".json")
    );

    for (const file of keepaliveFiles) {
      try {
        const data = JSON.parse(
          readFileSync(join(keepaliveDir, file), "utf8")
        ) as {
          profile?: string;
          pid?: number;
          pings?: unknown[];
          cap?: number;
        };
        if (data.profile && pidAlive(data.pid)) {
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

    // Model-specific weekly caps, when the endpoint meters them separately.
    for (const row of profile.perModelWeekly ?? []) {
      if (row.pct === undefined) continue;
      const bar = progressBar(Math.max(0, Math.min(row.pct, 100)), 100, 15);
      let resetStr = "";
      if (row.resetsAt) {
        const secs = row.resetsAt - Math.floor(Date.now() / 1000);
        if (secs > 0) {
          const mins = Math.floor(secs / 60);
          const hours = Math.floor(mins / 60);
          resetStr = ` · resets in ${hours > 0 ? `${hours}h ${mins % 60}m` : `${mins}m`}`;
        }
      }
      lines.push(`  wk (${row.model}) ${bar}${resetStr} · ${dim("(live)")}`);
    }

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
    // The measured burn, in the only unit we can state honestly without live
    // data. No bar: a bar implies a known budget.
    if (q.estBurnTokens !== undefined) {
      const tok =
        q.estBurnTokens >= 1_000_000
          ? `${(q.estBurnTokens / 1_000_000).toFixed(1)}M`
          : q.estBurnTokens >= 1_000
            ? `${Math.round(q.estBurnTokens / 1000)}k`
            : String(q.estBurnTokens);
      const reset = q.resetIn !== "?" ? ` · resets in ${q.resetIn}` : "";
      return `  ${label} ~${tok} wtok used${reset} · ${dim("(est — for real %, run: lodestone init --statusline)")}`;
    }
    return `  ${label} ${dim("no recent data")} · ${dim(`(${q.source})`)}`;
  }
  // Live percentages are clamped to 100 at normalization (the feed can
  // transiently overshoot right after a limit), and estimates no longer
  // render as percentages at all, so the bar's own clamp is belt-and-braces.
  const bar = progressBar(Math.max(0, Math.min(q.used, 100)), 100, 15);
  let line = `  ${label} ${bar} · resets in ${q.resetIn} · ${dim(`(${q.source}`)}`;

  if (q.pacing !== undefined && q.pacing > 0) {
    line += dim(`, target ${q.pacing}%`);
  }

  line += dim(")");
  return line;
}
