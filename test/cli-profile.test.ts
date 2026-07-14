import test from "node:test";
import assert from "node:assert";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.js";
import { mungeCwd } from "../src/core/paths.js";
import { parseSession, latestContextTokens } from "../src/core/transcript.js";
import { switchTax } from "../src/core/usage.js";
import { loadLatestHandoff, estimateTokens } from "../src/core/handoffFile.js";

const testDir = resolve(tmpdir(), `lodestone-test-${Date.now()}`);

// Absolute paths that survive process.chdir() — fixtures are copied next to the
// compiled tests by pretest; fake-claude.sh stays in the source tree.
const __testDir = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_SMALL = resolve(__testDir, "fixtures/session-small.jsonl");
const FAKE_CLAUDE = resolve(__testDir, "../..", "test/fake-claude.sh");

/**
 * Point the entire config environment at a scratch home for the duration of fn.
 *
 * Overriding HOME alone is not enough, and quietly not enough: lodestoneConfigPath()
 * prefers XDG_CONFIG_HOME and only falls back to HOME. On any machine that sets
 * XDG_CONFIG_HOME (every GitHub runner, and most Linux desktops) a test that
 * overrides HOME alone reads and WRITES the developer's real lodestone config,
 * while passing on a Mac where the variable happens to be unset. Each of these
 * tests used to hand-roll its own save/restore of a slightly different set of
 * variables, which is exactly how the gap opened.
 */
