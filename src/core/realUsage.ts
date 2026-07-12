import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { cchandoffConfigPath } from "./paths.js";

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
}

/**
 * Cache bridge path for statusline-driven real data
 */
export function usageCachePath(configDir: string): string {
  return join(configDir, "cchandoff", "usage-cache.json");
}

/**
 * Advisor state path for debounce tracking
 */
export function advisorStatePath(configDir: string): string {
  return join(configDir, "cchandoff", "advisor-state.json");
}

/**
 * Read usage cache if fresh (<10min old)
 */
export function readUsageCache(configDir: string): UsageCacheData | undefined {
  const cachePath = usageCachePath(configDir);
  if (!existsSync(cachePath)) {
    return undefined;
  }

  try {
    const raw = readFileSync(cachePath, "utf8");
    const data = JSON.parse(raw) as UsageCacheData;

    // Check freshness: <10min old
    const ageMs = Date.now() - data.fetchedAt;
    if (ageMs > 10 * 60 * 1000) {
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
export function writeUsageCache(
  configDir: string,
  data: Partial<UsageCacheData>
): void {
  const cachePath = usageCachePath(configDir);
  const cacheDir = dirname(cachePath);

  try {
    mkdirSync(cacheDir, { recursive: true });

    const full: UsageCacheData = {
      fetchedAt: Date.now(),
      source: data.source ?? "statusline",
      ...data,
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
  // Try bridge first (from statusline, always fresh if present)
  const bridgeData = readUsageCache(configDir);
  if (bridgeData) {
    return {
      source: "statusline",
      fiveHourUtilization: bridgeData.five_hour?.used_percentage,
      fiveHourResetsAt: bridgeData.five_hour?.resets_at_ts,
      sevenDayUtilization: bridgeData.seven_day?.used_percentage,
      sevenDayResetsAt: bridgeData.seven_day?.resets_at_ts,
      hasPacing: true,
    };
  }

  // Try OAuth if opted in
  if (isRealUsageOptedIn) {
    const oauthData = await fetchOAuthQuota(configDir, claudeVersion, fetchImpl);
    if (oauthData) {
      // Persist to the bridge so the 10-minute freshness gate throttles
      // subsequent calls (ADR-007: never poll the endpoint per-prompt).
      writeUsageCache(configDir, oauthData);
      return {
        source: "oauth",
        fiveHourUtilization: oauthData.five_hour?.utilization,
        fiveHourResetsAt: oauthData.five_hour?.resets_at
          ? new Date(oauthData.five_hour.resets_at).getTime() / 1000
          : undefined,
        sevenDayUtilization: oauthData.seven_day?.utilization,
        sevenDayResetsAt: oauthData.seven_day?.resets_at
          ? new Date(oauthData.seven_day.resets_at).getTime() / 1000
          : undefined,
      };
    }
  }

  // Fallback: estimate (caller provides this)
  return {
    source: "estimate",
  };
}
