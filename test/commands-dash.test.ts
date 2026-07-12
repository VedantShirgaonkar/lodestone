import { test } from "node:test";
import assert from "node:assert";
import { execFile } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __testDir = fileURLToPath(new URL(".", import.meta.url));
const CLI = resolve(__testDir, "..", "..", "bin/cchandoff.js");
const testDir = resolve(tmpdir(), `cchandoff-test-dash-${Date.now()}`);

function runDash(
  env: Record<string, string>
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      process.execPath,
      [CLI, "dash", "--once"],
      { env: { ...process.env, ...env }, timeout: 30000 },
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
  });
}

test("dash --once: renders frame with profile name and quota bars", async () => {
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

  const { stdout, code } = await runDash({
    HOME: testHome,
    XDG_CONFIG_HOME: resolve(testHome, ".config"),
    NO_COLOR: "1", // Disable colors for consistent testing
  });

  assert.equal(code, 0, "should exit 0");
  assert.match(stdout, /cchandoff dash/, "should show header");
  assert.match(stdout, /personal/, "should show profile name");
  assert.match(stdout, /5h/, "should show 5h label");
  assert.match(stdout, /wk/, "should show weekly label");
  // Profile has no usage data planted: bars must say so rather than a fake 0%
  assert.match(stdout, /no recent data/, "empty profile shows no-data state");
  assert.doesNotMatch(stdout, /\b0% · resets/, "never renders a fake 0% bar");
  await rm(testHome, { recursive: true, force: true });
});

test("dash --once: NO_COLOR strips ANSI codes", async () => {
  const testHome = resolve(testDir, "home2");
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

  const { stdout, code } = await runDash({
    HOME: testHome,
    XDG_CONFIG_HOME: resolve(testHome, ".config"),
    NO_COLOR: "1",
  });

  assert.equal(code, 0);
  // Check that output contains no ANSI escape codes
  assert.equal(
    stdout.includes("\x1b["),
    false,
    "should not contain ANSI escape codes when NO_COLOR=1"
  );
  await rm(testHome, { recursive: true, force: true });
});

test("dash --once: renders multiple profiles", async () => {
  const testHome = resolve(testDir, "home3");
  const personalDir = resolve(testHome, ".claude");
  const workDir = resolve(testHome, ".claude-work");
  await mkdir(resolve(testHome, ".config/cchandoff"), { recursive: true });
  await mkdir(personalDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(
    resolve(testHome, ".config/cchandoff/config.json"),
    JSON.stringify({
      schema: 1,
      profiles: {
        personal: { configDir: personalDir },
        work: { configDir: workDir },
      },
      settings: {},
    })
  );

  const { stdout, code } = await runDash({
    HOME: testHome,
    XDG_CONFIG_HOME: resolve(testHome, ".config"),
    NO_COLOR: "1",
  });

  assert.equal(code, 0);
  assert.match(stdout, /personal/, "should show personal profile");
  assert.match(stdout, /work/, "should show work profile");
  await rm(testHome, { recursive: true, force: true });
});
