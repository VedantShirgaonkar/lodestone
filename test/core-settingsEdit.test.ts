import { test } from "node:test";
import assert from "node:assert";
import {
  installHooks,
  uninstallHooks,
  installedHooks,
  HOOK_EVENTS,
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

test("settingsEdit: install never duplicates, and repairs existing duplicates", () => {
  // Older versions keyed "is this already installed?" on the literal substring
  // "lodestone hook". Any command that did not contain it (an absolute path, a
  // dev build, LODESTONE_HOOK_CMD) was never recognized, so every run appended
  // another identical hook. One real settings.json reached 369 copies, each one
  // firing on every session event.
  const dir = join(testDir, "dupes");
  mkdirSync(dir, { recursive: true });
  const settingsPath = join(dir, "settings.json");

  // A file already carrying five copies of our hook, plus a hook we do not own.
  writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        SessionStart: [
          ...Array.from({ length: 5 }, () => ({
            hooks: [{ type: "command", command: "lodestone hook session-start" }],
          })),
          { hooks: [{ type: "command", command: "some-other-tool --init" }] },
        ],
      },
    }),
    "utf8"
  );

  const countOf = (event: string, pred: (c: string) => boolean): number => {
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    const entries = s.hooks?.[event] ?? [];
    let n = 0;
    for (const e of entries) {
      for (const h of e.hooks ?? []) {
        if (typeof h.command === "string" && pred(h.command)) n++;
      }
    }
    return n;
  };

  installHooks(settingsPath, { sessionStartCmd: "lodestone hook session-start" });

  assert.equal(countOf("SessionStart", (c) => c.includes("lodestone hook")), 1,
    "five duplicates collapsed to one");
  assert.equal(countOf("SessionStart", (c) => c === "some-other-tool --init"), 1,
    "a hook we do not own is left alone");

  // And installing repeatedly stays at one, whatever the command looks like.
  for (let i = 0; i < 3; i++) {
    installHooks(settingsPath, { sessionStartCmd: "/opt/bin/lodestone hook session-start" });
  }
  assert.equal(countOf("SessionStart", (c) => c.includes("lodestone hook")), 1,
    "a relocated binary updates in place, it does not accumulate");
});

test("settingsEdit: installedHooks reports what is registered, not what we meant to register", () => {
  const dir = join(testDir, "reports-truth");
  mkdirSync(dir, { recursive: true });
  const settingsPath = join(dir, "settings.json");

  // Nothing installed yet.
  assert.deepEqual(installedHooks(settingsPath), []);

  // A partial install has to read as partial. Doctor used to answer this
  // question with `raw.includes("lodestone hook")` and then print all four
  // names, so this exact file was certified as fully installed.
  writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "lodestone hook session-start" }] },
        ],
      },
    }),
    "utf8"
  );
  assert.deepEqual(installedHooks(settingsPath), ["session-start"]);
});

test("settingsEdit: installHooks wires up the advisor", () => {
  const dir = join(testDir, "advisor");
  mkdirSync(dir, { recursive: true });
  const settingsPath = join(dir, "settings.json");

  installHooks(settingsPath, {
    sessionStartCmd: "lodestone hook session-start",
    sessionEndCmd: "lodestone hook session-end",
    preCompactCmd: "lodestone hook pre-compact",
    userPromptSubmitCmd: "lodestone hook user-prompt-submit",
  });

  // The advisor (the 85% nudge, the 95% recovery snapshot) and trail mode's
  // staleness reminder both ride on UserPromptSubmit. It was implemented in
  // full and then never installed by any code path.
  assert.deepEqual(installedHooks(settingsPath), [...HOOK_EVENTS]);

  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.ok(settings.hooks.UserPromptSubmit, "UserPromptSubmit must be registered");
});

test("settingsEdit: installedHooks sees a hook however the command is spelled", () => {
  const dir = join(testDir, "spellings");
  mkdirSync(dir, { recursive: true });
  const settingsPath = join(dir, "settings.json");

  // A dev build, an absolute path, and the bare binary are all the same hook.
  writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "node /opt/lodestone/dist/cli.js hook session-start" }] },
        ],
        SessionEnd: [
          { hooks: [{ type: "command", command: "/usr/local/bin/lodestone hook session-end" }] },
        ],
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "lodestone hook user-prompt-submit" }] },
        ],
      },
    }),
    "utf8"
  );

  assert.deepEqual(installedHooks(settingsPath), [
    "session-start",
    "session-end",
    "user-prompt-submit",
  ]);
});
