import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export interface Profile {
  name: string;
  configDir: string;
  label?: string;
}

export interface RegistryData {
  profiles: Profile[];
  settings?: {
    advisor?: {
      fiveHourPct?: number;
      weeklyPct?: number;
    };
  };
}

export interface ProfileQuotaData {
  source: "live" | "est" | "none";
  fiveHourPct?: number;
  fiveHourResetsAt?: number;
  sevenDayPct?: number;
  sevenDayResetsAt?: number;
  fetchedAt?: number;
  stale: boolean;
}

export interface CacheWarmthData {
  projectDir: string;
  minutesRemaining: "cold" | number;
}

export interface AuditTotals {
  totalEvents: number;
  totalEstimatedSaved: number;
  byClass?: {
    switch?: { count: number; estimatedSaved: number };
    refresh?: { count: number; estimatedSaved: number };
    "post-reset"?: { count: number; estimatedSaved: number };
  };
}

export interface StatusModel {
  profiles: Map<string, ProfileQuotaData>;
  profileLabels: Map<string, string | undefined>;
  cacheWarmth: Map<string, CacheWarmthData>;
  auditTotals?: AuditTotals;
  advisorThresholds: {
    fiveHourPct: number;
    weeklyPct: number;
  };
}

/**
 * Load the warmswap registry (config.json) with XDG_CONFIG_HOME support.
 * Returns profiles list and settings, tolerant of absence.
 */
export function loadRegistry(env?: NodeJS.ProcessEnv): RegistryData {
  const actualEnv = env ?? process.env;
  const configHome =
    actualEnv.XDG_CONFIG_HOME || join(homedir(), ".config");
  const configPath = join(configHome, "warmswap", "config.json");

  if (!existsSync(configPath)) {
    return { profiles: [], settings: {} };
  }

  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);

    // Normalize profiles list format
    const profiles: Profile[] = [];
    if (parsed.profiles && typeof parsed.profiles === "object") {
      for (const [name, config] of Object.entries(parsed.profiles)) {
        const profileConfig = config as any;
        profiles.push({
          name,
          configDir: profileConfig.configDir,
          label: profileConfig.label,
        });
      }
    }

    return {
      profiles,
      settings: parsed.settings,
    };
  } catch {
    return { profiles: [], settings: {} };
  }
}

/**
 * Load quota data from usage-cache.json for a profile's configDir.
 * Returns stale flag (>10min old) and labeled source.
 */
export function loadProfileQuota(configDir: string): ProfileQuotaData {
  const cacheFile = join(configDir, "warmswap", "usage-cache.json");

  if (!existsSync(cacheFile)) {
    return { source: "none", stale: false };
  }

  try {
    const raw = readFileSync(cacheFile, "utf8");
    const data = JSON.parse(raw) as any;

    const fetchedAt = data.fetchedAt;
    const ageMs = Date.now() - fetchedAt;
    const stale = ageMs > 10 * 60 * 1000; // >10min

    // Determine source label from cache
    let source: "live" | "est" | "none" = "none";
    if (data.source === "statusline" || data.source === "oauth") {
      source = "live";
    } else if (data.source === "estimate") {
      source = "est";
    }

    // Extract 5h and 7d percentages
    let fiveHourPct: number | undefined;
    let fiveHourResetsAt: number | undefined;
    let sevenDayPct: number | undefined;
    let sevenDayResetsAt: number | undefined;

    if (data.five_hour) {
      fiveHourPct = data.five_hour.used_percentage;
      if (data.five_hour.resets_at) {
        fiveHourResetsAt = new Date(data.five_hour.resets_at).getTime();
      }
    }

    if (data.seven_day) {
      sevenDayPct = data.seven_day.used_percentage;
      if (data.seven_day.resets_at) {
        sevenDayResetsAt = new Date(data.seven_day.resets_at).getTime();
      }
    }

    return {
      source,
      fiveHourPct,
      fiveHourResetsAt,
      sevenDayPct,
      sevenDayResetsAt,
      fetchedAt,
      stale,
    };
  } catch {
    return { source: "none", stale: false };
  }
}

