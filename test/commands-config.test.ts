import { test } from "node:test";
import assert from "node:assert";
import { execFile } from "node:child_process";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __testDir = fileURLToPath(new URL(".", import.meta.url));
const CLI = resolve(__testDir, "../..", "bin/warmswap.js");
const testDir = resolve(tmpdir(), `warmswap-test-config-${Date.now()}`);

function runConfig(
  args: string[],
  env: Record<string, string>
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      process.execPath,
      [CLI, "config", ...args],
      { env: { ...process.env, ...env }, timeout: 10000 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number"
            ? ((err as unknown as { code: number }).code)
            : err
              ? 1
              : 0;
        resolvePromise({ stdout, stderr, code });
      }
    );
  });
}

test("config: get realUsage defaults to false", async () => {
  const testHome = resolve(testDir, "home1");
  await mkdir(resolve(testHome, ".config/warmswap"), { recursive: true });

  const { stdout, code } = await runConfig(["get", "realUsage"], {
    HOME: testHome,
    XDG_CONFIG_HOME: resolve(testHome, ".config"),
  });

  assert.equal(code, 0);
  assert.match(stdout, /realUsage: false/);

  await rm(testHome, { recursive: true, force: true });
});

test("config: set realUsage to true", async () => {
  const testHome = resolve(testDir, "home2");
  await mkdir(resolve(testHome, ".config/warmswap"), { recursive: true });
  await writeFile(
    resolve(testHome, ".config/warmswap/config.json"),
    JSON.stringify({
      schema: 1,
      profiles: {},
      settings: {},
    })
  );

  const { stdout, code } = await runConfig(["set", "realUsage", "true"], {
    HOME: testHome,
    XDG_CONFIG_HOME: resolve(testHome, ".config"),
  });

  assert.equal(code, 0);
  assert.match(stdout, /realUsage = true/);

  // Verify it was actually set
  const configRaw = await readFile(
    resolve(testHome, ".config/warmswap/config.json"),
    "utf8"
  );
  const config = JSON.parse(configRaw);
  assert.equal(config.settings.realUsage, true);

  await rm(testHome, { recursive: true, force: true });
});

test("config: get advisor thresholds with defaults", async () => {
  const testHome = resolve(testDir, "home3");
  await mkdir(resolve(testHome, ".config/warmswap"), { recursive: true });

  const { stdout: stdout5h, code: code5h } = await runConfig(
    ["get", "advisor.fiveHourPct"],
    {
      HOME: testHome,
      XDG_CONFIG_HOME: resolve(testHome, ".config"),
    }
  );

  assert.equal(code5h, 0);
  assert.match(stdout5h, /advisor\.fiveHourPct: 85/);

  const { stdout: stdout7d, code: code7d } = await runConfig(
    ["get", "advisor.weeklyPct"],
    {
      HOME: testHome,
      XDG_CONFIG_HOME: resolve(testHome, ".config"),
    }
  );

  assert.equal(code7d, 0);
  assert.match(stdout7d, /advisor\.weeklyPct: 90/);

  await rm(testHome, { recursive: true, force: true });
});

test("config: set advisor thresholds", async () => {
  const testHome = resolve(testDir, "home4");
  await mkdir(resolve(testHome, ".config/warmswap"), { recursive: true });
  await writeFile(
    resolve(testHome, ".config/warmswap/config.json"),
    JSON.stringify({
      schema: 1,
      profiles: {},
      settings: {},
    })
  );

  const { stdout, code } = await runConfig(
    ["set", "advisor.fiveHourPct", "80"],
    {
      HOME: testHome,
      XDG_CONFIG_HOME: resolve(testHome, ".config"),
    }
  );

  assert.equal(code, 0);
  assert.match(stdout, /advisor\.fiveHourPct = 80/);

  // Verify it was set
  const configRaw = await readFile(
    resolve(testHome, ".config/warmswap/config.json"),
    "utf8"
  );
  const config = JSON.parse(configRaw);
  assert.equal(config.settings.advisor?.fiveHourPct, 80);

  await rm(testHome, { recursive: true, force: true });
});

test("config: set plan", async () => {
  const testHome = resolve(testDir, "home5");
  await mkdir(resolve(testHome, ".config/warmswap"), { recursive: true });
  await writeFile(
    resolve(testHome, ".config/warmswap/config.json"),
    JSON.stringify({
      schema: 1,
      profiles: {},
      settings: {},
    })
  );

  const { stdout, code } = await runConfig(["set", "plan", "max5"], {
    HOME: testHome,
    XDG_CONFIG_HOME: resolve(testHome, ".config"),
  });

  assert.equal(code, 0);
  assert.match(stdout, /plan = max5/);

  const configRaw = await readFile(
    resolve(testHome, ".config/warmswap/config.json"),
    "utf8"
  );
  const config = JSON.parse(configRaw);
  assert.equal(config.settings.plan, "max5");

  await rm(testHome, { recursive: true, force: true });
});

test("config: rejects invalid percentage", async () => {
  const testHome = resolve(testDir, "home6");
  await mkdir(resolve(testHome, ".config/warmswap"), { recursive: true });

  const { stdout, stderr, code } = await runConfig(
    ["set", "advisor.fiveHourPct", "150"],
    {
      HOME: testHome,
      XDG_CONFIG_HOME: resolve(testHome, ".config"),
    }
  );

  assert.equal(code, 1);
  const output = stdout + stderr;
  assert.match(output, /must be 0-100/);

  await rm(testHome, { recursive: true, force: true });
});

test("config: rejects invalid plan", async () => {
  const testHome = resolve(testDir, "home7");
  await mkdir(resolve(testHome, ".config/warmswap"), { recursive: true });

  const { stdout, stderr, code } = await runConfig(["set", "plan", "invalid"], {
    HOME: testHome,
    XDG_CONFIG_HOME: resolve(testHome, ".config"),
  });

  assert.equal(code, 1);
  const output = stdout + stderr;
  assert.match(output, /must be one of/);

  await rm(testHome, { recursive: true, force: true });
});

test("config: json output format", async () => {
  const testHome = resolve(testDir, "home8");
  await mkdir(resolve(testHome, ".config/warmswap"), { recursive: true });

  const { stdout, code } = await runConfig(
    ["--json", "get", "realUsage"],
    {
      HOME: testHome,
      XDG_CONFIG_HOME: resolve(testHome, ".config"),
    }
  );

  assert.equal(code, 0);
  const output = JSON.parse(stdout);
  assert.equal(output.key, "realUsage");
  assert.equal(output.value, false);

  await rm(testHome, { recursive: true, force: true });
});
