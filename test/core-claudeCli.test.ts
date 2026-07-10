import { test } from "node:test";
import assert from "node:assert";
import { claudePath, versionOf } from "../src/core/claudeCli.js";

test("claudeCli: claudePath respects env override", () => {
  const orig = process.env.CCHANDOFF_CLAUDE_BIN;
  process.env.CCHANDOFF_CLAUDE_BIN = "/fake/path/claude";

  const path = claudePath();
  assert.equal(path, "/fake/path/claude");

  process.env.CCHANDOFF_CLAUDE_BIN = orig;
});

test("claudeCli: claudePath returns default when no override", () => {
  const orig = process.env.CCHANDOFF_CLAUDE_BIN;
  delete process.env.CCHANDOFF_CLAUDE_BIN;

  const path = claudePath();
  // Should be either a full path or "claude"
  assert.ok(typeof path === "string");
  assert.ok(path.length > 0);

  process.env.CCHANDOFF_CLAUDE_BIN = orig;
});

test("claudeCli: versionOf returns undefined for fake path", () => {
  const version = versionOf("/nonexistent/claude");
  assert.equal(version, undefined);
});
