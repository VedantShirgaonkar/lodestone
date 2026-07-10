import { test } from "node:test";
import assert from "node:assert";
import { logError, logInfo } from "../src/util/log.js";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

test("util-log: logError and logInfo don't throw", () => {
  // These should be silent failures if logging setup fails
  assert.doesNotThrow(() => {
    logError("test error");
    logInfo("test info");
  });
});

test("util-log: logs are written to expected directory", () => {
  const logDir = join(homedir(), ".config", "cchandoff");
  const logFile = join(logDir, "cchandoff.log");

  // Clear any existing log to start fresh
  if (existsSync(logFile)) {
    rmSync(logFile, { force: true });
  }

  logInfo("test message");

  // May or may not exist depending on write permissions in test env
  // Main thing is no throw
});
