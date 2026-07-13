import { test } from "node:test";
import assert from "node:assert";
import { init } from "../src/commands/init.js";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";

const testDir = join(tmpdir(), "lodestone-test-init");

const __dir = dirname(fileURLToPath(import.meta.url));
// Compiled tests run from <root>/dist-test/test; sources run from <root>/test.
const projectRoot = __dir.includes("/dist-test/")
  ? join(__dir, "../..")
  : join(__dir, "..");
const cliPath = join(projectRoot, "dist", "cli.js");

/**
 * Run `init` in a child process with a scratch HOME. A command that writes to
 * every configured profile has no business running in-process against the
 * developer's real environment, which is exactly how this suite spent months
 * quietly rewriting the maintainer's own Claude Code settings.
 */
function runInit(
  args: string[],
  env: Record<string, string>
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliPath, "init", ...args],
      { env: { ...process.env, ...env, NO_COLOR: "1" } },
      (err, stdout) => {
        resolve({
          stdout,
          code: err && typeof (err as { code?: number }).code === "number"
            ? ((err as { code?: number }).code as number)
            : 0,
        });
      }
    );
  });
}

test.before(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
  mkdirSync(testDir, { recursive: true });
});

test.after(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
});

test("init: user-level installs hooks into every profile, and only into them", async () => {
  // This test used to call `init([])` with no isolation at all. init with no
  // --project resolves the REAL config, finds the developer's REAL profiles,
  // and writes hooks into their actual ~/.claude/settings.json. It did that on
  // every `npm test`, and because it asserted nothing but "did not throw", it
  // passed the whole time. Point HOME and XDG_CONFIG_HOME at a temp tree, so
  // the only settings this can reach are ones we created.
  const home = join(testDir, "home-user-level");
  const profile1Dir = join(home, "p1");
  const profile2Dir = join(home, "p2");
  mkdirSync(join(home, ".config", "lodestone"), { recursive: true });
  mkdirSync(profile1Dir, { recursive: true });
  mkdirSync(profile2Dir, { recursive: true });

  writeFileSync(
    join(home, ".config", "lodestone", "config.json"),
    JSON.stringify({
      schema: 1,
      profiles: { p1: { configDir: profile1Dir }, p2: { configDir: profile2Dir } },
      settings: { maxAgeDays: 7, autoSnapshot: true },
    }),
    "utf8"
  );

  const { code } = await runInit([], {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
  });
  assert.equal(code, 0);

  for (const dir of [profile1Dir, profile2Dir]) {
    const settingsPath = join(dir, "settings.json");
    assert.ok(existsSync(settingsPath), `hooks written to ${dir}`);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const commands = JSON.stringify(settings.hooks);
    assert.match(commands, /lodestone hook session-start/);
    assert.match(commands, /lodestone hook session-end/);
    assert.match(commands, /lodestone hook pre-compact/);
  }
});

test("init: project-level creates .claude/settings.json", async () => {
  const projectDir = join(testDir, "project1");
  mkdirSync(projectDir, { recursive: true });

  // Mock the findProjectRoot to return our test directory
  const originalCwd = process.cwd;
  process.cwd = () => projectDir;

  const capturedOutput: string[] = [];
  const originalLog = console.log;
  console.log = ((msg: string) => {
    capturedOutput.push(msg);
  }) as typeof console.log;

  process.env.LODESTONE_HOOK_CMD = "test-hook";
  const result = await init(["--project"], { json: false });
  delete process.env.LODESTONE_HOOK_CMD;

  console.log = originalLog;
  process.cwd = originalCwd;

  // Check that .claude/settings.json was created
  const settingsPath = join(projectDir, ".claude", "settings.json");
  assert.ok(existsSync(settingsPath));

  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.ok(settings.hooks);
});

test("init: project-level adds to .gitignore", async () => {
  const projectDir = join(testDir, "project2");
  mkdirSync(projectDir, { recursive: true });

  const originalCwd = process.cwd;
  process.cwd = () => projectDir;

  const capturedOutput: string[] = [];
  const originalLog = console.log;
  console.log = ((msg: string) => {
    capturedOutput.push(msg);
  }) as typeof console.log;

  process.env.LODESTONE_HOOK_CMD = "test-hook";
  const result = await init(["--project"], { json: false });
  delete process.env.LODESTONE_HOOK_CMD;

  console.log = originalLog;
  process.cwd = originalCwd;

  // Check that .gitignore was created/updated
  const gitignorePath = join(projectDir, ".gitignore");
  if (existsSync(gitignorePath)) {
    const gitignoreContent = readFileSync(gitignorePath, "utf8");
    assert.ok(gitignoreContent.includes(".claude/handoff/"));
  }
});

test("init: project-level --statusline sets statusline command", async () => {
  const projectDir = join(testDir, "project3");
  mkdirSync(projectDir, { recursive: true });

  const originalCwd = process.cwd;
  process.cwd = () => projectDir;

  const capturedOutput: string[] = [];
  const originalLog = console.log;
  console.log = ((msg: string) => {
    capturedOutput.push(msg);
  }) as typeof console.log;

  process.env.LODESTONE_HOOK_CMD = "test-hook";
  const result = await init(["--project", "--statusline"], { json: false });
  delete process.env.LODESTONE_HOOK_CMD;

  console.log = originalLog;
  process.cwd = originalCwd;

  // Check that statusLine was set in settings.json
  const settingsPath = join(projectDir, ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.ok(settings.statusLine);
    assert.equal(settings.statusLine.command, "lodestone statusline");
  }
});

/** How many command hooks are registered under an event. */
function hookCount(settings: { hooks?: Record<string, unknown> }, event: string): number {
  const entries = settings.hooks?.[event];
  if (!Array.isArray(entries)) return 0;
  let n = 0;
  for (const entry of entries) {
    const inner = (entry as { hooks?: unknown }).hooks;
    if (Array.isArray(inner)) n += inner.filter((h) => (h as { command?: string }).command).length;
  }
  return n;
}

test("init: is idempotent, and stays idempotent under a custom hook command", async () => {
  // The old version of this test ran init twice, asserted the exit codes were
  // 0-or-1, then read the same file twice and asserted the two reads matched.
  // None of that can fail. Meanwhile the real behaviour was that every run
  // appended another copy of every hook whenever the command did not contain
  // the literal string "lodestone hook", which is exactly what a custom
  // LODESTONE_HOOK_CMD produces. Count the hooks instead.
  for (const hookCmd of [undefined, "test-hook"]) {
    const projectDir = join(testDir, `idem-${hookCmd ?? "default"}`);
    mkdirSync(projectDir, { recursive: true });

    const originalCwd = process.cwd;
    process.cwd = () => projectDir;
    if (hookCmd) process.env.LODESTONE_HOOK_CMD = hookCmd;

    try {
      for (let run = 1; run <= 3; run++) {
        await init(["--project"], { json: false });

        const settings = JSON.parse(
          readFileSync(join(projectDir, ".claude", "settings.json"), "utf8")
        );
        for (const event of ["SessionStart", "SessionEnd", "PreCompact"]) {
          assert.equal(
            hookCount(settings, event),
            1,
            `${event}: exactly one hook after run ${run} (cmd: ${hookCmd ?? "default"})`
          );
        }
      }
    } finally {
      delete process.env.LODESTONE_HOOK_CMD;
      process.cwd = originalCwd;
    }
  }
});
