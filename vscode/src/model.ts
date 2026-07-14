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
 * Load the lodestone registry (config.json) with XDG_CONFIG_HOME support.
 * Returns profiles list and settings, tolerant of absence.
 */
export function loadRegistry(env?: NodeJS.ProcessEnv): RegistryData {
  const actualEnv = env ?? process.env;
  const configHome =
    actualEnv.XDG_CONFIG_HOME || join(homedir(), ".config");
  const configPath = join(configHome, "lodestone", "config.json");

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
  const cacheFile = join(configDir, "lodestone", "usage-cache.json");

  if (!existsSync(cacheFile)) {
    return { source: "none", stale: false };
  }

  try {
    const raw = readFileSync(cacheFile, "utf8");
    const data = JSON.parse(raw) as any;

    const fetchedAt = data.fetchedAt;
    const ageMs = Date.now() - fetchedAt;
    const stale = ageMs > 3 * 60 * 1000; // a quota moves fast; 3 min is already old

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

    // The bridge stores {used_percentage, resets_at_ts (epoch seconds)}. Reading
    // a non-existent "resets_at" is why every countdown rendered as "-". The
    // older ISO field is still accepted so an old cache file keeps working.
    const readSeg = (seg: any): [number | undefined, number | undefined] => {
      if (!seg) return [undefined, undefined];
      const pct = seg.used_percentage ?? seg.utilization;
      let ts: number | undefined;
      if (typeof seg.resets_at_ts === "number") {
        ts = seg.resets_at_ts;
      } else if (seg.resets_at) {
        const ms = Date.parse(seg.resets_at);
        if (!Number.isNaN(ms)) ts = Math.round(ms / 1000);
      }
      return [pct, ts];
    };

    [fiveHourPct, fiveHourResetsAt] = readSeg(data.five_hour);
    [sevenDayPct, sevenDayResetsAt] = readSeg(data.seven_day);
    // These arrive as floats (a real render showed 7.000000000000001%).
    if (fiveHourPct !== undefined) fiveHourPct = Math.round(fiveHourPct);
    if (sevenDayPct !== undefined) sevenDayPct = Math.round(sevenDayPct);

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
  // Claude Code's munge replaces every character that is not ASCII
  // alphanumeric or `-` with `-` (verified against real ~/.claude/projects
  // entries; anthropics/claude-code#19972). Replacing only `/` meant any
  // workspace with a space, dot or underscore in its path munged to a
  // directory that does not exist, and its cache showed "cold" forever.
  // Mirrors mungeCwd in the CLI's src/core/paths.ts — keep the two in step.
  const mungeCwd = (p: string): string => p.replace(/[^A-Za-z0-9-]/g, "-");
  const munged = mungeCwd(projectDir);
  const mungedPrivate = mungeCwd("/private" + projectDir);

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
    return "$(warning) lodestone: no profiles";
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
    return "$(warning) lodestone: no data";
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
 * Shows a proper quota panel with table, colored emoji bars, cache warmth,
 * savings breakdown, advisor line, and action hint.
 */
export function buildTooltipMarkdown(model: StatusModel): string {
  let lines: string[] = [];

  lines.push("### Lodestone");
  lines.push("");

  // Per-profile quota table
  if (model.profiles.size > 0) {
    // Check if we have any real data
    let hasData = false;
    for (const quota of model.profiles.values()) {
      if (quota.source !== "none") {
        hasData = true;
        break;
      }
    }

    for (const [name, quota] of model.profiles) {
      lines.push(`**${name}**`);
      lines.push("");

      if (quota.source === "none") {
        lines.push("no data");
        lines.push("");
        continue;
      }

      lines.push("| Window | Usage | Resets |");
      lines.push("| --- | --- | --- |");

      const row = (
        label: string,
        pct: number | undefined,
        resetsAt: number | undefined
      ) => {
        if (pct === undefined) {
          lines.push(`| ${label} | no data | - |`);
          return;
        }
        const tag = quota.stale ? "est" : quota.source;
        const resets = resetsAt ? formatCountdown(resetsAt) : "-";
        lines.push(`| ${label} | ${quotaEmojiBar(pct)} ${pct}% \`${tag}\` | ${resets} |`);
      };

      row("5-hour", quota.fiveHourPct, quota.fiveHourResetsAt);
      row("Weekly", quota.sevenDayPct, quota.sevenDayResetsAt);
      lines.push("");
    }
  }

  // Per-project cache warmth
  if (model.cacheWarmth.size > 0) {
    for (const warmth of model.cacheWarmth.values()) {
      const folderName = basename(warmth.projectDir);
      if (typeof warmth.minutesRemaining === "number") {
        lines.push(`**Cache:** ${folderName}: ${warmth.minutesRemaining}m left`);
      } else {
        lines.push(`**Cache:** ${folderName}: cold`);
      }
    }
  }

  // Savings section from audit
  if (model.auditTotals && model.auditTotals.totalEstimatedSaved > 0) {
    const savingsLabel = formatTokenCount(model.auditTotals.totalEstimatedSaved);
    const parts = [savingsLabel];
    if (model.auditTotals.byClass) {
      const classes = [];
      if (model.auditTotals.byClass.switch?.estimatedSaved) {
        classes.push(`switch ${model.auditTotals.byClass.switch.count}`);
      }
      if (model.auditTotals.byClass.refresh?.estimatedSaved) {
        classes.push(`refresh ${model.auditTotals.byClass.refresh.count}`);
      }
      if (model.auditTotals.byClass["post-reset"]?.estimatedSaved) {
        classes.push(`post-reset ${model.auditTotals.byClass["post-reset"].count}`);
      }
      if (classes.length > 0) {
        parts.push(`(${classes.join(" · ")})`);
      }
    }
    lines.push(`**Saved:** ~${parts.join(" ")}`);
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
  }

  // Footer hint
  lines.push("");
  lines.push("_Click for actions_");

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
 * Render a 10-cell emoji quota bar with color-coding.
 * Under 50%: green (🟩)
 * 50-84%: orange (🟧)
 * 85%+: red (🟥)
 * Empty cells: white (⬜)
 */
function quotaEmojiBar(pct: number): string {
  const filledCells = Math.min(10, Math.max(0, Math.round((pct / 100) * 10)));
  const emptyCells = 10 - filledCells;

  let filled = "";
  if (pct < 50) {
    filled = "🟩".repeat(filledCells);
  } else if (pct < 85) {
    filled = "🟧".repeat(filledCells);
  } else {
    filled = "🟥".repeat(filledCells);
  }

  const empty = "⬜".repeat(emptyCells);
  return `${filled}${empty}`;
}

/**
 * Format a token count as a string with abbreviated units (K, M).
 */
function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = (tokens / 1_000_000).toFixed(1);
    return `${m}M tokens`;
  } else if (tokens >= 1_000) {
    const k = (tokens / 1_000).toFixed(0);
    return `${k}k tokens`;
  }
  return `${tokens} tokens`;
}

/**
 * Format milliseconds until reset as "Xh Ym" or "Xm".
 */
function formatCountdown(resetAt: number): string {
  // rate_limits.resets_at is Unix epoch SECONDS. Reading it as milliseconds
  // made every countdown clamp to "0m".
  const resetMs = resetAt < 1e12 ? resetAt * 1000 : resetAt;
  const now = Date.now();
  const remainingMs = Math.max(0, resetMs - now);

  const hours = Math.floor(remainingMs / (60 * 60 * 1000));
  const minutes = Math.floor(
    (remainingMs % (60 * 60 * 1000)) / (60 * 1000)
  );

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
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
