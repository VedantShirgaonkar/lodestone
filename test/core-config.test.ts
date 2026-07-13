import { test } from "node:test";
import assert from "node:assert";
import { loadConfig, saveConfig } from "../src/core/config.js";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), "lodestone-test-config");
const origXdgConfigHome = process.env.XDG_CONFIG_HOME;

test.before(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
  mkdirSync(testDir, { recursive: true });
  // Use test config dir
  process.env.XDG_CONFIG_HOME = testDir;
});

test.after(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
  // Reset env
  if (origXdgConfigHome) {
    process.env.XDG_CONFIG_HOME = origXdgConfigHome;
  } else {
    delete process.env.XDG_CONFIG_HOME;
  }
});

test("config: loadConfig returns default when file missing", () => {
  const configPath = join(testDir, "nonexistent.json");
  const config = loadConfig(configPath);

  assert.equal(config.schema, 1);
  assert.deepEqual(config.profiles, {});
  assert.ok(config.settings.maxAgeDays);
});

test("config: saveConfig writes and reloads atomically", () => {
  const configPath = join(testDir, "test-config.json");

  const config = loadConfig(configPath);
  config.profiles["test"] = { configDir: "/tmp/test" };
  config.settings.maxAgeDays = 14;

  saveConfig(config, configPath);

  const reloaded = loadConfig(configPath);
  assert.equal(reloaded.profiles["test"]?.configDir, "/tmp/test");
  assert.equal(reloaded.settings.maxAgeDays, 14);
});

test("config: saveConfig creates backup", () => {
  const configPath = join(testDir, "backup-test.json");

  // First save
  const config = loadConfig(configPath);
  config.profiles["first"] = { configDir: "/tmp/first" };
  saveConfig(config, configPath);

  // Update and save again
  config.profiles["second"] = { configDir: "/tmp/second" };
  saveConfig(config, configPath);

  // Backup should exist after second save
  const backupPath = `${configPath}.bak`;
  assert.ok(existsSync(backupPath));

  // Verify backup contains the first version
  const backupContent = JSON.parse(readFileSync(backupPath, "utf8"));
  assert.ok(backupContent.profiles["first"]);
  assert.equal(backupContent.profiles["second"], undefined);
});
