import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { lodestoneConfigPath } from "./paths.js";

export interface UsageBudgetSegment {
  utilization?: number | undefined;
  resets_at?: string | undefined;
  used_percentage?: number | undefined;
  resets_at_ts?: number | undefined;
}

export interface UsageCacheData {
  fetchedAt: number;
  source: "statusline" | "oauth";
  five_hour?: UsageBudgetSegment | undefined;
  seven_day?: UsageBudgetSegment | undefined;
  seven_day_opus?: UsageBudgetSegment | null | undefined;
  seven_day_sonnet?: UsageBudgetSegment | null | undefined;
  extra_usage?: {
    is_enabled?: boolean | undefined;
    monthly_limit?: number | null | undefined;
    used_credits?: number | null | undefined;
    utilization?: number | null | undefined;
  } | undefined;
}

export interface QuotaResult {
  source: "statusline" | "oauth" | "estimate";
  fiveHourUtilization?: number | undefined;
  fiveHourResetsAt?: number | undefined;
  sevenDayUtilization?: number | undefined;
  sevenDayResetsAt?: number | undefined;
  hasPacing?: boolean | undefined;
  /** How old the figures are. 0 = fetched just now. Surfaces as "(3m ago)". */
  ageSeconds?: number | undefined;
}

/** A quota climbing during heavy work goes visibly wrong within minutes. */
const FRESH_MS = 90 * 1000;         // bridge this new is as good as live
const USABLE_MS = 15 * 60 * 1000;   // older than this, prefer an estimate
const OAUTH_TTL_MS = 2 * 60 * 1000; // how long the endpoint's answer stays good

function readJsonIfFresh(path: string, maxAgeMs: number): UsageCacheData | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as UsageCacheData;
    return Date.now() - data.fetchedAt > maxAgeMs ? undefined : data;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, data: UsageCacheData): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
  } catch {
    // never fatal
  }
}

/**
 * Cache bridge path for statusline-driven real data
 */
export function usageCachePath(configDir: string): string {
  return join(configDir, "lodestone", "usage-cache.json");
}

/**
 * Advisor state path for debounce tracking
 */
/** The endpoint's answer lives in its own file: the statusline rewrites the
 *  bridge on every render and would otherwise clobber it within seconds. */
export function oauthCachePath(configDir: string): string {
  return join(configDir, "lodestone", "usage-live.json");
}

export function advisorStatePath(configDir: string): string {
  return join(configDir, "lodestone", "advisor-state.json");
}

/**
 * Read usage cache if fresh (<10min old)
 */
export function readUsageCache(
  configDir: string,
  maxAgeMs: number = USABLE_MS
): UsageCacheData | undefined {
  const cachePath = usageCachePath(configDir);
  if (!existsSync(cachePath)) {
    return undefined;
  }

  try {
    const raw = readFileSync(cachePath, "utf8");
    const data = JSON.parse(raw) as UsageCacheData;
    if (Date.now() - data.fetchedAt > maxAgeMs) {
      return undefined;
    }
    return data;
  } catch {
    return undefined;
  }
}

/**
 * Write usage cache from statusline rate_limits
 */
function toEpochSeconds(v: string | number | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "number") return v > 1e12 ? Math.round(v / 1000) : v;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : Math.round(ms / 1000);
}

/** The statusline speaks {used_percentage, resets_at_ts}; the usage endpoint
 *  speaks {utilization, resets_at}. Readers should never have to know that, so
 *  every write is normalized to the first shape here. */
function normalizeSegment(
  seg: UsageBudgetSegment | null | undefined
): UsageBudgetSegment | undefined {
  if (!seg) return undefined;
  const pct = seg.used_percentage ?? seg.utilization;
  const ts = seg.resets_at_ts ?? toEpochSeconds(seg.resets_at);
  if (pct === undefined && ts === undefined) return undefined;
  const out: UsageBudgetSegment = {};
  if (pct !== undefined) out.used_percentage = Math.round(pct);
  if (ts !== undefined) out.resets_at_ts = ts;
  return out;
}

export function writeUsageCache(
  configDir: string,
  data: Partial<UsageCacheData>
): void {
  const cachePath = usageCachePath(configDir);
  const cacheDir = dirname(cachePath);

  try {
    mkdirSync(cacheDir, { recursive: true });

    const full: UsageCacheData = {
      ...data,
      fetchedAt: Date.now(),
      source: data.source ?? "statusline",
      five_hour: normalizeSegment(data.five_hour),
      seven_day: normalizeSegment(data.seven_day),
    };

    writeFileSync(cachePath, JSON.stringify(full, null, 2), "utf8");
  } catch {
    // Silent fail on write
  }
}

/**
 * Fetch real quota via OAuth endpoint for a profile.
 * Reads token from Keychain/credentials.json, never stores it.
 * Returns undefined on error (permission denied, 429, network error, no token).
 */
