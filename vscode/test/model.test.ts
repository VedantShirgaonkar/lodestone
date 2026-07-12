import { test } from "node:test";
import * as assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  loadRegistry,
  loadProfileQuota,
  cacheWarmth,
  buildStatusText,
  buildTooltipMarkdown,
  parseAuditTotals,
  StatusModel,
} from "../src/model.js";
import { tmpdir } from "node:os";

/**
 * Test: loadRegistry with missing file
 */
test("loadRegistry: missing file returns empty list", () => {
  const tempEnv = { XDG_CONFIG_HOME: "/nonexistent" };
  const result = loadRegistry(tempEnv);
  assert.deepStrictEqual(result.profiles, []);
});

/**
 * Test: loadRegistry with valid config.json
 */
test("loadRegistry: parses valid config.json", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "warmswap-test-"));
  const configDir = join(tmpDir, "warmswap");
  mkdirSync(configDir, { recursive: true });

  const configPath = join(configDir, "config.json");
  const config = {
    schema: 1,
    profiles: {
      personal: {
        configDir: "/Users/test/.claude",
        label: "Personal",
      },
      work: {
        configDir: "/Users/test/.claude-work",
        label: "Work",
      },
    },
    settings: {
      advisor: {
        fiveHourPct: 85,
        weeklyPct: 90,
      },
    },
  };

  writeFileSync(configPath, JSON.stringify(config));

  const result = loadRegistry({ XDG_CONFIG_HOME: tmpDir });
  assert.strictEqual(result.profiles.length, 2);
  assert.strictEqual(result.profiles[0].name, "personal");
  assert.strictEqual(result.profiles[1].name, "work");
  assert.deepStrictEqual(result.settings?.advisor, {
    fiveHourPct: 85,
    weeklyPct: 90,
  });
});

/**
 * Test: loadProfileQuota with missing usage-cache.json
 */
test("loadProfileQuota: missing cache file returns 'none'", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "warmswap-test-"));
  const result = loadProfileQuota(tmpDir);
  assert.strictEqual(result.source, "none");
  assert.strictEqual(result.stale, false);
});

/**
 * Test: loadProfileQuota with fresh cache (live data)
 */
test("loadProfileQuota: parses fresh usage-cache.json", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "warmswap-test-"));
  const warmswapDir = join(tmpDir, "warmswap");
  mkdirSync(warmswapDir, { recursive: true });

  const cacheFile = join(warmswapDir, "usage-cache.json");
  const cache = {
    fetchedAt: Date.now(),
    source: "statusline",
    five_hour: {
      used_percentage: 42,
      resets_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
    seven_day: {
      used_percentage: 25,
      resets_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
  };

  writeFileSync(cacheFile, JSON.stringify(cache));

  const result = loadProfileQuota(tmpDir);
  assert.strictEqual(result.source, "live");
  assert.strictEqual(result.fiveHourPct, 42);
  assert.strictEqual(result.sevenDayPct, 25);
  assert.strictEqual(result.stale, false);
  assert.ok(result.fiveHourResetsAt);
  assert.ok(result.sevenDayResetsAt);
});

/**
 * Test: loadProfileQuota with stale cache (>10min old)
 */
test("loadProfileQuota: marks cache >10min old as stale", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "warmswap-test-"));
  const warmswapDir = join(tmpDir, "warmswap");
  mkdirSync(warmswapDir, { recursive: true });

  const cacheFile = join(warmswapDir, "usage-cache.json");
  const cache = {
    fetchedAt: Date.now() - 11 * 60 * 1000, // 11 minutes ago
    source: "statusline",
    five_hour: {
      used_percentage: 42,
    },
  };

  writeFileSync(cacheFile, JSON.stringify(cache));

  const result = loadProfileQuota(tmpDir);
  assert.strictEqual(result.stale, true);
});

/**
 * Test: cacheWarmth with no transcripts returns 'cold'
 */
test("cacheWarmth: no transcripts returns cold", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "warmswap-test-"));
  const projectDir = "/Users/test/myproject";

  const result = cacheWarmth(tmpDir, projectDir);
  assert.ok(result);
  assert.strictEqual(result.minutesRemaining, "cold");
});

/**
 * Test: cacheWarmth with fresh transcript
 */
test("cacheWarmth: fresh transcript shows minutes remaining", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "warmswap-test-"));
  const projectDir = "/Users/test/myproject";

  // Munge the path
  const munged = projectDir.replace(/\//g, "-");
  const projectsDir = join(tmpDir, "projects", munged);
  mkdirSync(projectsDir, { recursive: true });

  // Create a recent transcript — real session files are .jsonl
  const transcriptFile = join(projectsDir, "sess-1.jsonl");
  writeFileSync(transcriptFile, '{"type":"user"}\n');
  // A stray markdown file must NOT count as a transcript
  writeFileSync(join(projectsDir, "notes.md"), "# not a transcript");

  const result = cacheWarmth(tmpDir, projectDir);
  assert.ok(result);
  assert.ok(typeof result.minutesRemaining === "number");
  assert.ok(result.minutesRemaining >= 58, "fresh file ≈ full TTL");
  assert.ok(result.minutesRemaining <= 60, "clamped at the 60m TTL");
});

/**
 * Test: cacheWarmth with /private prefix (macOS)
 */
test("cacheWarmth: falls back to /private-prefixed variant", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "warmswap-test-"));
  const projectDir = "/Users/test/myproject";

  // Create munged path with /private prefix
  const mungedPrivate = ("/private" + projectDir).replace(/\//g, "-");
  const projectsDir = join(tmpDir, "projects", mungedPrivate);
  mkdirSync(projectsDir, { recursive: true });

  // Create a recent transcript — real session files are .jsonl
  const transcriptFile = join(projectsDir, "sess-1.jsonl");
  writeFileSync(transcriptFile, '{"type":"user"}\n');

  const result = cacheWarmth(tmpDir, projectDir);
  assert.ok(result);
  assert.ok(typeof result.minutesRemaining === "number");
});

