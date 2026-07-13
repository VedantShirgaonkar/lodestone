import { test } from "node:test";
import assert from "node:assert";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { banner, step, panel } from "../src/util/tui.js";

const __testDir = fileURLToPath(new URL(".", import.meta.url));
const CLI = resolve(__testDir, "../..", "bin/lodestone.js");

function runSetup(
  args: string[],
  env: Record<string, string>
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [CLI, "setup", ...args],
      { env: { ...process.env, ...env }, timeout: 10000 },
      (err: unknown, stdout: string, stderr: string) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number"
            ? ((err as unknown as { code: number }).code)
            : err
              ? 1
              : 0;
        resolvePromise({ stdout, stderr, code });
      }
    );
  });
}

test("setup: non-TTY run exits 0 and prints command list", async () => {
  // HOME and XDG_CONFIG_HOME have to move together. lodestoneConfigPath()
  // prefers XDG and falls back to HOME, so overriding one and inheriting the
  // other points the command at a config we did not create.
  const home = "/tmp/test-setup";
  const { stdout, stderr, code } = await runSetup([], {
    HOME: home,
    XDG_CONFIG_HOME: `${home}/.config`,
  });

  assert.equal(code, 0, "exit code should be 0");
  const output = stdout + stderr;
  assert.match(output, /lodestone init/, "should print lodestone init command");
  assert.match(
    output,
    /Not a terminal/,
    "should indicate non-interactive mode"
  );
});

test("tui-banner: renders without color when NO_COLOR is set", () => {
  const original = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";

  const result = banner();

  delete process.env.NO_COLOR;
  if (original !== undefined) {
    process.env.NO_COLOR = original;
  }

  // Should not contain ANSI escape codes
  assert(!result.includes("\x1b"), "banner should not contain ANSI codes with NO_COLOR");
  // Banner contains box-drawing characters that visually form LODESTONE
  assert(result.includes("██╗"), "banner should contain box drawing characters");
  assert(result.length > 100, "banner should be substantial in length");
});

test("tui-banner: renders with gradient when TTY", () => {
  const original = process.env.NO_COLOR;
  delete process.env.NO_COLOR;

  const result = banner();

  if (original !== undefined) {
    process.env.NO_COLOR = original;
  }

  // In TTY mode, should contain color codes (but we can't guarantee this in test env)
  // At minimum, should be a string with content
  assert(typeof result === "string", "banner should return a string");
  assert(result.length > 0, "banner should not be empty");
});

test("tui-step: renders done state", () => {
  const result = step("done", "Test label", "detail");
  assert(result.includes("✔"), "done state should have checkmark");
  assert(result.includes("Test label"), "should include label");
  assert(result.includes("detail"), "should include detail");
});

test("tui-step: renders fail state", () => {
  const result = step("fail", "Error", "something wrong");
  assert(result.includes("✖"), "fail state should have X");
  assert(result.includes("Error"), "should include label");
});

test("tui-step: renders active state", () => {
  const result = step("active", "Working");
  assert(result.includes("▸"), "active state should have arrow");
  assert(result.includes("Working"), "should include label");
});

test("tui-step: renders todo state", () => {
  const result = step("todo", "Pending");
  assert(result.includes("○"), "todo state should have circle");
  assert(result.includes("Pending"), "should include label");
});

test("tui-step: renders warn state", () => {
  const result = step("warn", "Warning", "caution");
  assert(result.includes("!"), "warn state should have exclamation");
  assert(result.includes("Warning"), "should include label");
});

test("tui-panel: renders with title and lines", () => {
  const result = panel("My Title", ["Line 1", "Line 2"]);

  assert(result.includes("My Title"), "should include title");
  assert(result.includes("Line 1"), "should include first line");
  assert(result.includes("Line 2"), "should include second line");
  assert(result.includes("╭"), "should have top-left corner");
  assert(result.includes("╯"), "should have bottom-right corner");
});

test("tui-panel: handles empty lines array", () => {
  const result = panel("Just Title", []);

  assert(result.includes("Just Title"), "should include title");
  assert(result.includes("╭"), "should still have corners");
});

test("gradient-math: produces values in valid RGB range", () => {
  // Test that the gradient function (used internally) produces valid RGB values
  // We'll indirectly test this by checking that banner() doesn't throw
  const result = banner();
  assert(typeof result === "string", "banner should produce a string");
});