async function withScratchHome(
  testHome: string,
  fn: () => Promise<void>,
  extra: Record<string, string> = {}
): Promise<void> {
  const keys = ["HOME", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", ...Object.keys(extra)];
  const saved = new Map(keys.map((k) => [k, process.env[k]]));

  process.env.HOME = testHome;
  process.env.XDG_CONFIG_HOME = resolve(testHome, ".config");
  delete process.env.CLAUDE_CONFIG_DIR;
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;

  try {
    await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Profile tests
test("cli: profile add creates profile", async () => {
  const testHome = resolve(testDir, "home1");
  try {
    await mkdir(resolve(testHome, ".config/lodestone"), { recursive: true });
    const configPath = resolve(testHome, ".config/lodestone/config.json");
    await writeFile(configPath, JSON.stringify({ schema: 1, profiles: {}, settings: {} }));

    await withScratchHome(testHome, async () => {
      const result = await main(["profile", "add", "test-profile"]);
      assert.strictEqual(result, 0);
      const config = JSON.parse(await readFile(configPath, "utf-8"));
      assert.ok(config.profiles["test-profile"]);
    });
  } finally {
    await rm(testHome, { recursive: true, force: true });
  }
});

test("cli: profile add rejects duplicate", async () => {
  const testHome = resolve(testDir, "home2");
  try {
    await mkdir(resolve(testHome, ".config/lodestone"), { recursive: true });
    const configPath = resolve(testHome, ".config/lodestone/config.json");
    await writeFile(configPath, JSON.stringify({ schema: 1, profiles: { existing: { configDir: `${testHome}/.claude-profiles/existing` } }, settings: {} }));

    await withScratchHome(testHome, async () => {
      const result = await main(["profile", "add", "existing"]);
      assert.strictEqual(result, 1);
    });
  } finally {
    await rm(testHome, { recursive: true, force: true });
  }
});

test("cli: profile list shows profiles", async () => {
  const testHome = resolve(testDir, "home3");
  try {
    await mkdir(resolve(testHome, ".config/lodestone"), { recursive: true });
    const configPath = resolve(testHome, ".config/lodestone/config.json");
    await writeFile(configPath, JSON.stringify({ schema: 1, profiles: { personal: { configDir: `${testHome}/.claude` }, work: { configDir: `${testHome}/.claude-profiles/work` } }, settings: {} }));

    await withScratchHome(
      testHome,
      async () => {
        let output = "";
        const oldLog = console.log;
        console.log = (msg: string) => { output += msg + "\n"; };
        try {
          const result = await main(["profile", "list"]);
          assert.strictEqual(result, 0);
          assert.match(output, /personal/);
          assert.match(output, /work/);
        } finally {
          console.log = oldLog;
        }
      },
      { CLAUDE_CONFIG_DIR: `${testHome}/.claude` }
    );
  } finally {
    await rm(testHome, { recursive: true, force: true });
  }
});

test("cli: profile remove removes from registry", async () => {
  const testHome = resolve(testDir, "home4");
  try {
    await mkdir(resolve(testHome, ".config/lodestone"), { recursive: true });
    const configPath = resolve(testHome, ".config/lodestone/config.json");
    await writeFile(configPath, JSON.stringify({ schema: 1, profiles: { doomed: { configDir: `${testHome}/.claude-profiles/doomed` } }, settings: {} }));

    await withScratchHome(testHome, async () => {
      const result = await main(["profile", "remove", "doomed"]);
      assert.strictEqual(result, 0);
      const config = JSON.parse(await readFile(configPath, "utf-8"));
      assert.ok(!config.profiles["doomed"]);
    });
  } finally {
    await rm(testHome, { recursive: true, force: true });
  }
});

// Command integration tests (per coordinator feedback)
test("cli: doctor checks claude on PATH", async () => {
  try {
    const testHome = resolve(testDir, "doctor1");
    const claudeDir = resolve(testHome, ".claude");
    await mkdir(resolve(testHome, ".config/lodestone"), { recursive: true });
    await mkdir(claudeDir, { recursive: true });

    // Write .claude.json with login info
    await writeFile(resolve(claudeDir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "t@example.com", organizationName: "Test Org" } }));

    // doctor verifies our hooks are actually wired in, so plant the whole set
    // for the all-green case. Planting only SessionStart used to pass, because
    // doctor tested for the substring "lodestone hook" and then printed all
    // four names regardless — a profile with one hook was certified as having
    // four. A partial install is a broken install, and the next test asserts so.
    await writeFile(
      resolve(claudeDir, "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { matcher: "startup|clear", hooks: [{ type: "command", command: "lodestone hook session-start" }] },
          ],
          SessionEnd: [{ hooks: [{ type: "command", command: "lodestone hook session-end" }] }],
          PreCompact: [{ hooks: [{ type: "command", command: "lodestone hook pre-compact" }] }],
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: "lodestone hook user-prompt-submit" }] },
          ],
        },
      })
    );

    const configPath = resolve(testHome, ".config/lodestone/config.json");
    await writeFile(configPath, JSON.stringify({ schema: 1, profiles: { personal: { configDir: claudeDir } }, settings: {} }));

    const oldHome = process.env.HOME;
    const oldXdgConfig = process.env.XDG_CONFIG_HOME;
    const oldClaudeBin = process.env.LODESTONE_CLAUDE_BIN;
    process.env.HOME = testHome;
    process.env.XDG_CONFIG_HOME = resolve(testHome, ".config");
    process.env.LODESTONE_CLAUDE_BIN = FAKE_CLAUDE;

    let output = "";
    const oldLog = console.log;
    console.log = (msg: string) => { output += msg + "\n"; };

    try {
      const result = await main(["doctor"]);
      assert.strictEqual(result, 0);
      assert.match(output, /claude binary/);
    } finally {
      console.log = oldLog;
      if (oldHome !== undefined) process.env.HOME = oldHome;
      else delete process.env.HOME;
      if (oldXdgConfig !== undefined) process.env.XDG_CONFIG_HOME = oldXdgConfig;
      else delete process.env.XDG_CONFIG_HOME;
      if (oldClaudeBin !== undefined) process.env.LODESTONE_CLAUDE_BIN = oldClaudeBin;
      else delete process.env.LODESTONE_CLAUDE_BIN;
    }
  } finally {
    await rm(resolve(testDir, "doctor1"), { recursive: true, force: true });
  }
});

