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

const testDir = join(tmpdir(), "warmswap-test-profiles");
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
