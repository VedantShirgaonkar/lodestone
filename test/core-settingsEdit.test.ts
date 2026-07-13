import { test } from "node:test";
import assert from "node:assert";
import {
  installHooks,
  uninstallHooks,
} from "../src/core/settingsEdit.js";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), "lodestone-test-settings");

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

test("settingsEdit: installHooks creates settings.json", () => {
  const configDir = join(testDir, "config1");
  mkdirSync(configDir, { recursive: true });

  installHooks(configDir, {
    sessionStartCmd: "lodestone hook session-start",
  });

  const settingsPath = join(configDir, "settings.json");
  assert.ok(existsSync(settingsPath));

  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.ok(settings.hooks);
});

test("settingsEdit: installHooks is idempotent", () => {
  const configDir = join(testDir, "config2");
  mkdirSync(configDir, { recursive: true });

  const cmd = "lodestone hook session-start";

  installHooks(configDir, { sessionStartCmd: cmd });
  const afterFirst = readFileSync(
    join(configDir, "settings.json"),
    "utf8"
  );

  installHooks(configDir, { sessionStartCmd: cmd });
  const afterSecond = readFileSync(
    join(configDir, "settings.json"),
    "utf8"
  );

  // Should be identical (idempotent)
  assert.equal(afterFirst, afterSecond);
});

test("settingsEdit: installHooks preserves existing hooks", () => {
  const configDir = join(testDir, "config3");
  mkdirSync(configDir, { recursive: true });

  // First install
  installHooks(configDir, {
    sessionStartCmd: "lodestone hook session-start",
  });

  // Second install with different hook
  installHooks(configDir, {
    sessionEndCmd: "lodestone hook session-end",
  });

  const settings = JSON.parse(
    readFileSync(join(configDir, "settings.json"), "utf8")
  );
  const hooks = settings.hooks as Record<string, unknown>;

  // Both should be present
  assert.ok(hooks.SessionStart || hooks["SessionStart"]);
  assert.ok(hooks.SessionEnd || hooks["SessionEnd"]);
});

test("settingsEdit: installHooks creates backup", () => {
  const configDir = join(testDir, "config4");
  mkdirSync(configDir, { recursive: true });

  installHooks(configDir, {
    sessionStartCmd: "lodestone hook session-start",
  });

  const settingsPath = join(configDir, "settings.json");
  const backupPath = `${settingsPath}.bak`;

  // After second install, backup should exist
  installHooks(configDir, {
    sessionEndCmd: "lodestone hook session-end",
  });

  assert.ok(existsSync(backupPath));
});

test("settingsEdit: installHooks rejects invalid JSON", () => {
  const configDir = join(testDir, "config5");
  mkdirSync(configDir, { recursive: true });

  // Write invalid JSON
  const settingsPath = join(configDir, "settings.json");
  writeFileSync(settingsPath, "{ invalid json");

  assert.throws(
    () =>
      installHooks(configDir, {
        sessionStartCmd: "lodestone hook session-start",
      }),
    /Invalid JSON/
  );
});

test("settingsEdit: uninstallHooks removes lodestone hooks", () => {
  const configDir = join(testDir, "config6");
  mkdirSync(configDir, { recursive: true });

  installHooks(configDir, {
    sessionStartCmd: "lodestone hook session-start",
  });

  uninstallHooks(configDir);

  const settings = JSON.parse(
    readFileSync(join(configDir, "settings.json"), "utf8")
  );
  const hooks = settings.hooks as Record<string, unknown>;

  // SessionStart hook should be gone or empty
  const sessionStart = hooks?.SessionStart || hooks?.["SessionStart"];
  if (sessionStart) {
    assert.equal(
      (sessionStart as unknown[])?.length ?? 0,
      0
    );
  }
});

test("settingsEdit: installHooks double-install proves idempotence", () => {
  const configDir = join(testDir, "config7");
  mkdirSync(configDir, { recursive: true });

  // Install all three hook types
  installHooks(configDir, {
    sessionStartCmd: "lodestone hook session-start",
    sessionEndCmd: "lodestone hook session-end",
    preCompactCmd: "lodestone hook pre-compact",
  });

  const firstRead = readFileSync(join(configDir, "settings.json"), "utf8");
  const firstParse = JSON.parse(firstRead);
  const firstHookCount = JSON.stringify(firstParse).length;

  // Install again with same commands
  installHooks(configDir, {
    sessionStartCmd: "lodestone hook session-start",
    sessionEndCmd: "lodestone hook session-end",
    preCompactCmd: "lodestone hook pre-compact",
  });

  const secondRead = readFileSync(join(configDir, "settings.json"), "utf8");
  const secondParse = JSON.parse(secondRead);
  const secondHookCount = JSON.stringify(secondParse).length;

  // Should be identical (same size, same content)
  assert.equal(firstHookCount, secondHookCount);
  assert.deepEqual(firstParse, secondParse);
});
