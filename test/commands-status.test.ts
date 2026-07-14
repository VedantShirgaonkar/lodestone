import { test } from "node:test";
import assert from "node:assert";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mungeCwd } from "../src/core/paths.js";

const __testDir = fileURLToPath(new URL(".", import.meta.url));
const CLI = resolve(__testDir, "../..", "bin/lodestone.js");

function runStatus(env: Record<string, string>): Promise<string> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [CLI, "status"],
      { env: { ...process.env, ...env }, timeout: 15000 },
      (_err: unknown, stdout: string, stderr: string) => done(stdout + stderr)
    );
  });
}

/**
 * A scratch account holding one live session per project, filed under the
 * munged directory name exactly as Claude Code files them.
 */
function accountWith(projects: string[]): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), "lodestone-status-"));
  const claudeDir = join(home, ".claude");
  const projectsDir = join(claudeDir, "projects");

  const configDir = join(home, ".config", "lodestone");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      schema: 1,
      profiles: { personal: { configDir: claudeDir } },
      settings: {},
    }),
    "utf8"
  );

  for (const [i, cwd] of projects.entries()) {
    const dir = join(projectsDir, mungeCwd(cwd));
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(dir, `session-${i}.jsonl`),
      [
        JSON.stringify({
          type: "user",
          uuid: "u1",
          sessionId: `sess-${i}`,
          timestamp: now,
          cwd,
          message: { role: "user", content: "go" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "a1",
          sessionId: `sess-${i}`,
          timestamp: now,
          cwd,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              cache_read_input_tokens: 40000,
              cache_creation_input_tokens: 1000,
            },
          },
        }),
      ].join("\n"),
      "utf8"
    );
  }

  return {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    CLAUDE_CONFIG_DIR: claudeDir,
  };
}

test("status: names a project from the transcript, not by reversing the munge", async () => {
  // The munge is not reversible, and this is what that costs. The old code took
  // the last dash-separated component of the directory name, so a directory
  // with a dash or a space in it was renamed to its own last word. On the
  // author's machine three of six projects displayed under the wrong name:
  // "FY Project" as "Project", "RAIT QA" as "QA", "rait-qa-agent" as "agent".
  // It only ever looked correct on single-word directory names.
  const out = await runStatus(
    accountWith([
      "/Users/test/code/my-app", // a dash in the name
      "/Users/test/Desktop/RAIT QA", // a space, which also munges to a dash
    ])
  );

  assert.match(out, /my-app:/, "a dashed directory keeps its whole name");
  assert.match(out, /RAIT QA:/, "a spaced directory keeps its whole name");

  assert.doesNotMatch(out, /^\s*app:/m, "must not truncate my-app to app");
  assert.doesNotMatch(out, /^\s*QA:/m, "must not truncate RAIT QA to QA");
});

test("status: lists live sessions across every project, not just the current one", async () => {
  // This is deliberate, and it is the point of the command: a warm cache in
  // another project is worth money and has a clock on it. Being in project A
  // must not hide that project B is holding 200k tokens with 40 minutes left.
  const env = accountWith(["/Users/test/code/alpha", "/Users/test/code/beta"]);
  const out = await runStatus({ ...env, PWD: "/Users/test/code/alpha" });

  assert.match(out, /alpha:/, "the project we are in");
  assert.match(out, /beta:/, "and the one we are not");
});
