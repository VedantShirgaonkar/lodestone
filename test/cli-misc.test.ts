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
