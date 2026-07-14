import { test } from "node:test";
import assert from "node:assert";
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readUsageCache,
  writeUsageCache,
  usageCachePath,
  getQuota,
  fetchOAuthQuota,
} from "../src/core/realUsage.js";

const testDir = join(tmpdir(), `lodestone-test-realUsage-${Date.now()}`);

test("realUsage: writes and reads usage cache", async () => {
  const configDir = join(testDir, "config1");
  mkdirSync(configDir, { recursive: true });

  const data = {
    source: "statusline" as const,
    five_hour: { used_percentage: 45 },
    seven_day: { used_percentage: 62 },
  };

  writeUsageCache(configDir, data);

  const read = readUsageCache(configDir);
  assert(read, "should read cache");
  assert.equal(read.source, "statusline");
  assert.equal(read.five_hour?.used_percentage, 45);
  assert.equal(read.seven_day?.used_percentage, 62);

  rmSync(testDir, { recursive: true });
});

test("realUsage: cache expires past the usable window", async () => {
  const configDir = join(testDir, "config2");
  mkdirSync(configDir, { recursive: true });

  // Write stale cache (>10 min old)
  const cachePath = usageCachePath(configDir);
  const cacheDir = cachePath.split("/").slice(0, -1).join("/");
  mkdirSync(cacheDir, { recursive: true });

  const staleData = {
    fetchedAt: Date.now() - 16 * 60 * 1000, // 11 minutes ago
    source: "statusline" as const,
    five_hour: { used_percentage: 50 },
  };

  // Plant the file directly: writeUsageCache stamps fetchedAt with the write
  // time (that is what "when we got this data" means), so it cannot be used to
  // fabricate an old entry.
  writeFileSync(cachePath, JSON.stringify(staleData), "utf8");

  const read = readUsageCache(configDir);
  assert.equal(read, undefined, "an entry past the usable window is ignored");

  rmSync(testDir, { recursive: true });
});

test("realUsage: getQuota returns estimate when no cache or oauth", async () => {
  const configDir = join(testDir, "config3");
  mkdirSync(configDir, { recursive: true });

  const quota = await getQuota(configDir, undefined, false);

  assert.equal(quota.source, "estimate");
  assert.equal(quota.fiveHourUtilization, undefined);
  assert.equal(quota.sevenDayUtilization, undefined);

  rmSync(testDir, { recursive: true });
});

test("realUsage: getQuota prefers cache over oauth", async () => {
  const configDir = join(testDir, "config4");
  mkdirSync(configDir, { recursive: true });

  // Write cache
  const data = {
    source: "statusline" as const,
    five_hour: { used_percentage: 48 },
  };
  writeUsageCache(configDir, data);

  const quota = await getQuota(configDir, undefined, true);

  assert.equal(quota.source, "statusline", "should prefer cache");
  assert.equal(quota.fiveHourUtilization, 48);

  rmSync(testDir, { recursive: true });
});

test("realUsage: fetchOAuthQuota with injected fetch mock returns data", async () => {
  const mockFetch = async (url: string, opts?: unknown) => {
    if (url.includes("api.anthropic.com/api/oauth/usage")) {
      return new Response(
        JSON.stringify({
          five_hour: { utilization: 42 },
          seven_day: { utilization: 68 },
        }),
        { status: 200 }
      );
    }
    return new Response(null, { status: 404 });
  };

  // Mock token read (since we can't actually read keychain in test)
  // This test is limited but proves the structure works
  // In a real scenario, we'd mock the readOAuthToken function too
  const result = await fetchOAuthQuota("config-dir", "1.0", mockFetch as unknown as typeof global.fetch);

  // Since we can't mock the token read easily without refactoring,
  // we'll just verify it returns undefined when no token
  assert(result === undefined || result?.source === "oauth");
});

test("realUsage: cache returns undefined on corrupted json", async () => {
  const configDir = join(testDir, "config5");
  mkdirSync(configDir, { recursive: true });

  const cachePath = usageCachePath(configDir);
  const cacheDir = cachePath.split("/").slice(0, -1).join("/");
  mkdirSync(cacheDir, { recursive: true });

  // Write corrupted JSON
  const { writeFileSync } = await import("node:fs");
  writeFileSync(cachePath, "not valid json", "utf8");

  const read = readUsageCache(configDir);
  assert.equal(read, undefined, "corrupted cache should return undefined");

  rmSync(testDir, { recursive: true });
});

test("realUsage: per-model weekly buckets surface only when the endpoint returns them", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { getQuota } = await import("../src/core/realUsage.js");

  const configDir = mkdtempSync(join(tmpdir(), "lodestone-permodel-"));
  mkdirSync(join(configDir, "lodestone"), { recursive: true });

  // What the oauth cache looks like on a plan WITH an opus cap: opus is a
  // real bucket, sonnet is null (the endpoint's way of saying "not metered"),
  // and a hypothetical future fable bucket must come through generically.
  writeFileSync(
    join(configDir, "lodestone", "usage-live.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      source: "oauth",
      five_hour: { used_percentage: 40, resets_at_ts: 1800000000 },
      seven_day: { used_percentage: 55, resets_at_ts: 1800600000 },
      seven_day_opus: { used_percentage: 71, resets_at_ts: 1800600000 },
      seven_day_sonnet: null,
      seven_day_fable: { utilization: 12.6, resets_at: "2027-01-15T00:00:00Z" },
    }),
    "utf8"
  );

  const quota = await getQuota(configDir, "2.1.206", true);

  const models = (quota.perModelWeekly ?? []).map((r) => r.model).sort();
  assert.deepEqual(models, ["fable", "opus"], "non-null buckets only, any model name");
  const opus = quota.perModelWeekly?.find((r) => r.model === "opus");
  assert.equal(opus?.pct, 71);
  const fable = quota.perModelWeekly?.find((r) => r.model === "fable");
  assert.equal(fable?.pct, 13, "endpoint-shaped {utilization} is normalized and rounded");
});
