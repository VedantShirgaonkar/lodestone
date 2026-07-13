import { test } from "node:test";
import assert from "node:assert";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __testDir = fileURLToPath(new URL(".", import.meta.url));
const CLI = resolve(__testDir, "../..", "bin/lodestone.js");
const testDir = resolve(tmpdir(), `lodestone-test-config-${Date.now()}`);

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
  await mkdir(resolve(testHome, ".config/lodestone"), { recursive: true });

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
  await mkdir(resolve(testHome, ".config/lodestone"), { recursive: true });
  await writeFile(
    resolve(testHome, ".config/lodestone/config.json"),
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
    resolve(testHome, ".config/lodestone/config.json"),
    "utf8"
  );
  const config = JSON.parse(configRaw);
  assert.equal(config.settings.realUsage, true);

  await rm(testHome, { recursive: true, force: true });
});

test("config: get advisor thresholds with defaults", async () => {
  const testHome = resolve(testDir, "home3");
  await mkdir(resolve(testHome, ".config/lodestone"), { recursive: true });

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
  await mkdir(resolve(testHome, ".config/lodestone"), { recursive: true });
  await writeFile(
    resolve(testHome, ".config/lodestone/config.json"),
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
    resolve(testHome, ".config/lodestone/config.json"),
    "utf8"
  );
  const config = JSON.parse(configRaw);
  assert.equal(config.settings.advisor?.fiveHourPct, 80);

  await rm(testHome, { recursive: true, force: true });
});

test("config: set plan", async () => {
  const testHome = resolve(testDir, "home5");
  await mkdir(resolve(testHome, ".config/lodestone"), { recursive: true });
  await writeFile(
    resolve(testHome, ".config/lodestone/config.json"),
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
    resolve(testHome, ".config/lodestone/config.json"),
    "utf8"
  );
  const config = JSON.parse(configRaw);
  assert.equal(config.settings.plan, "max5");

  await rm(testHome, { recursive: true, force: true });
});

test("config: rejects invalid percentage", async () => {
  const testHome = resolve(testDir, "home6");
  await mkdir(resolve(testHome, ".config/lodestone"), { recursive: true });

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
  await mkdir(resolve(testHome, ".config/lodestone"), { recursive: true });

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
  await mkdir(resolve(testHome, ".config/lodestone"), { recursive: true });

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

import { main } from "../src/cli.js";

test("config: realUsage accepts on/off, rejects nonsense", async () => {
  const home = await mkdtemp(join(tmpdir(), "lodestone-cfg-"));
  await mkdir(join(home, ".config/lodestone"), { recursive: true });
  await writeFile(
    join(home, ".config/lodestone/config.json"),
    JSON.stringify({ schema: 1, profiles: {}, settings: {} })
  );
  const oldHome = process.env.HOME;
  const oldXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    // "on" is what the extension button and the docs send. It used to be
    // parsed as false, which made the whole real-usage feature unreachable.
    assert.strictEqual(await main(["config", "set", "realUsage", "on"]), 0);
    let cfg = JSON.parse(
      await readFile(join(home, ".config/lodestone/config.json"), "utf8")
    );
    assert.strictEqual(cfg.settings.realUsage, true);

    assert.strictEqual(await main(["config", "set", "realUsage", "off"]), 0);
    cfg = JSON.parse(
      await readFile(join(home, ".config/lodestone/config.json"), "utf8")
    );
    assert.strictEqual(cfg.settings.realUsage, false);

    assert.strictEqual(await main(["config", "set", "realUsage", "banana"]), 1);
  } finally {
    console.log = log;
    console.error = err;
    if (oldHome !== undefined) process.env.HOME = oldHome;
    if (oldXdg !== undefined) process.env.XDG_CONFIG_HOME = oldXdg;
    else delete process.env.XDG_CONFIG_HOME;
    await rm(home, { recursive: true, force: true });
  }
});
