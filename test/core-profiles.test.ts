import { test } from "node:test";
import assert from "node:assert";
import {
  addProfile,
  removeProfile,
  currentProfile,
  loggedInHint,
  adoptDefault,
} from "../src/core/profiles.js";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), "lodestone-test-profiles");
const configDir = join(testDir, "config");
const origXdgConfigHome = process.env.XDG_CONFIG_HOME;

test.before(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
  mkdirSync(testDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  // Use test config dir
  process.env.XDG_CONFIG_HOME = configDir;
});

test.after(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
  // Reset env
  delete process.env.CLAUDE_CONFIG_DIR;
  if (origXdgConfigHome) {
    process.env.XDG_CONFIG_HOME = origXdgConfigHome;
  } else {
    delete process.env.XDG_CONFIG_HOME;
  }
});

test("profiles: addProfile creates profile directory", () => {
  const profileDir = join(testDir, "test-profile");
  addProfile("test", { configDir: profileDir });

  assert.ok(existsSync(profileDir));
});

test("profiles: addProfile rejects existing profile", () => {
  const profileDir = join(testDir, "dup-profile");
  addProfile("dup", { configDir: profileDir });

  assert.throws(
    () => addProfile("dup", { configDir: profileDir }),
    /already exists/
  );
});

test("profiles: removeProfile deletes from registry only", () => {
  const profileDir = join(testDir, "remove-test");
  addProfile("removeme", { configDir: profileDir });

  assert.ok(existsSync(profileDir));

  removeProfile("removeme");

  // Dir should still exist
  assert.ok(existsSync(profileDir));
});

test("profiles: loggedInHint reads .claude.json", () => {
  const profileDir = join(testDir, "logged-in-test");
  mkdirSync(profileDir, { recursive: true });

  const claudeJsonPath = join(profileDir, ".claude.json");
  writeFileSync(
    claudeJsonPath,
    JSON.stringify({
      oauthAccount: {
        emailAddress: "test@example.com",
        organizationName: "Test Org",
      },
    })
  );

  const hint = loggedInHint({ name: "test", configDir: profileDir });
  assert.match(hint, /test@example.com/);
  assert.match(hint, /Test Org/);
});

test("profiles: loggedInHint returns 'not logged in' when missing", () => {
  const profileDir = join(testDir, "no-login-test");
  mkdirSync(profileDir, { recursive: true });

  const hint = loggedInHint({ name: "test", configDir: profileDir });
  assert.equal(hint, "not logged in");
});

test("profiles: currentProfile uses CLAUDE_CONFIG_DIR env", () => {
  const profileDir = join(testDir, "env-profile");
  addProfile("env-test", { configDir: profileDir });

  process.env.CLAUDE_CONFIG_DIR = profileDir;
  const profile = currentProfile();

  assert.equal(profile?.name, "env-test");
  assert.equal(profile?.configDir, profileDir);

  delete process.env.CLAUDE_CONFIG_DIR;
});

test("loggedInHint: a state stub inside the dir must not shadow the sibling account", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { loggedInHint } = await import("../src/core/profiles.js");

  // The layout that produced "not logged in" for a logged-in user: launching
  // Claude Code with CLAUDE_CONFIG_DIR set to the default dir (which is what
  // `lodestone switch personal` does) makes it write a small state stub at
  // ~/.claude/.claude.json with no oauthAccount, while the real account sits
  // in the sibling ~/.claude.json. The old code took the first file that
  // existed; the stub won, and setup/doctor/status/profile-list all lied.
  const home = mkdtempSync(join(tmpdir(), "lodestone-hint-"));
  const configDir = join(home, ".claude");
  mkdirSync(configDir, { recursive: true });

  writeFileSync(
    join(configDir, ".claude.json"),
    JSON.stringify({ firstStartTime: "2026-07-14T09:22:00Z", installMethod: "unknown" }),
    "utf8"
  );
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      oauthAccount: { emailAddress: "real@user.dev", organizationName: "Real Org" },
    }),
    "utf8"
  );

  assert.equal(
    loggedInHint({ name: "personal", configDir }),
    "real@user.dev (Real Org)",
    "the file with the account wins, not the file that merely exists"
  );

  // The reverse layout (a real CLAUDE_CONFIG_DIR profile: account inside,
  // no sibling) keeps working, and inside wins ties.
  const workDir = join(home, "work-cfg");
  mkdirSync(workDir, { recursive: true });
  writeFileSync(
    join(workDir, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "work@user.dev" } }),
    "utf8"
  );
  assert.equal(loggedInHint({ name: "work", configDir: workDir }), "work@user.dev");

  // Neither file has an account: honestly not logged in.
  const bare = join(home, "bare-cfg");
  mkdirSync(bare, { recursive: true });
  writeFileSync(join(bare, ".claude.json"), JSON.stringify({ schema: 1 }), "utf8");
  assert.equal(loggedInHint({ name: "bare", configDir: bare }), "not logged in");
});
