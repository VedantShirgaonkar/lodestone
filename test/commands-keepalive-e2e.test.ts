import { test } from "node:test";
import assert from "node:assert";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { mungeCwd } from "../src/core/paths.js";

const __testDir = fileURLToPath(new URL(".", import.meta.url));
const CLI = resolve(__testDir, "../..", "bin/lodestone.js");
// From dist-test/test/ back to the repo's test/: the shell script is not
// TypeScript, so it never lands in dist-test, and a path inside dist-test
// makes every ping spawn ENOENT (recorded as exit 1) while the fake-claude
// log stays empty.
const FAKE_CLAUDE = resolve(__testDir, "../..", "test/fake-claude.sh");

/**
 * The full keepalive lifecycle, against a fake claude and a 1-second interval.
 *
 * This is the test the feature never had. The scheduler this command claims to
 * spawn did not exist for four releases: the spawn pointed at a file nobody
 * had written, the detached child died silently on MODULE_NOT_FOUND, and
 * "Keepalive started (pid N)" printed a dead pid, which `--status` then
 * repeated forever because it never once asked the OS whether the pid was
 * alive. The old tests stopped at the error paths with a comment that
 * sessions "can't be created in tests" — they can, the hook tests do it —
 * so five green ticks stood over a feature that had never sent a ping.
 */

function runCli(
  args: string[],
  env: Record<string, string>,
  cwd?: string
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, ...env }, cwd, timeout: 30000 },
      (err: unknown, stdout: string, stderr: string) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : err
              ? 1
              : 0;
        done({ stdout, stderr, code });
      }
    );
  });
}

/** A scratch world with one profile, one project, one live session. */
function world(): { env: Record<string, string>; home: string; projectRoot: string; pingLog: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "lodestone-ka-")));
  const claudeDir = join(home, "claude-cfg");
  const projectRoot = join(home, "work", "app");
  mkdirSync(join(projectRoot, ".git"), { recursive: true });

  const configDir = join(home, ".config", "lodestone");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      schema: 1,
      profiles: { personal: { configDir: claudeDir } },
      settings: {},
    }),
    "utf8"
  );

  const sessionId = "aaaabbbb-1111-2222-3333-ccccddddeeee";
  const projectDir = join(claudeDir, "projects", mungeCwd(projectRoot));
  mkdirSync(projectDir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(projectDir, `${sessionId}.jsonl`),
    [
      JSON.stringify({
        type: "user",
        uuid: "u1",
        sessionId,
        timestamp: now,
        cwd: projectRoot,
        message: { role: "user", content: "hello" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        sessionId,
        timestamp: now,
        cwd: projectRoot,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          usage: {
            input_tokens: 50,
            output_tokens: 10,
            cache_read_input_tokens: 60000,
            cache_creation_input_tokens: 500,
          },
        },
      }),
    ].join("\n"),
    "utf8"
  );

  const pingLog = join(home, "fake-claude.log");
  return {
    home,
    projectRoot,
    pingLog,
    env: {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      LODESTONE_CLAUDE_BIN: FAKE_CLAUDE,
      LODESTONE_FAKE_CLAUDE_LOG: pingLog,
      FAKE_CLAUDE_STDOUT: JSON.stringify({ result: "ok" }),
      // 1-second interval instead of 52 minutes, so the test observes real
      // pings without waiting an hour.
      LODESTONE_KEEPALIVE_INTERVAL_MS: "1000",
    },
  };
}

/** Count actual claude invocations that were resume-pings. */
function pingCount(pingLog: string): number {
  if (!existsSync(pingLog)) return 0;
  return (readFileSync(pingLog, "utf8").match(/--resume/g) ?? []).length;
}

