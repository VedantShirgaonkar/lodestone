import { test } from "node:test";
import assert from "node:assert";
import { claudePath, versionOf } from "../src/core/claudeCli.js";

test("claudeCli: claudePath respects env override", () => {
  const orig = process.env.LODESTONE_CLAUDE_BIN;
  process.env.LODESTONE_CLAUDE_BIN = "/fake/path/claude";

  const path = claudePath();
  assert.equal(path, "/fake/path/claude");

  process.env.LODESTONE_CLAUDE_BIN = orig;
});

test("claudeCli: claudePath returns default when no override", () => {
  const orig = process.env.LODESTONE_CLAUDE_BIN;
  delete process.env.LODESTONE_CLAUDE_BIN;

  const path = claudePath();
  // Should be either a full path or "claude"
  assert.ok(typeof path === "string");
  assert.ok(path.length > 0);

  process.env.LODESTONE_CLAUDE_BIN = orig;
});

test("claudeCli: versionOf returns undefined for fake path", () => {
  const version = versionOf("/nonexistent/claude");
  assert.equal(version, undefined);
});

test("distill: an error-subtype result carries its reason instead of vanishing", async () => {
  const { distill } = await import("../src/core/claudeCli.js");
  const { resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const fake = resolve(dir, "../..", "test/fake-claude.sh");

  const profile = { name: "p", configDir: "/tmp" };

  const run = (env: Record<string, string>) => {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      return distill(profile, "sess-1", "template");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  // The wild failure: --max-turns 1 consumed by a tool call. The JSON parses,
  // has no result text, and the old code returned undefined — every diagnostic
  // collapsed to "distillation failed".
  const maxTurns = run({
    LODESTONE_CLAUDE_BIN: fake,
    LODESTONE_FAKE_CLAUDE_LOG: "/tmp/lodestone-distill-test.log",
    FAKE_CLAUDE_STDOUT: JSON.stringify({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
    }),
  });
  assert.equal(maxTurns.ok, false);
  assert.match((maxTurns as { reason: string }).reason, /error_max_turns/);
  assert.match((maxTurns as { reason: string }).reason, /\/handoff inside the session/);

  // A non-zero exit names the exit code and carries stderr.
  const crashed = run({
    LODESTONE_CLAUDE_BIN: fake,
    LODESTONE_FAKE_CLAUDE_LOG: "/tmp/lodestone-distill-test.log",
    FAKE_CLAUDE_STDERR: "Usage limit reached for this window",
    FAKE_CLAUDE_EXIT_CODE: "1",
  });
  assert.equal(crashed.ok, false);
  assert.match((crashed as { reason: string }).reason, /exited 1/);
  assert.match((crashed as { reason: string }).reason, /Usage limit reached/);

  // Success still succeeds.
  const good = run({
    LODESTONE_CLAUDE_BIN: fake,
    LODESTONE_FAKE_CLAUDE_LOG: "/tmp/lodestone-distill-test.log",
    FAKE_CLAUDE_STDOUT: JSON.stringify({ type: "result", subtype: "success", result: "## Goal\nok" }),
  });
  assert.equal(good.ok, true);
  assert.match((good as { text: string }).text, /## Goal/);
});

test("distill: forbids tool use in the fork via the system prompt", async () => {
  const { distill } = await import("../src/core/claudeCli.js");
  const { readFileSync, mkdtempSync } = await import("node:fs");
  const { resolve, join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { fileURLToPath } = await import("node:url");
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const fake = resolve(dir, "../..", "test/fake-claude.sh");
  const log = join(mkdtempSync(join(tmpdir(), "lodestone-distill-")), "log");

  process.env.LODESTONE_CLAUDE_BIN = fake;
  process.env.LODESTONE_FAKE_CLAUDE_LOG = log;
  process.env.FAKE_CLAUDE_STDOUT = JSON.stringify({ result: "ok" });
  try {
    distill({ name: "p", configDir: "/tmp" }, "sess-1", "template");
  } finally {
    delete process.env.LODESTONE_CLAUDE_BIN;
    delete process.env.LODESTONE_FAKE_CLAUDE_LOG;
    delete process.env.FAKE_CLAUDE_STDOUT;
  }

  const argv = readFileSync(log, "utf8");
  assert.match(argv, /--append-system-prompt/, "the fork must be told not to reach for tools");
  assert.match(argv, /Do not use any tools/);
  assert.match(argv, /--fork-session/);
});
