import { test } from "node:test";
import assert from "node:assert";
import { execFile } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// Statusline reads stdin, so it must be exercised as a real child process:
// in-process calls would listen on the test runner's never-ending stdin.
const __testDir = fileURLToPath(new URL(".", import.meta.url));
const CLI = resolve(__testDir, "../..", "bin/cchandoff.js");
const testDir = resolve(tmpdir(), `cchandoff-test-statusline-${Date.now()}`);

function runStatusline(
  stdinText: string,
  env: Record<string, string>
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      process.execPath,
      [CLI, "statusline"],
      { env: { ...process.env, ...env }, timeout: 10000 },
      (err, stdout) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number"
            ? ((err as unknown as { code: number }).code)
            : err
              ? 1
              : 0;
        resolvePromise({ stdout, code });
      }
    );
    child.stdin?.write(stdinText);
    child.stdin?.end();
  });
}

test("statusline: renders profile and context from valid input", async () => {
  const testHome = resolve(testDir, "home1");
  const configDir = resolve(testHome, ".claude");
  await mkdir(resolve(testHome, ".config/cchandoff"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(
    resolve(testHome, ".config/cchandoff/config.json"),
    JSON.stringify({
      schema: 1,
      profiles: { personal: { configDir } },
      settings: {},
    })
  );

  const input = JSON.stringify({
    session_id: "s1",
    model: { id: "claude-sonnet-5" },
    workspace: { current_dir: testHome },
    context_window: { used_percentage: 37 },
  });

  const { stdout, code } = await runStatusline(input, {
    HOME: testHome,
    XDG_CONFIG_HOME: resolve(testHome, ".config"),
  });

  assert.equal(code, 0);
  assert.match(stdout, /⇄/, "always shows the glyph");
  assert.match(stdout, /personal/, "shows resolved profile name");
  assert.match(stdout, /ctx 37%/, "shows context percentage from input");
  await rm(testHome, { recursive: true, force: true });
});

test("statusline: degrades to bare line on garbage stdin", async () => {
  const testHome = resolve(testDir, "home2");
  await mkdir(testHome, { recursive: true });

  const { stdout, code } = await runStatusline("this is not json", {
    HOME: testHome,
    XDG_CONFIG_HOME: resolve(testHome, ".config"),
  });

  assert.equal(code, 0, "never non-zero, even on garbage");
  assert.match(stdout, /⇄/, "still prints a line");
  await rm(testHome, { recursive: true, force: true });
});

test("statusline: exits 0 with empty stdin", async () => {
  const testHome = resolve(testDir, "home3");
  await mkdir(testHome, { recursive: true });

  const { code } = await runStatusline("", {
    HOME: testHome,
    XDG_CONFIG_HOME: resolve(testHome, ".config"),
  });

  assert.equal(code, 0);
  await rm(testDir, { recursive: true, force: true });
});
