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
const CLI = resolve(__testDir, "../..", "bin/cchandoff.js");
const testDir = resolve(tmpdir(), `cchandoff-test-statusline-${Date.now()}`);

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
  await mkdir(resolve(testHome, ".config/cchandoff"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(
    resolve(testHome, ".config/cchandoff/config.json"),
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
  await mkdir(resolve(testHome, ".config/cchandoff"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(
    resolve(testHome, ".config/cchandoff/config.json"),
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
  assert.match(stdout, /5h 48%/, "should show 5h percentage from rate_limits");
  assert.match(stdout, /wk 65%/, "should show weekly percentage");
  await rm(testHome, { recursive: true, force: true });
});

test("statusline v2: writes usage cache from rate_limits", async () => {
  const testHome = resolve(testDir, "home-v2-2");
  const configDir = resolve(testHome, ".claude");
  await mkdir(resolve(testHome, ".config/cchandoff"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(
    resolve(testHome, ".config/cchandoff/config.json"),
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
  const cachePath = resolve(testHome, ".config/cchandoff/usage-cache.json");
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
  await mkdir(resolve(testHome, ".config/cchandoff"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(
    resolve(testHome, ".config/cchandoff/config.json"),
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
  await mkdir(resolve(testHome, ".config/cchandoff"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(
    resolve(testHome, ".config/cchandoff/config.json"),
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
  assert.match(stdout, /▲/, "should show pacing marker when >50%");

  await rm(testHome, { recursive: true, force: true });
});
