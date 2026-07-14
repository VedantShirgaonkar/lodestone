import { test } from "node:test";
import * as assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  loadRegistry,
  loadProfileQuota,
  cacheWarmth,
  listRunningKeepalives,
  buildStatusText,
  buildTooltipMarkdown,
  parseAuditTotals,
  expiryToastDecisions,
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
  const tmpDir = mkdtempSync(join(tmpdir(), "lodestone-test-"));
  const configDir = join(tmpDir, "lodestone");
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
  const tmpDir = mkdtempSync(join(tmpdir(), "lodestone-test-"));
  const result = loadProfileQuota(tmpDir);
  assert.strictEqual(result.source, "none");
  assert.strictEqual(result.stale, false);
});

/**
 * Test: loadProfileQuota with fresh cache (live data)
 */
test("loadProfileQuota: parses fresh usage-cache.json", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "lodestone-test-"));
  const lodestoneDir = join(tmpDir, "lodestone");
  mkdirSync(lodestoneDir, { recursive: true });

  const cacheFile = join(lodestoneDir, "usage-cache.json");
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
  const tmpDir = mkdtempSync(join(tmpdir(), "lodestone-test-"));
  const lodestoneDir = join(tmpDir, "lodestone");
  mkdirSync(lodestoneDir, { recursive: true });

  const cacheFile = join(lodestoneDir, "usage-cache.json");
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
  const tmpDir = mkdtempSync(join(tmpdir(), "lodestone-test-"));
  const projectDir = "/Users/test/myproject";

  const result = cacheWarmth(tmpDir, projectDir);
  assert.ok(result);
  assert.strictEqual(result.minutesRemaining, "cold");
});

/**
 * Test: cacheWarmth with fresh transcript
 */
test("cacheWarmth: fresh transcript shows minutes remaining", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "lodestone-test-"));
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
  const tmpDir = mkdtempSync(join(tmpdir(), "lodestone-test-"));
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
  assert.ok(text.includes("lodestone"));
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
  assert.ok(md.includes("5-hour"));
  assert.ok(md.includes("42%"));
  assert.ok(md.includes("live"));
  assert.ok(md.includes("myproject"));
  assert.ok(md.includes("30m"));
  assert.ok(md.includes("50k tokens"));
  assert.ok(md.includes("Cache"));
  assert.ok(md.includes("Saved"));
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
  assert.ok(md.includes("no data"));
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

/**
 * Test: parseAuditTotals with byClass breakdown
 */
test("parseAuditTotals: parses byClass breakdown", () => {
  const json = JSON.stringify({
    events: [],
    totalEvents: 3,
    totalEstimatedSaved: 100000,
    byClass: {
      switch: { count: 1, estimatedSaved: 50000 },
      refresh: { count: 1, estimatedSaved: 30000 },
      "post-reset": { count: 1, estimatedSaved: 20000 },
    },
  });

  const result = parseAuditTotals(json);
  assert.strictEqual(result.totalEvents, 3);
  assert.strictEqual(result.totalEstimatedSaved, 100000);
  assert.ok(result.byClass);
  assert.strictEqual(result.byClass.switch?.estimatedSaved, 50000);
  assert.strictEqual(result.byClass.refresh?.estimatedSaved, 30000);
  assert.strictEqual(result.byClass["post-reset"]?.estimatedSaved, 20000);
});

/**
 * Test: buildTooltipMarkdown with byClass savings
 */
test("buildTooltipMarkdown: shows savings by class breakdown", () => {
  const model: StatusModel = {
    profiles: new Map(),
    profileLabels: new Map(),
    cacheWarmth: new Map(),
    auditTotals: {
      totalEvents: 3,
      totalEstimatedSaved: 100000,
      byClass: {
        switch: { count: 1, estimatedSaved: 50000 },
        refresh: { count: 1, estimatedSaved: 30000 },
        "post-reset": { count: 1, estimatedSaved: 20000 },
      },
    },
    advisorThresholds: { fiveHourPct: 85, weeklyPct: 90 },
  };

  const md = buildTooltipMarkdown(model);
  assert.ok(md.includes("Saved"));
  assert.ok(md.includes("100k tokens")); // Abbreviated format
  assert.ok(md.includes("switch 1"));     // Count, not saved amount
  assert.ok(md.includes("refresh 1"));
  assert.ok(md.includes("post-reset 1"));
});

/**
 * Test: expiryToastDecisions fires at or below threshold
 */