/**
 * Compute cache warmth for a workspace folder.
 * Finds the newest transcript mtime under <configDir>/projects/<munged>.
 * Munging: replace / with -; also try /private-prefixed variant for macOS.
 */
export function cacheWarmth(
  configDir: string,
  projectDir: string
): CacheWarmthData | null {
  // Munge the project path: / → -
  const munged = projectDir.replace(/\//g, "-");
  const mungedPrivate = (
    "/private" + projectDir
  ).replace(/\//g, "-");

  const projectsBase = join(configDir, "projects");
  if (!existsSync(projectsBase)) {
    // Return cold state instead of null for consistency
    return { projectDir, minutesRemaining: "cold" };
  }

  let transcriptDir: string | null = null;

  // Try munged path first
  const tryPath = join(projectsBase, munged);
  if (existsSync(tryPath)) {
    transcriptDir = tryPath;
  }

  // Try /private-prefixed variant
  if (!transcriptDir) {
    const tryPathPrivate = join(projectsBase, mungedPrivate);
    if (existsSync(tryPathPrivate)) {
      transcriptDir = tryPathPrivate;
    }
  }

  if (!transcriptDir) {
    return { projectDir, minutesRemaining: "cold" };
  }

  // Find newest transcript file under transcriptDir
  try {
    const files = readdirSync(transcriptDir);
    let newestMtime = 0;

    for (const file of files) {
      // Claude Code session transcripts are JSONL files.
      if (file.endsWith(".jsonl") && !file.startsWith(".")) {
        const filePath = join(transcriptDir, file);
        const stat = statSync(filePath);
        if (stat.mtimeMs > newestMtime) {
          newestMtime = stat.mtimeMs;
        }
      }
    }

    if (newestMtime === 0) {
      return { projectDir, minutesRemaining: "cold" };
    }

    // Cache TTL is 60 minutes from the newest transcript mtime
    const ageMs = Date.now() - newestMtime;
    const ttlMs = 60 * 60 * 1000;
    const remainingMs = ttlMs - ageMs;

    if (remainingMs <= 0) {
      return { projectDir, minutesRemaining: "cold" };
    }

    // Clamp: a just-written file can float a hair past the full TTL.
    const minutesRemaining = Math.min(60, Math.max(1, Math.ceil(remainingMs / 60000)));
    return { projectDir, minutesRemaining };
  } catch {
    return { projectDir, minutesRemaining: "cold" };
  }
}

/**
 * Build the status bar text.
 * E.g., "$(arrow-swap) personal 5h 42% · wk 25%"
 * If any profile crosses advisor thresholds, include $(warning) indicator.
 */
export function buildStatusText(model: StatusModel): string {
  if (model.profiles.size === 0) {
    return "$(warning) warmswap: no profiles";
  }

  const advisorThresholds = model.advisorThresholds;

  // Check if any profile crosses thresholds
  let hasWarning = false;
  for (const quota of model.profiles.values()) {
    if (quota.source === "none") continue;
    if (
      quota.fiveHourPct !== undefined &&
      quota.fiveHourPct >= advisorThresholds.fiveHourPct
    ) {
      hasWarning = true;
      break;
    }
    if (
      quota.sevenDayPct !== undefined &&
      quota.sevenDayPct >= advisorThresholds.weeklyPct
    ) {
      hasWarning = true;
      break;
    }
  }

  // Get the first profile (most critical) for display
  // Worst first: sort by utilization descending
  let worstProfile: [string, ProfileQuotaData] | null = null;
  let worstUtil = -1;

  for (const [name, quota] of model.profiles) {
    if (quota.source === "none") continue;
    const util = Math.max(quota.fiveHourPct ?? 0, quota.sevenDayPct ?? 0);
    if (util > worstUtil) {
      worstUtil = util;
      worstProfile = [name, quota];
    }
  }

  if (!worstProfile) {
    return "$(warning) warmswap: no data";
  }

  const [name, quota] = worstProfile;
  const warningIcon = hasWarning ? "$(warning) " : "";

  let statusParts: string[] = [];
  statusParts.push("$(arrow-swap)");
  statusParts.push(name);

  if (quota.fiveHourPct !== undefined) {
    statusParts.push(`5h ${quota.fiveHourPct}%`);
  }
  if (quota.sevenDayPct !== undefined) {
    statusParts.push(`· wk ${quota.sevenDayPct}%`);
  }

  return warningIcon + statusParts.join(" ");
}

/**
 * Build the tooltip markdown for the status bar popover.
 * Shows per-profile quota bars (live/est labeled), reset countdowns,
 * per-project cache-TTL countdowns, savings, and advisor line.
 */
export function buildTooltipMarkdown(model: StatusModel): string {
  let lines: string[] = [];

  // Per-profile section
  if (model.profiles.size > 0) {
    for (const [name, quota] of model.profiles) {
      lines.push(`### ${name}`);

      const label = model.profileLabels.get(name);
      if (label) {
        lines.push(`**Login:** ${label}`);
      }

      if (quota.source === "none") {
        lines.push("_No data available_");
      } else {
        // 5h quota with bar
        if (quota.fiveHourPct !== undefined) {
          const bar = quotaBar(quota.fiveHourPct);
          lines.push(
            `**5h:** ${bar} ${quota.fiveHourPct}% \`${quota.source}\``
          );
          if (quota.fiveHourResetsAt) {
            const resetIn = formatCountdown(quota.fiveHourResetsAt);
            lines.push(`Resets in ${resetIn}`);
          }
        } else {
          lines.push(`**5h:** No data \`${quota.source}\``);
        }

        lines.push("");

        // 7d quota with bar
        if (quota.sevenDayPct !== undefined) {
          const bar = quotaBar(quota.sevenDayPct);
          lines.push(
            `**Weekly:** ${bar} ${quota.sevenDayPct}% \`${quota.source}\``
          );
          if (quota.sevenDayResetsAt) {
            const resetIn = formatCountdown(quota.sevenDayResetsAt);
            lines.push(`Resets in ${resetIn}`);
          }
        } else {
          lines.push(`**Weekly:** No data \`${quota.source}\``);
        }
      }

      lines.push("");
    }
  }

  // Per-project cache warmth
  if (model.cacheWarmth.size > 0) {
    lines.push("### Cache Warmth");
    for (const warmth of model.cacheWarmth.values()) {
      if (typeof warmth.minutesRemaining === "number") {
        lines.push(
          `**${basename(warmth.projectDir)}:** ${warmth.minutesRemaining}m left`
        );
      } else {
        lines.push(`**${basename(warmth.projectDir)}:** cold`);
      }
    }
    lines.push("");
  }

  // Savings section from audit
  if (model.auditTotals && model.auditTotals.totalEstimatedSaved > 0) {
    lines.push("### Savings");
    const parts = [`**~${model.auditTotals.totalEstimatedSaved}** total`];
    if (model.auditTotals.byClass) {
      const classes = [];
      if (model.auditTotals.byClass.switch?.estimatedSaved) {
        classes.push(`switch ${model.auditTotals.byClass.switch.estimatedSaved}`);
      }
      if (model.auditTotals.byClass.refresh?.estimatedSaved) {
        classes.push(`refresh ${model.auditTotals.byClass.refresh.estimatedSaved}`);
      }
      if (model.auditTotals.byClass["post-reset"]?.estimatedSaved) {
        classes.push(`post-reset ${model.auditTotals.byClass["post-reset"].estimatedSaved}`);
      }
      if (classes.length > 0) {
        parts.push(`(${classes.join(" · ")})`);
      }
    }
    lines.push(`**Saved:** ${parts.join(" ")}`);
    lines.push("");
  }

  // Advisor line if any profile crosses thresholds
  const advisorThresholds = model.advisorThresholds;
  let advisoryText: string | null = null;

  for (const quota of model.profiles.values()) {
    if (quota.source === "none") continue;
    if (
      quota.fiveHourPct !== undefined &&
      quota.fiveHourPct >= advisorThresholds.fiveHourPct
    ) {
      advisoryText = `⚠️ **High 5h usage (${quota.fiveHourPct}%).** Consider handoff for next context.`;
      break;
    }
    if (
      quota.sevenDayPct !== undefined &&
      quota.sevenDayPct >= advisorThresholds.weeklyPct
    ) {
      advisoryText = `⚠️ **High weekly usage (${quota.sevenDayPct}%).** Consider handoff for next context.`;
      break;
    }
  }

  if (advisoryText) {
    lines.push(advisoryText);
    lines.push("");
  }

  // Footer hint
  lines.push("_Click for actions: switch, keep warm, dashboard, refresh_");

  return lines.join("\n");
}

/**
 * Parse audit --json output and extract total savings and breakdown by class.
 */
export function parseAuditTotals(jsonStr: string): AuditTotals {
  try {
    const data = JSON.parse(jsonStr);
    return {
      totalEvents: data.totalEvents ?? 0,
      totalEstimatedSaved: data.totalEstimatedSaved ?? 0,
      byClass: data.byClass,
    };
  } catch {
    return { totalEvents: 0, totalEstimatedSaved: 0 };
  }
}

/**
 * Render a 10-cell unicode quota bar.
 */
function quotaBar(pct: number): string {
  const cells = Math.min(10, Math.max(0, Math.round((pct / 100) * 10)));
  const full = "▓".repeat(cells);
  const empty = "░".repeat(10 - cells);
  return `${full}${empty}`;
}

/**
 * Format milliseconds until reset as "Xh Ym" or "Xm".
 */
function formatCountdown(resetAtMs: number): string {
  const now = Date.now();
  const remainingMs = Math.max(0, resetAtMs - now);

  const hours = Math.floor(remainingMs / (60 * 60 * 1000));
  const minutes = Math.floor(
    (remainingMs % (60 * 60 * 1000)) / (60 * 1000)
  );

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/**
 * Determine which projects should show an expiry toast.
 * Returns array of (folder, minutesRemaining) pairs that should toast.
 * One toast per folder per warm-period (keyed by folder + mtime).
 * Fires at or below threshold, not above, not twice for same key.
 */
export function expiryToastDecisions(
  warmthMap: Map<string, CacheWarmthData>,
  thresholdMinutes: number,
  alreadyToastedKeys: Set<string>
): Array<{ folder: string; minutesRemaining: number }> {
  const decisions: Array<{ folder: string; minutesRemaining: number }> = [];

  if (thresholdMinutes <= 0) {
    return decisions; // Toast disabled
  }

  for (const [projectDir, warmth] of warmthMap) {
    // Only consider warm caches with numeric remainingMinutes
    if (typeof warmth.minutesRemaining !== "number") {
      continue;
    }

    // Key = folder + minutesRemaining (to detect new warm period)
    const key = `${projectDir}:${warmth.minutesRemaining}`;

    // Already toasted this period? Skip.
    if (alreadyToastedKeys.has(key)) {
      continue;
    }

    // At or below threshold? Toast.
    if (warmth.minutesRemaining <= thresholdMinutes) {
      decisions.push({
        folder: basename(projectDir),
        minutesRemaining: warmth.minutesRemaining,
      });
      alreadyToastedKeys.add(key);
    }
  }

  return decisions;
}

/**
 * Extract basename from path (last component).
 */
function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