export async function fetchOAuthQuota(
  configDir: string,
  claudeVersion: string | undefined,
  fetchImpl?: typeof global.fetch
): Promise<UsageCacheData | undefined> {
  const fetch = fetchImpl || global.fetch;
  const token = readOAuthToken(configDir);

  if (!token) {
    return undefined;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout

    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": `claude-code/${claudeVersion || "unknown"}`,
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.status === 429) {
      // Rate limited, degrade silently
      return undefined;
    }

    if (!response.ok) {
      return undefined;
    }

    const json = (await response.json()) as Partial<UsageCacheData>;

    return {
      fetchedAt: Date.now(),
      source: "oauth",
      five_hour: json.five_hour,
      seven_day: json.seven_day,
      seven_day_opus: json.seven_day_opus,
      seven_day_sonnet: json.seven_day_sonnet,
      extra_usage: json.extra_usage,
    };
  } catch {
    // Network error, timeout, or abort
    return undefined;
  }
}

/**
 * Read OAuth token from OS keychain or credentials.json
 * Never log or return the token in error messages
 */
function readOAuthToken(configDir: string): string | undefined {
  // Try credentials.json first (Linux / fallback)
  const credPath = join(configDir, ".credentials.json");
  if (existsSync(credPath)) {
    try {
      const raw = readFileSync(credPath, "utf8");
      const creds = JSON.parse(raw) as {
        claudeAiOauth?: { accessToken?: string };
      };
      return creds.claudeAiOauth?.accessToken;
    } catch {
      // Silently skip
    }
  }

  // macOS Keychain fallback — ONLY for the default ~/.claude profile. The
  // un-scoped "Claude Code-credentials" item belongs to the default config
  // dir; returning it for another profile would report the wrong account's
  // quota. Non-default profiles on macOS degrade to estimates until their
  // hash-keyed Keychain entry naming is verified (live-validation task).
  const isDefaultDir =
    process.env.HOME !== undefined &&
    configDir === join(process.env.HOME, ".claude");
  if (process.platform !== "darwin" || !isDefaultDir) {
    return undefined;
  }
  try {
    const result = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w',
      { encoding: "utf8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"] }
    );

    if (result && result.trim()) {
      try {
        const parsed = JSON.parse(result) as {
          claudeAiOauth?: { accessToken?: string };
        };
        return parsed.claudeAiOauth?.accessToken;
      } catch {
        // Not JSON, skip
      }
    }
  } catch {
    // Command failed, no token
  }

  return undefined;
}

/**
 * Get current quota for a profile.
 * Freshness order: bridge (<10min) → oauth (if opted in) → estimate (labeled)
 */
export async function getQuota(
  configDir: string,
  claudeVersion: string | undefined,
  isRealUsageOptedIn: boolean,
  fetchImpl?: typeof global.fetch
): Promise<QuotaResult> {
  const asBridge = (data: UsageCacheData): QuotaResult => ({
    source: "statusline",
    fiveHourUtilization: data.five_hour?.used_percentage,
    fiveHourResetsAt: data.five_hour?.resets_at_ts,
    sevenDayUtilization: data.seven_day?.used_percentage,
    sevenDayResetsAt: data.seven_day?.resets_at_ts,
    hasPacing: true,
    ageSeconds: Math.max(0, Math.round((Date.now() - data.fetchedAt) / 1000)),
  });

  // 1. Opted into real usage: the endpoint is the authority. Claude Code's own
  //    rate_limits lag behind it (they are whatever the last API response said),
  //    which is why our numbers used to read a few points under the truth.
  //    Its answer is cached for two minutes: enough to stay current, far below
  //    what the endpoint rate-limits at.
  if (isRealUsageOptedIn) {
    const cachedLive = readJsonIfFresh(oauthCachePath(configDir), OAUTH_TTL_MS);
    if (cachedLive) {
      return asBridge(cachedLive);
    }
    const oauthData = await fetchOAuthQuota(configDir, claudeVersion, fetchImpl);
    if (oauthData) {
      writeJson(oauthCachePath(configDir), {
        ...oauthData,
        five_hour: normalizeSegment(oauthData.five_hour),
        seven_day: normalizeSegment(oauthData.seven_day),
      });
      return {
        source: "oauth",
        fiveHourUtilization: normalizeSegment(oauthData.five_hour)?.used_percentage,
        fiveHourResetsAt: normalizeSegment(oauthData.five_hour)?.resets_at_ts,
        sevenDayUtilization: normalizeSegment(oauthData.seven_day)?.used_percentage,
        sevenDayResetsAt: normalizeSegment(oauthData.seven_day)?.resets_at_ts,
        ageSeconds: 0,
      };
    }
    // Endpoint unavailable: fall through to whatever the statusline last saw.
  }

  // 2. The statusline's bridge, free and usually seconds old.
  const fresh = readUsageCache(configDir, FRESH_MS);
  if (fresh) {
    return asBridge(fresh);
  }

  // 3. An older entry still beats a guess, but it is tagged with its age.
  const stale = readUsageCache(configDir, USABLE_MS);
  if (stale) {
    return asBridge(stale);
  }

  // 4. Nothing real to show.
  return {
    source: "estimate",
  };
}