test("expiryToastDecisions: fires at/below threshold", () => {
  const warmthMap = new Map([
    ["/Users/test/proj1", { projectDir: "/Users/test/proj1", minutesRemaining: 5 }],
    ["/Users/test/proj2", { projectDir: "/Users/test/proj2", minutesRemaining: 10 }],
    ["/Users/test/proj3", { projectDir: "/Users/test/proj3", minutesRemaining: 20 }],
  ]);

  const toasted = new Set<string>();
  const decisions = expiryToastDecisions(warmthMap, 10, toasted);

  // Should toast proj1 (5m <= 10m) and proj2 (10m <= 10m)
  assert.strictEqual(decisions.length, 2);
  assert.ok(decisions.find((d) => d.folder === "proj1"));
  assert.ok(decisions.find((d) => d.folder === "proj2"));
  assert.strictEqual(decisions[0].minutesRemaining, 5);
  assert.strictEqual(decisions[1].minutesRemaining, 10);
});

/**
 * Test: expiryToastDecisions doesn't fire above threshold
 */
test("expiryToastDecisions: does not fire above threshold", () => {
  const warmthMap = new Map([
    ["/Users/test/proj1", { projectDir: "/Users/test/proj1", minutesRemaining: 50 }],
  ]);

  const toasted = new Set<string>();
  const decisions = expiryToastDecisions(warmthMap, 10, toasted);

  assert.strictEqual(decisions.length, 0);
});

/**
 * Test: expiryToastDecisions doesn't toast twice for same key
 */
test("expiryToastDecisions: does not toast twice for same key", () => {
  const warmthMap = new Map([
    ["/Users/test/proj1", { projectDir: "/Users/test/proj1", minutesRemaining: 5 }],
  ]);

  const toasted = new Set(["/Users/test/proj1:5"]);
  const decisions = expiryToastDecisions(warmthMap, 10, toasted);

  assert.strictEqual(decisions.length, 0);
});

/**
 * Test: expiryToastDecisions re-fires for new warm-period key
 */
test("expiryToastDecisions: re-fires for new warm-period key", () => {
  const warmthMap = new Map([
    ["/Users/test/proj1", { projectDir: "/Users/test/proj1", minutesRemaining: 3 }],
  ]);

  const toasted = new Set(["/Users/test/proj1:5"]);
  const decisions = expiryToastDecisions(warmthMap, 10, toasted);

  // Different minutesRemaining = different key, so should toast
  assert.strictEqual(decisions.length, 1);
  assert.strictEqual(decisions[0].minutesRemaining, 3);
});

/**
 * Test: expiryToastDecisions ignores cold caches
 */
test("expiryToastDecisions: ignores cold caches", () => {
  const warmthMap = new Map<string, {projectDir: string; minutesRemaining: "cold" | number}>([
    ["/Users/test/proj1", { projectDir: "/Users/test/proj1", minutesRemaining: "cold" as const }],
  ]);

  const toasted = new Set<string>();
  const decisions = expiryToastDecisions(warmthMap as any, 10, toasted);

  assert.strictEqual(decisions.length, 0);
});

/**
 * Test: expiryToastDecisions disabled when threshold is 0
 */
test("expiryToastDecisions: disabled when threshold is 0", () => {
  const warmthMap = new Map([
    ["/Users/test/proj1", { projectDir: "/Users/test/proj1", minutesRemaining: 5 }],
  ]);

  const toasted = new Set<string>();
  const decisions = expiryToastDecisions(warmthMap, 0, toasted);

  assert.strictEqual(decisions.length, 0);
});

/**
 * Test: buildTooltipMarkdown table has correct headers
 */
test("buildTooltipMarkdown: table has Window, Usage, Resets headers", () => {
  const model: StatusModel = {
    profiles: new Map([
      [
        "personal",
        {
          source: "live",
          fiveHourPct: 42,
          fiveHourResetsAt: Date.now() + 60 * 60 * 1000,
          sevenDayPct: 25,
          stale: false,
        },
      ],
    ]),
    profileLabels: new Map(),
    cacheWarmth: new Map(),
    advisorThresholds: { fiveHourPct: 85, weeklyPct: 90 },
  };

  const md = buildTooltipMarkdown(model);
  assert.ok(md.includes("| Window | Usage | Resets |"));
  assert.ok(md.includes("| 5-hour |"));
  assert.ok(md.includes("| Weekly |"));
});

/**
 * Test: buildTooltipMarkdown emoji bar color at <50%
 */
test("buildTooltipMarkdown: green emoji (🟩) under 50%", () => {
  const model: StatusModel = {
    profiles: new Map([
      [
        "personal",
        {
          source: "live",
          fiveHourPct: 42,
          stale: false,
        },
      ],
    ]),
    profileLabels: new Map(),
    cacheWarmth: new Map(),
    advisorThresholds: { fiveHourPct: 85, weeklyPct: 90 },
  };

  const md = buildTooltipMarkdown(model);
  // At 42%, should have filled cells in green (🟩)
  assert.ok(md.includes("🟩"), "should include green emoji for <50%");
  assert.ok(!md.includes("🟧"), "should not include orange emoji");
});

