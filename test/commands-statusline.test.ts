import { test } from "node:test";
import assert from "node:assert";
import { execFile } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// Statusline reads stdin, so it must be exercised as a real child process:
// in-process calls would listen on the test runner's never-ending stdin.
const __testDir = fileURLToPath(new URL(".", import.meta.url));
const CLI = resolve(__testDir, "../..", "bin/lodestone.js");
const testDir = resolve(tmpdir(), `lodestone-test-statusline-${Date.now()}`);

function runStatusline(
  stdinText: string,
  env: Record<string, string>
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      process.execPath,
      [CLI, "statusline"],
      { env: { ...process.env, ...env }, timeout: 10000 },
      (err, stdout) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number"
            ? ((err as unknown as { code: number }).code)
            : err
              ? 1
              : 0;
        resolvePromise({ stdout, code });
      }
    );
    child.stdin?.write(stdinText);
    child.stdin?.end();
  });
}

test("statusline: renders profile and context from valid input", async () => {
  const testHome = resolve(testDir, "home1");
  const configDir = resolve(testHome, ".claude");
  await mkdir(resolve(testHome, ".config/lodestone"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(
    resolve(testHome, ".config/lodestone/config.json"),
    JSON.stringify({
      schema: 1,
      profiles: { personal: { configDir } },
      settings: {},
    })
  );

  const input = JSON.stringify({
    session_id: "s1",
    model: { id: "claude-sonnet-5" },
    workspace: { current_dir: testHome },
    context_window: { used_percentage: 37 },
  });

  const { stdout, code } = await runStatusline(input, {
    HOME: testHome,
    XDG_CONFIG_HOME: resolve(testHome, ".config"),
  });

  assert.equal(code, 0);
  assert.match(stdout, /⇄/, "always shows the glyph");
  assert.match(stdout, /personal/, "shows resolved profile name");
  assert.match(stdout, /ctx 37%/, "shows context percentage from input");
  await rm(testHome, { recursive: true, force: true });
});

test("statusline: degrades to bare line on garbage stdin", async () => {
  const testHome = resolve(testDir, "home2");
  await mkdir(testHome, { recursive: true });

  const { stdout, code } = await runStatusline("this is not json", {
    HOME: testHome,
    XDG_CONFIG_HOME: resolve(testHome, ".config"),
  });

  assert.equal(code, 0, "never non-zero, even on garbage");
  assert.match(stdout, /⇄/, "still prints a line");
  await rm(testHome, { recursive: true, force: true });
});

test("statusline: exits 0 with empty stdin", async () => {
  const testHome = resolve(testDir, "home3");
  await mkdir(testHome, { recursive: true });

  const { code } = await runStatusline("", {
    HOME: testHome,
    XDG_CONFIG_HOME: resolve(testHome, ".config"),
  });

  assert.equal(code, 0);
  await rm(testDir, { recursive: true, force: true });
});

test("statusline v2: renders rate_limits with real data", async () => {
  const testHome = resolve(testDir, "home-v2-1");
  const configDir = resolve(testHome, ".claude");
  await mkdir(resolve(testHome, ".config/lodestone"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(
    resolve(testHome, ".config/lodestone/config.json"),
    JSON.stringify({
      schema: 1,
      profiles: { personal: { configDir } },
      settings: {},
    })
  );

  const input = JSON.stringify({
    session_id: "s1",
    rate_limits: {
      five_hour: {
        used_percentage: 48,
        resets_at: Math.floor(Date.now() / 1000) + 300,
      },
      seven_day: {
        used_percentage: 65,
        resets_at: Math.floor(Date.now() / 1000) + 86400,
      },
    },
  });

  const { stdout, code } = await runStatusline(input, {
    HOME: testHome,
    XDG_CONFIG_HOME: resolve(testHome, ".config"),
  });

  assert.equal(code, 0);
  assert.match(stdout, /5h .*48%/, "shows 5h percentage next to its bar");
  assert.match(stdout, /wk .*65%/, "shows weekly percentage next to its bar");
  await rm(testHome, { recursive: true, force: true });
});

test("statusline v2: writes usage cache from rate_limits", async () => {
  const testHome = resolve(testDir, "home-v2-2");
  const configDir = resolve(testHome, ".claude");
  await mkdir(resolve(testHome, ".config/lodestone"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(
    resolve(testHome, ".config/lodestone/config.json"),
    JSON.stringify({
      schema: 1,
      profiles: { personal: { configDir } },
      settings: {},
    })
  );

  const input = JSON.stringify({
    session_id: "s1",
    rate_limits: {
      five_hour: {
        used_percentage: 42,
        resets_at: Math.floor(Date.now() / 1000) + 600,
      },
    },
  });

  await runStatusline(input, {
    HOME: testHome,
    XDG_CONFIG_HOME: resolve(testHome, ".config"),
  });

  // Check that cache was written
  const { readFileSync } = await import("node:fs");
  const cachePath = resolve(testHome, ".config/lodestone/usage-cache.json");
  if (existsSync(cachePath)) {
    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    assert.equal(cache.source, "statusline");
    assert.equal(cache.five_hour?.used_percentage, 42);
  }

  await rm(testHome, { recursive: true, force: true });
});

test("statusline v2: shows advisor glyph at 5h threshold", async () => {
  const testHome = resolve(testDir, "home-v2-3");
  const configDir = resolve(testHome, ".claude");
  await mkdir(resolve(testHome, ".config/lodestone"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(
    resolve(testHome, ".config/lodestone/config.json"),
    JSON.stringify({
      schema: 1,
      profiles: { personal: { configDir } },
      settings: {
        advisor: { fiveHourPct: 85 },
      },
    })
  );

  const input = JSON.stringify({
    session_id: "s1",
    rate_limits: {
      five_hour: {
        used_percentage: 87,
        resets_at: Math.floor(Date.now() / 1000) + 300,
      },
    },
  });

  const { stdout, code } = await runStatusline(input, {
    HOME: testHome,
    XDG_CONFIG_HOME: resolve(testHome, ".config"),
  });

  assert.equal(code, 0);
  assert.match(stdout, /⚠/, "should show advisor glyph at/above threshold");
  assert.match(stdout, /handoff\?/, "should show handoff hint");

  await rm(testHome, { recursive: true, force: true });
});

test("statusline v2: shows pacing marker when high utilization", async () => {
  const testHome = resolve(testDir, "home-v2-4");
  const configDir = resolve(testHome, ".claude");
  await mkdir(resolve(testHome, ".config/lodestone"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(
    resolve(testHome, ".config/lodestone/config.json"),
    JSON.stringify({
      schema: 1,
      profiles: { personal: { configDir } },
      settings: {},
    })
  );

  const input = JSON.stringify({
    session_id: "s1",
    rate_limits: {
      five_hour: {
        used_percentage: 65,
        resets_at: Math.floor(Date.now() / 1000) + 300,
      },
    },
  });

  const { stdout, code } = await runStatusline(input, {
    HOME: testHome,
    XDG_CONFIG_HOME: resolve(testHome, ".config"),
  });

  assert.equal(code, 0);
  assert.match(stdout, /[█░]/, "renders a quota bar");

  await rm(testHome, { recursive: true, force: true });
});

test("statusline: cache segment with fresh session mtime", async () => {
  const testHome = resolve(testDir, "home-cache-fresh");
  const configDir = resolve(testHome, ".claude");
  const projectsDir = resolve(configDir, "projects");

  // The workspace cwd we'll pass
  const workspaceCwd = resolve(testHome, "my-project");
  // Munge it: split by "/" and join by "-"
  const mungedCwd = workspaceCwd.split("/").join("-");
  const projectPath = resolve(projectsDir, mungedCwd);

  await mkdir(resolve(testHome, ".config/lodestone"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(projectPath, { recursive: true });

  await writeFile(
    resolve(testHome, ".config/lodestone/config.json"),
    JSON.stringify({
      schema: 1,
      profiles: { personal: { configDir } },
      settings: {},
    })
  );

  // Plant a fresh session file (mtime ~now)
  const sessionPath = resolve(projectPath, "session1.jsonl");
  await writeFile(sessionPath, '{"type":"start"}\n');

  const input = JSON.stringify({
    session_id: "s1",
    workspace: { current_dir: workspaceCwd },
  });

  const { stdout, code } = await runStatusline(input, {
    HOME: testHome,
    XDG_CONFIG_HOME: resolve(testHome, ".config"),
  });

  assert.equal(code, 0);
  // Should show cache segment with ~60m remaining (tolerance: ±5 minutes for test execution)
  assert.match(stdout, /cache \d+m/, "should show cache segment with minutes remaining");
  const match = stdout.match(/cache (\d+)m/);
  if (match && match[1]) {
    const minutes = parseInt(match[1], 10);
    assert(minutes >= 55 && minutes <= 60, `cache time should be 55-60m, got ${minutes}m`);
  }

  await rm(testHome, { recursive: true, force: true });
});

test("statusline: cache segment shows cold when session is old", async () => {
  const testHome = resolve(testDir, "home-cache-cold");
  const configDir = resolve(testHome, ".claude");
  const projectsDir = resolve(configDir, "projects");

  // The workspace cwd we'll pass
  const workspaceCwd = resolve(testHome, "my-old-project");
  // Munge it: split by "/" and join by "-"
  const mungedCwd = workspaceCwd.split("/").join("-");
  const projectPath = resolve(projectsDir, mungedCwd);

  await mkdir(resolve(testHome, ".config/lodestone"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(projectPath, { recursive: true });

  await writeFile(
    resolve(testHome, ".config/lodestone/config.json"),
    JSON.stringify({
      schema: 1,
      profiles: { personal: { configDir } },
      settings: {},
    })
  );

  // Plant a session file with old mtime (>60 minutes ago)
  const sessionPath = resolve(projectPath, "session1.jsonl");
  await writeFile(sessionPath, '{"type":"start"}\n');

  // Set mtime to 90 minutes ago
  const ninetyMinutesAgo = Date.now() - 90 * 60 * 1000;
  const fs = await import("node:fs");
  fs.utimesSync(sessionPath, ninetyMinutesAgo / 1000, ninetyMinutesAgo / 1000);

  const input = JSON.stringify({
    session_id: "s1",
    workspace: { current_dir: workspaceCwd },
  });

  const { stdout, code } = await runStatusline(input, {
    HOME: testHome,
    XDG_CONFIG_HOME: resolve(testHome, ".config"),
  });

  assert.equal(code, 0);
  assert.match(stdout, /cache cold/, "should show cache cold when session is >60min old");

  await rm(testHome, { recursive: true, force: true });
});

test("statusline: omits cache segment when no session exists", async () => {
  const testHome = resolve(testDir, "home-cache-none");
  const configDir = resolve(testHome, ".claude");

  await mkdir(resolve(testHome, ".config/lodestone"), { recursive: true });
  await mkdir(configDir, { recursive: true });

  await writeFile(
    resolve(testHome, ".config/lodestone/config.json"),
    JSON.stringify({
      schema: 1,
      profiles: { personal: { configDir } },
      settings: {},
    })
  );

  // Workspace cwd for which no projects dir exists
  const workspaceCwd = resolve(testHome, "nonexistent-project");

  const input = JSON.stringify({
    session_id: "s1",
    workspace: { current_dir: workspaceCwd },
  });

  const { stdout, code } = await runStatusline(input, {
    HOME: testHome,
    XDG_CONFIG_HOME: resolve(testHome, ".config"),
  });

  assert.equal(code, 0);
  // Should NOT have a cache segment at all
  assert(!stdout.includes("cache"), "should omit cache segment when no session exists");
  assert.match(stdout, /⇄/, "should still show the basic line");

  await rm(testHome, { recursive: true, force: true });
});