test("keepalive: schedules, pings, records, and reports honestly", async () => {
  const w = world();

  // Start: 2 pings max, generous duration.
  const start = await runCli(
    ["keepalive", "personal", "--for", "10m", "--max-pings", "2"],
    w.env,
    w.projectRoot
  );
  assert.equal(start.code, 0, `start failed: ${start.stderr}`);
  assert.match(start.stdout, /Keepalive plan for personal/);
  assert.match(start.stdout, /Cost per ping/, "cost must be printed before anything spends");
  assert.match(start.stdout, /Keepalive started \(pid \d+\)/);

  // The state file exists with a real pid.
  const stateFile = join(w.home, ".config", "lodestone", "keepalive-personal.json");
  assert.ok(existsSync(stateFile), "state file must exist");

  // While the scheduler runs, --status must say running.
  const during = await runCli(["keepalive", "--status"], w.env);
  assert.match(during.stdout, /personal: running \(pid \d+\)/, during.stdout);

  // Wait for both pings (1s interval + process startup slack).
  let waited = 0;
  while (pingCount(w.pingLog) < 2 && waited < 15000) {
    await sleep(500);
    waited += 500;
  }
  assert.equal(pingCount(w.pingLog), 2, "the scheduler must actually send its pings");

  // Each ping resumed the right session as a fork, so the user's transcript
  // never grows a junk turn.
  const log = readFileSync(w.pingLog, "utf8");
  assert.match(log, /aaaabbbb-1111-2222-3333-ccccddddeeee/, "must resume the project's session");
  assert.match(log, /--fork-session/, "pings must fork, not append to the real session");
  assert.match(log, /CLAUDE_CONFIG_DIR=.*claude-cfg/, "ping must run as the kept-warm profile");

  // Both pings recorded in the state file.
  let recorded = 0;
  waited = 0;
  while (recorded < 2 && waited < 10000) {
    await sleep(500);
    waited += 500;
    try {
      recorded = (JSON.parse(readFileSync(stateFile, "utf8")) as { pings: unknown[] }).pings.length;
    } catch {
      recorded = 0;
    }
  }
  assert.equal(recorded, 2, "pings must be recorded in the state file");

  // Cap reached → scheduler exits on its own → status must stop claiming it runs.
  waited = 0;
  let statusOut = "";
  while (waited < 10000) {
    await sleep(500);
    waited += 500;
    statusOut = (await runCli(["keepalive", "--status"], w.env)).stdout;
    if (/not running/.test(statusOut)) break;
  }
  assert.match(
    statusOut,
    /personal: not running — 2\/2 ping\(s\) recorded/,
    `status must report the finished run honestly, got: ${statusOut}`
  );
});

test("keepalive: --stop kills a live scheduler and cleans up", async () => {
  const w = world();

  const start = await runCli(
    ["keepalive", "personal", "--for", "10m", "--max-pings", "3"],
    w.env,
    w.projectRoot
  );
  assert.equal(start.code, 0, start.stderr);

  const stop = await runCli(["keepalive", "--stop", "personal"], w.env);
  assert.match(stop.stdout, /Stopped keepalive for personal \(was pid \d+\)/, stop.stdout);

  const after = await runCli(["keepalive", "--status"], w.env);
  assert.match(after.stdout, /No active keepalive schedulers/, after.stdout);

  // Stopping again is a no-op, not an error.
  const again = await runCli(["keepalive", "--stop", "personal"], w.env);
  assert.match(again.stdout, /No active keepalive for personal/);
});

test("switch --keep-warm: the documented flag works, and keepalive targets the profile being left", async () => {
  const w = world();

  // A second profile to switch to.
  const cfgPath = join(w.home, ".config", "lodestone", "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.profiles.work = { configDir: join(w.home, "claude-cfg-work") };
  writeFileSync(cfgPath, JSON.stringify(cfg), "utf8");
  mkdirSync(join(w.home, "claude-cfg-work"), { recursive: true });

  // --stay so the test does not launch an interactive claude.
  const result = await runCli(
    ["switch", "work", "--stay", "--keep-warm", "5m"],
    w.env,
    w.projectRoot
  );

  // README documented `switch work --keep-warm 90m` while switch's strict
  // parser had no such option, so the documented command exited with
  // "Unknown option '--keep-warm'".
  assert.doesNotMatch(result.stderr, /Unknown option/, result.stderr);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Keepalive plan for personal/, "must warm the profile being LEFT");
  assert.match(result.stdout, /Keepalive started/);

  await runCli(["keepalive", "--stop"], w.env);
});

test("keepalive: cwd with a space still finds its session", async () => {
  // The munge bug and the keepalive ghost compounded: even with a scheduler,
  // a project at a path with a space could never have found its session.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "lodestone-ka-space-")));
  const claudeDir = join(home, "claude-cfg");
  const projectRoot = join(home, "My Work", "app");
  mkdirSync(join(projectRoot, ".git"), { recursive: true });
  const configDir = join(home, ".config", "lodestone");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ schema: 1, profiles: { personal: { configDir: claudeDir } }, settings: {} }),
    "utf8"
  );
  const projectDir = join(claudeDir, "projects", mungeCwd(projectRoot));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, "sess-1.jsonl"),
    JSON.stringify({
      type: "assistant",
      uuid: "a1",
      sessionId: "sess-1",
      timestamp: new Date().toISOString(),
      cwd: projectRoot,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
      },
    }),
    "utf8"
  );

  const env = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    LODESTONE_CLAUDE_BIN: FAKE_CLAUDE,
    LODESTONE_KEEPALIVE_INTERVAL_MS: "60000",
  };

  const result = await new Promise<{ stdout: string; stderr: string; code: number }>((done) => {
    execFile(
      process.execPath,
      [CLI, "keepalive", "personal", "--for", "5m", "--max-pings", "1"],
      { env: { ...process.env, ...env }, cwd: projectRoot, timeout: 30000 },
      (err: unknown, stdout: string, stderr: string) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : err
              ? 1
              : 0;
        done({ stdout, stderr, code });
      }
    );
  });

  assert.doesNotMatch(result.stderr, /No session found/, result.stderr);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

  await runCli(["keepalive", "--stop"], env);
});