/**
 * Test: buildTooltipMarkdown emoji bar color at 50-84%
 */
test("buildTooltipMarkdown: orange emoji (🟧) at 50-84%", () => {
  const model: StatusModel = {
    profiles: new Map([
      [
        "personal",
        {
          source: "live",
          fiveHourPct: 70,
          stale: false,
        },
      ],
    ]),
    profileLabels: new Map(),
    cacheWarmth: new Map(),
    advisorThresholds: { fiveHourPct: 85, weeklyPct: 90 },
  };

  const md = buildTooltipMarkdown(model);
  // At 70%, should have filled cells in orange (🟧)
  assert.ok(md.includes("🟧"), "should include orange emoji for 50-84%");
  assert.ok(!md.includes("🟩"), "should not include green emoji");
});

/**
 * Test: buildTooltipMarkdown emoji bar color at 85%+
 */
test("buildTooltipMarkdown: red emoji (🟥) at 85%+", () => {
  const model: StatusModel = {
    profiles: new Map([
      [
        "personal",
        {
          source: "live",
          fiveHourPct: 90,
          stale: false,
        },
      ],
    ]),
    profileLabels: new Map(),
    cacheWarmth: new Map(),
    advisorThresholds: { fiveHourPct: 85, weeklyPct: 90 },
  };

  const md = buildTooltipMarkdown(model);
  // At 90%, should have filled cells in red (🟥)
  assert.ok(md.includes("🟥"), "should include red emoji for 85%+");
  assert.ok(!md.includes("🟧"), "should not include orange emoji");
});

/**
 * Test: buildTooltipMarkdown renders live tag
 */
test("buildTooltipMarkdown: renders live tag in backticks", () => {
  const model: StatusModel = {
    profiles: new Map([
      [
        "personal",
        {
          source: "live",
          fiveHourPct: 42,
          stale: false,
        },
      ],
    ]),
    profileLabels: new Map(),
    cacheWarmth: new Map(),
    advisorThresholds: { fiveHourPct: 85, weeklyPct: 90 },
  };

  const md = buildTooltipMarkdown(model);
  assert.ok(md.includes("`live`"), "should render live tag in backticks");
});

/**
 * Test: buildTooltipMarkdown renders est tag
 */
test("buildTooltipMarkdown: renders est tag in backticks", () => {
  const model: StatusModel = {
    profiles: new Map([
      [
        "personal",
        {
          source: "est",
          fiveHourPct: 42,
          stale: false,
        },
      ],
    ]),
    profileLabels: new Map(),
    cacheWarmth: new Map(),
    advisorThresholds: { fiveHourPct: 85, weeklyPct: 90 },
  };

  const md = buildTooltipMarkdown(model);
  assert.ok(md.includes("`est`"), "should render est tag in backticks");
});

/**
 * Test: buildTooltipMarkdown countdown formatting
 */
test("buildTooltipMarkdown: formats reset countdown (hours and minutes)", () => {
  const resetIn2h30m = Date.now() + 2.5 * 60 * 60 * 1000;
  const model: StatusModel = {
    profiles: new Map([
      [
        "personal",
        {
          source: "live",
          fiveHourPct: 42,
          fiveHourResetsAt: resetIn2h30m,
          stale: false,
        },
      ],
    ]),
    profileLabels: new Map(),
    cacheWarmth: new Map(),
    advisorThresholds: { fiveHourPct: 85, weeklyPct: 90 },
  };

  const md = buildTooltipMarkdown(model);
  // Should render as "2h 30m"
  assert.ok(/2h 3[0-9]m/.test(md), "should format countdown with hours and minutes");
});

/**
 * Test: buildTooltipMarkdown shows no data explicitly
 */
test("buildTooltipMarkdown: shows no data when source is none", () => {
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
    profileLabels: new Map(),
    cacheWarmth: new Map(),
    advisorThresholds: { fiveHourPct: 85, weeklyPct: 90 },
  };

  const md = buildTooltipMarkdown(model);
  assert.ok(md.includes("no data"), "should explicitly say no data");
  assert.ok(!md.includes("0%"), "should not show fake 0%");
});

test("loadProfileQuota: reads epoch-seconds resets from the bridge", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "lodestone-test-"));
  const dir = join(tmpDir, "lodestone");
  mkdirSync(dir, { recursive: true });
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  writeFileSync(
    join(dir, "usage-cache.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      source: "statusline",
      five_hour: { used_percentage: 64, resets_at_ts: resetsAt },
      seven_day: { used_percentage: 88, resets_at_ts: resetsAt + 86400 },
    })
  );

  const q = loadProfileQuota(tmpDir);
  assert.strictEqual(q.source, "live");
  assert.strictEqual(q.fiveHourPct, 64);
  assert.strictEqual(q.sevenDayPct, 88);
  // The countdown was always "-" because this field was read under the wrong name.
  assert.strictEqual(q.fiveHourResetsAt, resetsAt);
  assert.ok(q.sevenDayResetsAt);
});

