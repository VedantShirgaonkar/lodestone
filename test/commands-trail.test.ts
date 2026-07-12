import { test } from "node:test";
import assert from "node:assert";
import { execFile } from "node:child_process";
import { mkdir, writeFile, rm, readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __testDir = fileURLToPath(new URL(".", import.meta.url));
const CLI = resolve(__testDir, "..", "..", "bin/warmswap.js");
const testDir = resolve(tmpdir(), `warmswap-test-trail-${Date.now()}`);

function runTrail(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      process.execPath,
      [CLI, "trail", ...args],
      { cwd, timeout: 10000 },
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

test("trail: on creates rules and skill files", async () => {
  const projectRoot = resolve(testDir, "project1");
  await mkdir(join(projectRoot, ".git"), { recursive: true });

  const { stdout, stderr, code } = await runTrail(["on"], projectRoot);

  assert.equal(code, 0, `Expected code 0 but got ${code}. stderr: ${stderr}`);
  assert.match(stdout, /installed/);

  const rulesPath = join(projectRoot, ".claude", "rules", "warmswap-trail.md");
  const skillPath = join(projectRoot, ".claude", "skills", "trail", "SKILL.md");

  const rulesExists = await stat(rulesPath).then(() => true).catch(() => false);
  const skillExists = await stat(skillPath).then(() => true).catch(() => false);

  assert.ok(rulesExists, `Rules file should exist at ${rulesPath}`);
  assert.ok(skillExists, `Skill file should exist at ${skillPath}`);

  const rulesContent = await readFile(rulesPath, "utf8");
  assert.match(rulesContent, /Session trail \(warmswap\)/);
  assert.match(rulesContent, /without being asked/, "rules must command Claude directly");
  assert.match(rulesContent, /Never write secrets/);

  await rm(projectRoot, { recursive: true, force: true });
});

test("trail: off removes rules and skill files", async () => {
  const projectRoot = resolve(testDir, "project2");
  await mkdir(join(projectRoot, ".git"), { recursive: true });

  // First turn on
  await runTrail(["on"], projectRoot);

  // Then turn off
  const { stdout, code } = await runTrail(["off"], projectRoot);

  assert.equal(code, 0);
  assert.match(stdout, /disabled/);

  const rulesPath = join(projectRoot, ".claude", "rules", "warmswap-trail.md");
  const rulesExists = await stat(rulesPath).then(() => true).catch(() => false);
  assert.ok(!rulesExists, `Rules file should not exist after turning off`);

  await rm(projectRoot, { recursive: true, force: true });
});

test("trail: status reports installed", async () => {
  const projectRoot = resolve(testDir, "project3");
  await mkdir(join(projectRoot, ".git"), { recursive: true });

  // Turn on trail
  await runTrail(["on"], projectRoot);

  const { stdout, code } = await runTrail(["status"], projectRoot);

  assert.equal(code, 0);
  assert.match(stdout, /installed/);

  await rm(projectRoot, { recursive: true, force: true });
});

test("trail: status reports not installed", async () => {
  const projectRoot = resolve(testDir, "project4");
  await mkdir(join(projectRoot, ".git"), { recursive: true });

  const { stdout, code } = await runTrail(["status"], projectRoot);

  assert.equal(code, 0);
  assert.match(stdout, /not installed/);

  await rm(projectRoot, { recursive: true, force: true });
});

test("trail: status --json format", async () => {
  const projectRoot = resolve(testDir, "project5");
  await mkdir(join(projectRoot, ".git"), { recursive: true });

  await runTrail(["on"], projectRoot);

  const { stdout, code } = await runTrail(["status", "--json"], projectRoot);

  assert.equal(code, 0);
  const json = JSON.parse(stdout);
  assert.equal(json.installed, true);
  assert.ok(json.rulesAge !== undefined);

  await rm(projectRoot, { recursive: true, force: true });
});

test("trail: on is idempotent", async () => {
  const projectRoot = resolve(testDir, "project6");
  await mkdir(join(projectRoot, ".git"), { recursive: true });

  const { code: code1 } = await runTrail(["on"], projectRoot);
  const { code: code2 } = await runTrail(["on"], projectRoot);

  assert.equal(code1, 0);
  assert.equal(code2, 0);

  const rulesPath = join(projectRoot, ".claude", "rules", "warmswap-trail.md");
  const rulesExists = await stat(rulesPath).then(() => true).catch(() => false);
  assert.ok(rulesExists);

  await rm(projectRoot, { recursive: true, force: true });
});