/**
 * Test: buildStatusText with no profiles
 */
test("buildStatusText: no profiles shows warning", () => {
  const model: StatusModel = {
    profiles: new Map(),
    profileLabels: new Map(),
    cacheWarmth: new Map(),
    advisorThresholds: { fiveHourPct: 85, weeklyPct: 90 },
  };

  const text = buildStatusText(model);
  assert.ok(text.includes("warmswap"));
  assert.ok(text.includes("no profiles"));
});

/**
 * Test: buildStatusText with live data, below threshold
 */
test("buildStatusText: live data without warning", () => {
  const model: StatusModel = {
    profiles: new Map([
      [
        "personal",
        {
          source: "live",
          fiveHourPct: 42,
          sevenDayPct: 25,
          stale: false,
        },
      ],
    ]),
    profileLabels: new Map([["personal", undefined]]),
    cacheWarmth: new Map(),
    advisorThresholds: { fiveHourPct: 85, weeklyPct: 90 },
  };

  const text = buildStatusText(model);
  assert.ok(text.includes("personal"));
  assert.ok(text.includes("5h 42%"));
  assert.ok(text.includes("wk 25%"));
  assert.strictEqual(text.includes("$(warning)"), false);
});

/**
 * Test: buildStatusText with high 5h usage, includes warning
 */
test("buildStatusText: high 5h usage includes warning", () => {
  const model: StatusModel = {
    profiles: new Map([
      [
        "personal",
        {
          source: "live",
          fiveHourPct: 87,
          sevenDayPct: 25,
          stale: false,
        },
      ],
    ]),
    profileLabels: new Map([["personal", undefined]]),
    cacheWarmth: new Map(),
    advisorThresholds: { fiveHourPct: 85, weeklyPct: 90 },
  };

  const text = buildStatusText(model);
  assert.ok(text.includes("$(warning)"));
});

/**
 * Test: buildTooltipMarkdown with all data
 */
test("buildTooltipMarkdown: renders complete popover", () => {
  const model: StatusModel = {
    profiles: new Map([
      [
        "personal",
        {
          source: "live",
          fiveHourPct: 42,
          fiveHourResetsAt: Date.now() + 60 * 60 * 1000,
          sevenDayPct: 25,
          sevenDayResetsAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
          stale: false,
        },
      ],
    ]),
    profileLabels: new Map([["personal", "user@example.com"]]),
    cacheWarmth: new Map([
      [
        "/Users/test/myproject",
        { projectDir: "/Users/test/myproject", minutesRemaining: 30 },
      ],
    ]),
    auditTotals: { totalEvents: 5, totalEstimatedSaved: 50000 },
    advisorThresholds: { fiveHourPct: 85, weeklyPct: 90 },
  };

  const md = buildTooltipMarkdown(model);
  assert.ok(md.includes("personal"));
  assert.ok(md.includes("5h"));
  assert.ok(md.includes("42%"));
  assert.ok(md.includes("live"));
  assert.ok(md.includes("myproject"));
  assert.ok(md.includes("30m"));
  assert.ok(md.includes("50000"));
  assert.ok(md.includes("Cache Warmth"));
  assert.ok(md.includes("Savings"));
});

/**
 * Test: buildTooltipMarkdown with no data
 */
test("buildTooltipMarkdown: 'no data' state when source is none", () => {
  const model: StatusModel = {
    profiles: new Map([
      [
        "personal",
        {
          source: "none",
          stale: false,
        },
      ],
    ]),
    profileLabels: new Map([["personal", undefined]]),
    cacheWarmth: new Map(),
    advisorThresholds: { fiveHourPct: 85, weeklyPct: 90 },
  };

  const md = buildTooltipMarkdown(model);
  assert.ok(md.includes("No data available"));
});

/**
 * Test: buildTooltipMarkdown with advisor warning
 */
test("buildTooltipMarkdown: shows advisor warning at threshold", () => {
  const model: StatusModel = {
    profiles: new Map([
      [
        "personal",
        {
          source: "live",
          fiveHourPct: 85,
          stale: false,
        },
      ],
    ]),
    profileLabels: new Map([["personal", undefined]]),
    cacheWarmth: new Map(),
    advisorThresholds: { fiveHourPct: 85, weeklyPct: 90 },
  };

  const md = buildTooltipMarkdown(model);
  assert.ok(md.includes("High 5h usage"));
  assert.ok(md.includes("⚠️"));
});

/**
 * Test: parseAuditTotals with valid JSON
 */
test("parseAuditTotals: parses audit --json output", () => {
  const json = JSON.stringify({
    events: [],
    totalEvents: 5,
    totalEstimatedSaved: 123456,
  });

  const result = parseAuditTotals(json);
  assert.strictEqual(result.totalEvents, 5);
  assert.strictEqual(result.totalEstimatedSaved, 123456);
});

/**
 * Test: parseAuditTotals with invalid JSON
 */
test("parseAuditTotals: returns zeros on invalid JSON", () => {
  const result = parseAuditTotals("not valid json");
  assert.strictEqual(result.totalEvents, 0);
  assert.strictEqual(result.totalEstimatedSaved, 0);
});

/**
 * Test: parseAuditTotals with missing fields
 */
test("parseAuditTotals: defaults missing fields to 0", () => {
  const json = JSON.stringify({
    events: [],
  });

  const result = parseAuditTotals(json);
  assert.strictEqual(result.totalEvents, 0);
  assert.strictEqual(result.totalEstimatedSaved, 0);
});
