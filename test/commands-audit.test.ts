import { test } from "node:test";
import assert from "node:assert";
import { execFile } from "node:child_process";
import { mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __testDir = fileURLToPath(new URL(".", import.meta.url));
const CLI = resolve(__testDir, "..", "..", "bin/warmswap.js");
const testDir = resolve(tmpdir(), `warmswap-test-audit-${Date.now()}`);
const FIXTURE_SESSION = resolve(__testDir, "fixtures", "session-small.jsonl");

function runAudit(
  args: string[],
  env: Record<string, string>
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      process.execPath,
      [CLI, "audit", ...args],
      { env: { ...process.env, ...env }, timeout: 10000 },
      (err, stdout, stderr) => {
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

test("audit: shows no events when no sessions exist", async () => {
  const testHome = resolve(testDir, "home1");
  const configDir = resolve(testHome, ".claude");
  await mkdir(resolve(testHome, ".config/warmswap"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(
    resolve(testHome, ".config/warmswap/config.json"),
    JSON.stringify({
      schema: 1,
      profiles: { personal: { configDir } },
      settings: {},
    })
  );

  const { stdout, stderr, code } = await runAudit([], {
    HOME: testHome,
    XDG_CONFIG_HOME: resolve(testHome, ".config"),
  });

  assert.equal(code, 0, `Expected code 0 but got ${code}. stderr: ${stderr}, stdout: ${stdout}`);
  assert.match(stdout, /No handoff events found/);
  await rm(testHome, { recursive: true, force: true });
});

test("audit: accepts --since flag", async () => {
  const testHome = resolve(testDir, "home2");
  const configDir = resolve(testHome, ".claude");
  await mkdir(resolve(testHome, ".config/warmswap"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(
    resolve(testHome, ".config/warmswap/config.json"),
    JSON.stringify({
      schema: 1,
      profiles: { personal: { configDir } },
      settings: {},
    })
  );

  const { stdout, code } = await runAudit(
    ["--since", "7d"],
    {
      HOME: testHome,
      XDG_CONFIG_HOME: resolve(testHome, ".config"),
    }
  );

  assert.equal(code, 0);
  assert.match(stdout, /No handoff events found/);
  await rm(testHome, { recursive: true, force: true });
});

test("audit: accepts --json flag", async () => {
  const testHome = resolve(testDir, "home3");
  const configDir = resolve(testHome, ".claude");
  await mkdir(resolve(testHome, ".config/warmswap"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(
    resolve(testHome, ".config/warmswap/config.json"),
    JSON.stringify({
      schema: 1,
      profiles: { personal: { configDir } },
      settings: {},
    })
  );

  const { stdout, code } = await runAudit(
    ["--json"],
    {
      HOME: testHome,
      XDG_CONFIG_HOME: resolve(testHome, ".config"),
    }
  );

  assert.equal(code, 0);
  const json = JSON.parse(stdout);
  assert.ok(json.events !== undefined);
  assert.equal(json.totalEvents, 0);
  assert.equal(json.totalEstimatedSaved, 0);
  assert.ok(json.byClass !== undefined);
  await rm(testHome, { recursive: true, force: true });
});

test("audit: handles invalid --since", async () => {
  const testHome = resolve(testDir, "home4");
  const configDir = resolve(testHome, ".claude");
  await mkdir(resolve(testHome, ".config/warmswap"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(
    resolve(testHome, ".config/warmswap/config.json"),
    JSON.stringify({
      schema: 1,
      profiles: { personal: { configDir } },
      settings: {},
    })
  );

  const { stdout, stderr, code } = await runAudit(
    ["--since", "invalid"],
    {
      HOME: testHome,
      XDG_CONFIG_HOME: resolve(testHome, ".config"),
    }
  );

  assert.equal(code, 1, "should fail on invalid duration");
  const output = stdout + stderr;
  assert.match(output, /Invalid duration/, `Expected "Invalid duration" in output. stdout: ${stdout}, stderr: ${stderr}`);
  await rm(testHome, { recursive: true, force: true });
});

test("audit: parseDuration rejects invalid formats", async () => {
  // The audit command will error on invalid --since values
  const testHome = resolve(testDir, "home5");
  const configDir = resolve(testHome, ".claude");
  await mkdir(resolve(testHome, ".config/warmswap"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(
    resolve(testHome, ".config/warmswap/config.json"),
    JSON.stringify({
      schema: 1,
      profiles: { personal: { configDir } },
      settings: {},
    })
  );

  // Test various invalid formats
  const invalidDurations = ["", "abc", "10", "10xx", "d10"];

  for (const duration of invalidDurations) {
    const { code } = await runAudit(
      ["--since", duration],
      {
        HOME: testHome,
        XDG_CONFIG_HOME: resolve(testHome, ".config"),
      }
    );
    assert.equal(code, 1, `should reject duration: ${duration}`);
  }

  await rm(testHome, { recursive: true, force: true });
});

test("audit: --json includes class field and byClass summary", async () => {
  const testHome = resolve(testDir, "home6");
  const configDir = resolve(testHome, ".claude");
  await mkdir(resolve(testHome, ".config/warmswap"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(
    resolve(testHome, ".config/warmswap/config.json"),
    JSON.stringify({
      schema: 1,
      profiles: { personal: { configDir } },
      settings: {},
    })
  );

  const { stdout, code } = await runAudit(
    ["--json"],
    {
      HOME: testHome,
      XDG_CONFIG_HOME: resolve(testHome, ".config"),
    }
  );

  assert.equal(code, 0);
  const json = JSON.parse(stdout);
  assert.ok(json.byClass !== undefined);
  assert.ok(typeof json.byClass === "object");
  await rm(testHome, { recursive: true, force: true });
});

test("audit: classifies refresh when same profile with <5h gap", async () => {
  const testHome = resolve(testDir, "home7");
  const configDir = resolve(testHome, ".claude");
  const projectDir = resolve(configDir, "projects/-test-proj");
  const handoffDir = resolve(projectDir, ".claude/handoff");
  const now = Date.now();
  const sourceSessionMtimeMs = now - 3 * 60 * 60 * 1000; // 3 hours ago
  const consumedAtMs = sourceSessionMtimeMs + 2 * 60 * 60 * 1000; // 2 hours later

  await mkdir(resolve(testHome, ".config/warmswap"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(handoffDir, { recursive: true });

  // Create a session file with the appropriate mtime
  const sessionFile = resolve(projectDir, "session.jsonl");
  await writeFile(sessionFile, '{"type":"user"}\n');

  // Set the mtime to 3 hours ago
  const sourceSessionMtime = new Date(sourceSessionMtimeMs);
  await utimes(sessionFile, sourceSessionMtime, sourceSessionMtime);

  // Write meta.json with same profile and consumedAt 2 hours after source
  await writeFile(
    resolve(handoffDir, "latest.meta.json"),
    JSON.stringify({
      schema: 1,
      created: new Date(sourceSessionMtimeMs).toISOString(),
      sourceProfile: "personal",
      sourceSession: "session123",
      project: "-test-proj",
      contextTokens: 100000,
      distilled: false,
      consumed: true,
      consumedBy: {
        profile: "personal",
        session: "session124",
        at: new Date(consumedAtMs).toISOString(),
      },
    })
  );

  await writeFile(
    resolve(testHome, ".config/warmswap/config.json"),
    JSON.stringify({
      schema: 1,
      profiles: { personal: { configDir } },
      settings: {},
    })
  );

  const { stdout, code } = await runAudit(["--json"], {
    HOME: testHome,
    XDG_CONFIG_HOME: resolve(testHome, ".config"),
  });

  assert.equal(code, 0);
  const json = JSON.parse(stdout);
  assert.equal(json.events.length, 1);
  assert.equal(json.events[0].class, "refresh", "Should classify as refresh for <5h gap");
  assert.ok(json.byClass.refresh !== undefined);
  assert.equal(json.byClass.refresh.count, 1);
  await rm(testHome, { recursive: true, force: true });
});

test("audit: classifies post-reset when same profile with ≥5h gap", async () => {
  const testHome = resolve(testDir, "home8");
  const configDir = resolve(testHome, ".claude");
  const projectDir = resolve(configDir, "projects/-test-proj");
  const handoffDir = resolve(projectDir, ".claude/handoff");
  const now = Date.now();
  const sourceSessionMtimeMs = now - 7 * 60 * 60 * 1000; // 7 hours ago
  const consumedAtMs = sourceSessionMtimeMs + 6 * 60 * 60 * 1000; // 6 hours later

  await mkdir(resolve(testHome, ".config/warmswap"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(handoffDir, { recursive: true });

  // Create a session file with the appropriate mtime
  const sessionFile = resolve(projectDir, "session.jsonl");
  await writeFile(sessionFile, '{"type":"user"}\n');

  // Set the mtime to 7 hours ago
  const sourceSessionMtime = new Date(sourceSessionMtimeMs);
  await utimes(sessionFile, sourceSessionMtime, sourceSessionMtime);

  // Write meta.json with same profile and consumedAt 6 hours after source (post-reset)
  await writeFile(
    resolve(handoffDir, "latest.meta.json"),
    JSON.stringify({
      schema: 1,
      created: new Date(sourceSessionMtimeMs).toISOString(),
      sourceProfile: "personal",
      sourceSession: "session125",
      project: "-test-proj",
      contextTokens: 150000,
      distilled: false,
      consumed: true,
      consumedBy: {
        profile: "personal",
        session: "session126",
        at: new Date(consumedAtMs).toISOString(),
      },
    })
  );

  await writeFile(
    resolve(testHome, ".config/warmswap/config.json"),
    JSON.stringify({
      schema: 1,
      profiles: { personal: { configDir } },
      settings: {},
    })
  );

  const { stdout, code } = await runAudit(["--json"], {
    HOME: testHome,
    XDG_CONFIG_HOME: resolve(testHome, ".config"),
  });

  assert.equal(code, 0);
  const json = JSON.parse(stdout);
  assert.equal(json.events.length, 1);
  assert.equal(json.events[0].class, "post-reset", "Should classify as post-reset for ≥5h gap");
  assert.ok(json.byClass["post-reset"] !== undefined);
  assert.equal(json.byClass["post-reset"].count, 1);
  await rm(testHome, { recursive: true, force: true });
});