/**
 * Test: cacheWarmth for a workspace path containing a space.
 * Claude Code munges every non-alphanumeric to a dash, not just slashes; the
 * old slash-only munge here meant such workspaces read "cold" forever.
 */
test("cacheWarmth: a path with a space finds its transcripts", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "lodestone-test-"));
  const projectDir = "/Users/test/My Project";

  // What Claude Code actually creates on disk for that path.
  const mungedOnDisk = "-Users-test-My-Project";
  const projectsDir = join(tmpDir, "projects", mungedOnDisk);
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(join(projectsDir, "sess-1.jsonl"), '{"type":"user"}\n');

  const result = cacheWarmth(tmpDir, projectDir);
  assert.ok(result);
  assert.ok(
    typeof result.minutesRemaining === "number",
    `space-path workspace must be found, got: ${String(result.minutesRemaining)}`
  );
});

/**
 * Test: per-model weekly rows appear in the tooltip only when the CLI's oauth
 * cache carries non-null buckets for them.
 */
test("tooltip: renders per-model weekly rows from the oauth cache", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "lodestone-test-"));
  mkdirSync(join(tmpDir, "lodestone"), { recursive: true });

  // The statusline bridge (main quota source)…
  writeFileSync(
    join(tmpDir, "lodestone", "usage-cache.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      source: "oauth",
      five_hour: { used_percentage: 40, resets_at_ts: Math.floor(Date.now() / 1000) + 3600 },
      seven_day: { used_percentage: 55, resets_at_ts: Math.floor(Date.now() / 1000) + 90000 },
    })
  );
  // …and the oauth cache with an opus bucket, sonnet null.
  writeFileSync(
    join(tmpDir, "lodestone", "usage-live.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      source: "oauth",
      seven_day_opus: { used_percentage: 71, resets_at_ts: Math.floor(Date.now() / 1000) + 90000 },
      seven_day_sonnet: null,
    })
  );

  const quota = loadProfileQuota(tmpDir);
  assert.ok(quota.perModelWeekly, "opus bucket must surface");
  assert.equal(quota.perModelWeekly?.[0]?.model, "opus");
  assert.equal(quota.perModelWeekly?.[0]?.pct, 71);

  const model: StatusModel = {
    profiles: new Map([["personal", quota]]),
    profileLabels: new Map(),
    cacheWarmth: new Map(),
    advisorThresholds: { fiveHourPct: 85, weeklyPct: 90 },
  };
  const md = buildTooltipMarkdown(model);
  assert.match(md, /Weekly \(opus\)/, `tooltip must carry the opus row: ${md}`);
  assert.doesNotMatch(md, /Weekly \(sonnet\)/, "a null bucket is not a row");
});

/**
 * Test: listRunningKeepalives probes pids instead of believing state files.
 */
test("listRunningKeepalives: reports only schedulers whose pid is alive", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "lodestone-test-"));
  mkdirSync(join(tmpDir, "lodestone"), { recursive: true });

  writeFileSync(
    join(tmpDir, "lodestone", "keepalive-personal.json"),
    JSON.stringify({ profile: "personal", pid: 11111, pings: [{}, {}], cap: 3 })
  );
  writeFileSync(
    join(tmpDir, "lodestone", "keepalive-work.json"),
    JSON.stringify({ profile: "work", pid: 22222, pings: [], cap: 3 })
  );

  const running = listRunningKeepalives(tmpDir, (pid) => pid === 11111);
  assert.equal(running.length, 1, "the dead pid must not be reported");
  assert.equal(running[0]?.profile, "personal");
  assert.equal(running[0]?.pings, 2);
});

/**
 * Test: a cached overshoot (feed reported 107% at the limit) renders as 100%.
 */
test("loadProfileQuota: clamps percentages to 100", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "lodestone-test-"));
  mkdirSync(join(tmpDir, "lodestone"), { recursive: true });
  writeFileSync(
    join(tmpDir, "lodestone", "usage-cache.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      source: "statusline",
      five_hour: { used_percentage: 107, resets_at_ts: Math.floor(Date.now() / 1000) + 5400 },
      seven_day: { used_percentage: 45 },
    })
  );

  const quota = loadProfileQuota(tmpDir);
  assert.equal(quota.fiveHourPct, 100, "a window cannot be more than fully used");
  assert.equal(quota.sevenDayPct, 45);
});