test("cli: snapshot extracts session to handoff file", async () => {
  try {
    const testHome = resolve(testDir, "snapshot1");
    const testProject = resolve(testHome, "project");
    const configDir = resolve(testHome, ".claude");

    await mkdir(testProject, { recursive: true });
    await mkdir(resolve(testProject, ".git"));
    await mkdir(resolve(testHome, ".config/lodestone"), { recursive: true });
    await mkdir(configDir, { recursive: true });

    const configPath = resolve(testHome, ".config/lodestone/config.json");
    await writeFile(configPath, JSON.stringify({ schema: 1, profiles: { personal: { configDir } }, settings: {} }));

    const oldCwd = process.cwd();
    process.chdir(testProject);
    const munged = mungeCwd(process.cwd());
    const sessionDir = resolve(configDir, "projects", munged);
    await mkdir(sessionDir, { recursive: true });

    const fixtureContent = await readFile(FIXTURE_SMALL, "utf8");
    await writeFile(resolve(sessionDir, "sess-123.jsonl"), fixtureContent);

    const oldHome = process.env.HOME;
    const oldXdgConfig = process.env.XDG_CONFIG_HOME;
    const oldClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = testHome;
    process.env.XDG_CONFIG_HOME = resolve(testHome, ".config");
    process.env.CLAUDE_CONFIG_DIR = configDir;

    let output = "";
    let errorOutput = "";
    const oldLog = console.log;
    const oldError = console.error;
    console.log = (msg: string) => { output += msg + "\n"; };
    console.error = (msg: string) => { errorOutput += msg + "\n"; };

    try {
      const result = await main(["snapshot"]);
      assert.strictEqual(result, 0, `snapshot should succeed (stderr: ${errorOutput})`);
      assert.match(output, /snapshot:/);

      const handoffPath = resolve(testProject, ".claude/handoff/latest.md");
      const handoffContent = await readFile(handoffPath, "utf8");
      assert.match(handoffContent, /## Goal/);
      assert.match(handoffContent, /todo list/i);
    } finally {
      console.log = oldLog;
      console.error = oldError;
      process.chdir(oldCwd);
      if (oldHome !== undefined) process.env.HOME = oldHome;
      else delete process.env.HOME;
      if (oldXdgConfig !== undefined) process.env.XDG_CONFIG_HOME = oldXdgConfig;
      else delete process.env.XDG_CONFIG_HOME;
      if (oldClaudeConfig !== undefined) process.env.CLAUDE_CONFIG_DIR = oldClaudeConfig;
      else delete process.env.CLAUDE_CONFIG_DIR;
    }
  } finally {
    await rm(resolve(testDir, "snapshot1"), { recursive: true, force: true });
  }
});

test("cli: status --json outputs stable schema", async () => {
  try {
    const testHome = resolve(testDir, "status1");
    const testProject = resolve(testHome, "project");
    const configDir = resolve(testHome, ".claude");

    await mkdir(testProject, { recursive: true });
    await mkdir(resolve(testHome, ".config/lodestone"), { recursive: true });
    await mkdir(configDir, { recursive: true });

    const configPath = resolve(testHome, ".config/lodestone/config.json");
    await writeFile(configPath, JSON.stringify({ schema: 1, profiles: { personal: { configDir }, empty: { configDir: resolve(testHome, ".claude-profiles/empty") } }, settings: { plan: "pro" } }));

    const oldCwd = process.cwd();
    process.chdir(testProject);
    const munged = mungeCwd(process.cwd());
    const sessionDir = resolve(configDir, "projects", munged);
    await mkdir(sessionDir, { recursive: true });

    const fixtureContent = await readFile(FIXTURE_SMALL, "utf8");
    const now = new Date();
    const fewMinutesAgo = new Date(now.getTime() - 5 * 60000);
    const isoTime = fewMinutesAgo.toISOString();
    const updatedContent = fixtureContent.replace(/"timestamp":"[^"]+"/g, `"timestamp":"${isoTime}"`);
    await writeFile(resolve(sessionDir, "sess-123.jsonl"), updatedContent);

    const oldHome = process.env.HOME;
    const oldXdgConfig = process.env.XDG_CONFIG_HOME;
    process.env.HOME = testHome;
    process.env.XDG_CONFIG_HOME = resolve(testHome, ".config");

    let output = "";
    const oldLog = console.log;
    console.log = (msg: string) => { output += msg + "\n"; };

    try {
      const result = await main(["status", "--json"]);
      assert.strictEqual(result, 0);

      const parsed = JSON.parse(output);
      assert.ok(Array.isArray(parsed.profiles));
      assert.ok(parsed.profiles.length >= 2);

      const personalProfile = parsed.profiles.find((p: any) => p.name === "personal");
      assert.ok(personalProfile);
      assert.ok(personalProfile.window && personalProfile.window.burn > 0);
      assert.ok(personalProfile.sessions.length > 0);
      assert.ok(personalProfile.sessions[0].contextTokens > 0);
      assert.ok(typeof personalProfile.sessions[0].idleMinutes === "number");

      const emptyProfile = parsed.profiles.find((p: any) => p.name === "empty");
      assert.ok(emptyProfile);
      assert.strictEqual(emptyProfile.window, null);
    } finally {
      console.log = oldLog;
      process.chdir(oldCwd);
      if (oldHome !== undefined) process.env.HOME = oldHome;
      else delete process.env.HOME;
      if (oldXdgConfig !== undefined) process.env.XDG_CONFIG_HOME = oldXdgConfig;
      else delete process.env.XDG_CONFIG_HOME;
    }
  } finally {
    await rm(resolve(testDir, "status1"), { recursive: true, force: true });
  }
});

test("cli: switch --stay prepares handoff without launching", async () => {
  try {
    const testHome = resolve(testDir, "switch1");
    const testProject = resolve(testHome, "project");
    const personalConfigDir = resolve(testHome, ".claude");
    const workConfigDir = resolve(testHome, ".claude-profiles/work");

    await mkdir(testProject, { recursive: true });
    await mkdir(resolve(testProject, ".git"));
    await mkdir(resolve(testHome, ".config/lodestone"), { recursive: true });
    await mkdir(personalConfigDir, { recursive: true });
    await mkdir(workConfigDir, { recursive: true });

    const configPath = resolve(testHome, ".config/lodestone/config.json");
    await writeFile(configPath, JSON.stringify({ schema: 1, profiles: { personal: { configDir: personalConfigDir }, work: { configDir: workConfigDir } }, settings: {} }));

    const oldCwd = process.cwd();
    process.chdir(testProject);
    const munged = mungeCwd(process.cwd());
    const sessionDir = resolve(personalConfigDir, "projects", munged);
    await mkdir(sessionDir, { recursive: true });

    const fixtureContent = await readFile(FIXTURE_SMALL, "utf8");
    await writeFile(resolve(sessionDir, "sess-123.jsonl"), fixtureContent);

    const oldHome = process.env.HOME;
    const oldXdgConfig = process.env.XDG_CONFIG_HOME;
    const oldClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
    const oldNoColor = process.env.NO_COLOR;

    process.env.HOME = testHome;
    process.env.XDG_CONFIG_HOME = resolve(testHome, ".config");
    process.env.CLAUDE_CONFIG_DIR = personalConfigDir;
    process.env.NO_COLOR = "1";

    let output = "";
    const oldLog = console.log;
    console.log = (msg: string) => { output += msg + "\n"; };

    try {
      const result = await main(["switch", "work", "--stay"]);
      assert.strictEqual(result, 0);
      assert.match(output, /switching/);

      const handoffPath = resolve(testProject, ".claude/handoff/latest.md");
      const handoffExists = await readFile(handoffPath, "utf8").then(() => true, () => false);
      assert.ok(handoffExists);

      const parsed = await parseSession(resolve(sessionDir, "sess-123.jsonl"));
      const contextTokens = latestContextTokens(parsed);
      const handoffData = loadLatestHandoff(testProject);

      if (handoffData && contextTokens > 0) {
        const handoffTokens = estimateTokens(handoffData.markdown);
        const expectedTax = switchTax(contextTokens, handoffTokens);
        assert.match(output, new RegExp(`≈ ${expectedTax.naive.toLocaleString()} weighted tokens`));
        assert.match(output, new RegExp(`≈ ${expectedTax.handoff.toLocaleString()} weighted tokens`));
      }
    } finally {
      console.log = oldLog;
      process.chdir(oldCwd);
      if (oldHome !== undefined) process.env.HOME = oldHome;
      else delete process.env.HOME;
      if (oldXdgConfig !== undefined) process.env.XDG_CONFIG_HOME = oldXdgConfig;
      else delete process.env.XDG_CONFIG_HOME;
      if (oldClaudeConfig !== undefined) process.env.CLAUDE_CONFIG_DIR = oldClaudeConfig;
      else delete process.env.CLAUDE_CONFIG_DIR;
      if (oldNoColor !== undefined) process.env.NO_COLOR = oldNoColor;
      else delete process.env.NO_COLOR;
    }
  } finally {
    await rm(resolve(testDir, "switch1"), { recursive: true, force: true });
  }
});

test("cli: switch shows nothing to hand off when no session", async () => {
  try {
    const testHome = resolve(testDir, "switch2");
    const testProject = resolve(testHome, "project");
    const personalConfigDir = resolve(testHome, ".claude");
    const workConfigDir = resolve(testHome, ".claude-profiles/work");

    await mkdir(testProject, { recursive: true });
    await mkdir(resolve(testProject, ".git"));
    await mkdir(resolve(testHome, ".config/lodestone"), { recursive: true });
    await mkdir(personalConfigDir, { recursive: true });
    await mkdir(resolve(personalConfigDir, "projects"), { recursive: true });
    await mkdir(workConfigDir, { recursive: true });

    const configPath = resolve(testHome, ".config/lodestone/config.json");
    await writeFile(configPath, JSON.stringify({ schema: 1, profiles: { personal: { configDir: personalConfigDir }, work: { configDir: workConfigDir } }, settings: {} }));

    const oldHome = process.env.HOME;
    const oldXdgConfig = process.env.XDG_CONFIG_HOME;
    const oldClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
    const oldCwd = process.cwd();
    const oldNoColor = process.env.NO_COLOR;

    process.env.HOME = testHome;
    process.env.XDG_CONFIG_HOME = resolve(testHome, ".config");
    process.env.CLAUDE_CONFIG_DIR = personalConfigDir;
    process.env.NO_COLOR = "1";
    process.chdir(testProject);

    let output = "";
    const oldLog = console.log;
    console.log = (msg: string) => { output += msg + "\n"; };

    try {
      const result = await main(["switch", "work", "--stay"]);
      assert.strictEqual(result, 0);
      assert.match(output, /nothing to hand off/);
      assert.ok(!output.includes("-Infinity"));
      assert.ok(!output.includes("NaN"));
    } finally {
      console.log = oldLog;
      process.chdir(oldCwd);
      if (oldHome !== undefined) process.env.HOME = oldHome;
      else delete process.env.HOME;
      if (oldXdgConfig !== undefined) process.env.XDG_CONFIG_HOME = oldXdgConfig;
      else delete process.env.XDG_CONFIG_HOME;
      if (oldClaudeConfig !== undefined) process.env.CLAUDE_CONFIG_DIR = oldClaudeConfig;
      else delete process.env.CLAUDE_CONFIG_DIR;
      if (oldNoColor !== undefined) process.env.NO_COLOR = oldNoColor;
      else delete process.env.NO_COLOR;
    }
  } finally {
    await rm(resolve(testDir, "switch2"), { recursive: true, force: true });
  }
});

test("cli: --version matches package.json", async () => {
  // 0.2.0 shipped to npm announcing itself as 0.1.0, because the version was
  // typed into cli.ts by hand and drifted.
  const pkg = JSON.parse(
    await readFile(resolve(__testDir, "../..", "package.json"), "utf8")
  );
  let output = "";
  const oldLog = console.log;
  console.log = (msg: string) => { output += msg + "\n"; };
  try {
    await main(["--version"]);
  } finally {
    console.log = oldLog;
  }
  assert.match(output, new RegExp(`lodestone ${pkg.version.replace(/\./g, "\\.")}`));
});
