import { test } from "node:test";
import assert from "node:assert";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mungeCwd } from "../src/core/paths.js";

const __testDir = fileURLToPath(new URL(".", import.meta.url));
const CLI = resolve(__testDir, "../..", "bin/lodestone.js");
const FAKE_CLAUDE = resolve(__testDir, "../..", "test/fake-claude.sh");

function runCli(
  args: string[],
  env: Record<string, string>,
  opts?: { cwd?: string; stdin?: string }
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((done) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, ...env }, cwd: opts?.cwd, timeout: 20000 },
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
    if (opts?.stdin !== undefined) {
      child.stdin?.end(opts.stdin);
    } else {
      child.stdin?.end();
    }
  });
}

/** Scratch home with one profile and one live session in one project. */
function world(): { env: Record<string, string>; home: string; claudeDir: string; projectRoot: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "lodestone-misc-")));
  const claudeDir = join(home, ".claude");
  const projectRoot = join(home, "proj");
  mkdirSync(join(projectRoot, ".git"), { recursive: true });

  const configDir = join(home, ".config", "lodestone");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ schema: 1, profiles: { personal: { configDir: claudeDir } }, settings: {} }),
    "utf8"
  );

  const sessionId = "12121212-3434-5656-7878-909090909090";
  const projectDir = join(claudeDir, "projects", mungeCwd(projectRoot));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, `${sessionId}.jsonl`),
    [
      JSON.stringify({
        type: "user",
        uuid: "u1",
        sessionId,
        timestamp: new Date().toISOString(),
        cwd: projectRoot,
        message: { role: "user", content: "build the thing" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        sessionId,
        timestamp: new Date().toISOString(),
        cwd: projectRoot,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "built" }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 30000,
            cache_creation_input_tokens: 1000,
          },
        },
      }),
    ].join("\n"),
    "utf8"
  );

  return {
    home,
    claudeDir,
    projectRoot,
    env: {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      LODESTONE_CLAUDE_BIN: FAKE_CLAUDE,
    },
  };
}

test("cli: a typo'd command explains itself instead of failing as a launcher", async () => {
  const w = world();

  // `lodestone stauts` used to fall straight through to the profile launcher
  // and answer "profile not found: stauts", which reads like a profile
  // problem, not a typo.
  const result = await runCli(["stauts"], w.env);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unknown command or profile: stauts/);
  assert.match(result.stderr, /lodestone --help/);
  assert.match(result.stderr, /profile list/);
});

test("cli: help exists for every command the README points at", async () => {
  const w = world();
  for (const cmd of ["config", "trail", "refresh", "init", "switch"]) {
    const { stdout } = await runCli(["help", cmd], w.env);
    assert.doesNotMatch(stdout, /Unknown command/, `help ${cmd} must exist`);
    assert.match(stdout, new RegExp(`lodestone ${cmd}`), `help ${cmd} must describe itself`);
  }
  // And the global list mentions them.
  const { stdout: help } = await runCli(["--help"], w.env);
  for (const cmd of ["config", "trail", "refresh"]) {
    assert.match(help, new RegExp(`^  ${cmd}`, "m"), `--help must list ${cmd}`);
  }
});

test("cli: profile rename refuses to overwrite an existing profile", async () => {
  const w = world();
  const cfgPath = join(w.home, ".config", "lodestone", "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      schema: 1,
      profiles: {
        personal: { configDir: w.claudeDir },
        work: { configDir: join(w.home, "work-cfg") },
      },
      settings: {},
    }),
    "utf8"
  );

  const result = await runCli(["profile", "rename", "personal", "work"], w.env);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /already exists: work/);

  // And nothing was lost.
  const after = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.ok(after.profiles.personal, "source profile intact");
  assert.ok(after.profiles.work, "target profile intact");
});

test("cli: init installs the /handoff skill into each profile", async () => {
  const w = world();
  mkdirSync(w.claudeDir, { recursive: true });

  const result = await runCli(["init"], w.env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /skill: \/handoff installed/);

  // Where Claude Code discovers personal skills for this profile. Nothing
  // installed this file on the documented setup path for four releases, so
  // the README, the wizard and the advisor all recommended a /handoff command
  // that did not exist in anyone's session.
  assert.ok(
    existsSync(join(w.claudeDir, "skills", "handoff", "SKILL.md")),
    "the skill must land in the profile's skills dir"
  );

  // doctor verifies it by looking, and fails when it is missing.
  const doctorOk = await runCli(["doctor"], w.env);
  assert.match(doctorOk.stdout, /ok: skill \/handoff \(personal\)/);
});

test("statusline: without live rate_limits it reports measured tokens, never a percentage", async () => {
  const w = world();

  // No rate_limits in the payload → the estimate path.
  const payload = JSON.stringify({
    session_id: "s1",
    workspace: { current_dir: w.projectRoot },
  });
  const { stdout, code } = await runCli(["statusline"], w.env, {
    cwd: w.projectRoot,
    stdin: payload,
  });

  assert.equal(code, 0);
  // The 9297% rule: a percentage needs a budget, the budget would be a guess
  // at the user's plan, and the statusline was the one surface still dividing
  // a real measurement by that guess and printing the result.
  assert.doesNotMatch(stdout, /≈\d+%/, `no fabricated percentage: ${stdout}`);
  assert.doesNotMatch(stdout, /\?%/, `no question-mark percentage either: ${stdout}`);
  assert.match(stdout, /5h ~[\d.]+[kM]? est/, `measured tokens, labeled est: ${stdout}`);
});

test("handoff --distill --session: reaches the distiller instead of throwing on require()", async () => {
  const w = world();

  // The distiller is the fake claude, which answers with a plausible result.
  const result = await runCli(
    ["handoff", "--distill", "--session", "12121212-3434-5656-7878-909090909090"],
    {
      ...w.env,
      // fake-claude.sh exits before printing anything unless it has a log file.
      LODESTONE_FAKE_CLAUDE_LOG: join(w.home, "fake-claude.log"),
      FAKE_CLAUDE_STDOUT: JSON.stringify({
        result:
          "## Goal\nok\n\n## State of work\nok\n\n## Key decisions & constraints\nok\n\n## Files in play\nok\n\n## Last exchange\nok\n\n## Next steps\nok",
      }),
    },
    { cwd: w.projectRoot }
  );

  // This exact invocation used to die inside a local findSessionById built on
  // require(), which does not exist in an ES module: "lodestone handoff:
  // require is not defined", exit 1.
  assert.doesNotMatch(result.stderr, /require is not defined/, result.stderr);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /distilling on profile personal/, "cost line must print before spending");
  assert.match(result.stdout, /distilled: \.claude\/handoff\/latest\.md/);
});

test("uninstall: removes exactly what init installed, and nothing of the user's", async () => {
  const w = world();
  mkdirSync(w.claudeDir, { recursive: true });

  // The user has their own hook and their own statusline before lodestone.
  writeFileSync(
    join(w.claudeDir, "settings.json"),
    JSON.stringify({
      statusLine: { type: "command", command: "my-own-statusline" },
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "some-other-tool --init" }] }],
      },
    }),
    "utf8"
  );

  // Install (statusline install must refuse to clobber theirs without --force).
  const init1 = await runCli(["init", "--statusline"], w.env);
  assert.equal(init1.code, 0, init1.stderr);
  assert.match(init1.stderr + init1.stdout, /already set/, "must not clobber a foreign statusline");

  const un = await runCli(["uninstall"], w.env);
  assert.equal(un.code, 0, un.stderr);
  assert.match(un.stdout, /hooks removed/);
  assert.match(un.stdout, /\/handoff skill removed/);
  assert.match(un.stdout, /left in place/);

  const settings = JSON.parse(readFileSync(join(w.claudeDir, "settings.json"), "utf8"));
  const flat = JSON.stringify(settings);
  assert.doesNotMatch(flat, /lodestone hook/, "our hooks must be gone");
  assert.match(flat, /some-other-tool --init/, "their hook must survive");
  assert.equal(
    settings.statusLine?.command,
    "my-own-statusline",
    "their statusline is not ours to take down"
  );
  assert.ok(
    !existsSync(join(w.claudeDir, "skills", "handoff", "SKILL.md")),
    "the skill file must be gone"
  );

  // Idempotent: a second run finds nothing and still exits 0.
  const again = await runCli(["uninstall"], w.env);
  assert.equal(again.code, 0);
});

test("uninstall: takes down our own statusline when it is ours", async () => {
  const w = world();
  mkdirSync(w.claudeDir, { recursive: true });

  await runCli(["init", "--statusline"], w.env);
  const before = JSON.parse(readFileSync(join(w.claudeDir, "settings.json"), "utf8"));
  assert.equal(before.statusLine?.command, "lodestone statusline");

  const un = await runCli(["uninstall"], w.env);
  assert.match(un.stdout, /statusline removed/);
  const after = JSON.parse(readFileSync(join(w.claudeDir, "settings.json"), "utf8"));
  assert.equal(after.statusLine, undefined, "our statusline must be gone");
});

test("profile add: the new profile is wired immediately, hooks and skill included", async () => {
  const w = world();
  mkdirSync(w.claudeDir, { recursive: true });

  // The user set up the statusline on their first profile.
  await runCli(["init", "--statusline"], w.env);

  const result = await runCli(["profile", "add", "work"], w.env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /profile added: work/);
  assert.match(result.stdout, /hooks installed/);
  assert.match(result.stdout, /skill: \/handoff installed/);
  assert.match(result.stdout, /statusline configured/, "statusline intent inherits to the new account");
  assert.match(result.stdout, /lodestone login work/);

  // doctor should be green for the NEW profile with zero extra steps. A
  // profile added after init used to get nothing, and doctor was the first
  // place anyone found out.
  const doctorOut = (await runCli(["doctor"], w.env)).stdout;
  assert.match(doctorOut, /ok: hooks \(work\)/, doctorOut);
  assert.match(doctorOut, /ok: skill \/handoff \(work\)/, doctorOut);
});

test("statusline: a feed overshoot renders as 100%, never 107%", async () => {
  const w = world();

  // Claude Code's rate_limits can transiently report >100 right after a limit
  // lands; a real render showed "5h 107%" tagged live on three surfaces at
  // once. A window cannot be more than fully used.
  const payload = JSON.stringify({
    session_id: "s1",
    workspace: { current_dir: w.projectRoot },
    rate_limits: {
      five_hour: { used_percentage: 107.3, resets_at: Math.floor(Date.now() / 1000) + 5400 },
      seven_day: { used_percentage: 45, resets_at: Math.floor(Date.now() / 1000) + 200000 },
    },
  });
  const { stdout, code } = await runCli(["statusline"], w.env, {
    cwd: w.projectRoot,
    stdin: payload,
  });

  assert.equal(code, 0);
  assert.doesNotMatch(stdout, /10[1-9]%|1[1-9]\d%/, `no impossible percentage: ${stdout}`);
  assert.match(stdout, /5h .*100%/, `clamps to the limit: ${stdout}`);

  // And the bridge cache it wrote for every other surface is clamped too.
  const cached = JSON.parse(
    readFileSync(join(w.claudeDir, "lodestone", "usage-cache.json"), "utf8")
  );
  assert.equal(cached.five_hour.used_percentage, 100, "the cache must not propagate 107");
});
