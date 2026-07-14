import { test } from "node:test";
import assert from "node:assert";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mungeCwd } from "../src/core/paths.js";

const __testDir = fileURLToPath(new URL(".", import.meta.url));
const CLI = resolve(__testDir, "../..", "bin/lodestone.js");

/**
 * Invoke a hook the way Claude Code actually invokes it: as a child process,
 * with the event payload as JSON on stdin.
 *
 * Every test in this file used to build a fixture, declare stdin "complex to
 * mock", never call the hook at all, and then assert that a file it had just
 * written existed. Five green ticks, zero hooks executed. The whole passive
 * layer shipped behind that, and three separate bugs rode along with it: the
 * auto-snapshot recorded a profile named "auto", a display slug where the
 * resume-target session id belongs, and the git branch in the project field.
 * Mocking stdin is one line.
 */
function runHook(
  subcommand: string,
  payload: unknown,
  env: Record<string, string>
): Promise<{ stdout: string; code: number }> {
  return new Promise((done) => {
    const child = execFile(
      process.execPath,
      [CLI, "hook", subcommand],
      { env: { ...process.env, ...env }, timeout: 15000 },
      (err: unknown, stdout: string) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : err
              ? 1
              : 0;
        done({ stdout, code });
      }
    );
    child.stdin?.end(JSON.stringify(payload));
  });
}

/** The real session id. Distinct from the slug, which is what the bug stored. */
const SESSION_ID = "11111111-2222-3333-4444-555555555555";
/** The transcript's own branch, so a test can prove it does not land in `project`. */
const GIT_BRANCH = "feature-x";
/** Claude Code's friendly name for a session. Never a resume target. */
const SLUG = "declarative-dancing-cat";

/**
 * A scratch world: an isolated HOME, one registered profile, a project with a
 * git marker so findProjectRoot stops there, and a synthetic transcript.
 */
function world(): {
  home: string;
  env: Record<string, string>;
  projectRoot: string;
  transcript: string;
  handoffDir: string;
} {
  const home = mkdtempSync(join(tmpdir(), "lodestone-hook-"));
  const claudeDir = join(home, ".claude");
  const projectRoot = join(home, "work", "app");

  mkdirSync(join(claudeDir, "projects"), { recursive: true });
  // findProjectRoot walks up for a .git, so plant one and it stops here.
  mkdirSync(join(projectRoot, ".git"), { recursive: true });

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

  const transcript = join(home, `${SESSION_ID}.jsonl`);
  const common = {
    sessionId: SESSION_ID,
    cwd: projectRoot,
    version: "2.1.206",
    gitBranch: GIT_BRANCH,
    slug: SLUG,
    isSidechain: false,
  };
  writeFileSync(
    transcript,
    [
      JSON.stringify({
        ...common,
        type: "user",
        uuid: "u1",
        parentUuid: null,
        timestamp: "2026-07-14T08:00:00Z",
        userType: "human",
        message: { role: "user", content: "Wire up the parser" },
        isMeta: false,
      }),
      JSON.stringify({
        ...common,
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        timestamp: "2026-07-14T08:00:09Z",
        userType: "assistant",
        message: {
          id: "msg-a1",
          model: "claude-opus-4-8",
          role: "assistant",
          content: [{ type: "text", text: "Parser wired up in src/parse.ts." }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 120,
            output_tokens: 40,
            cache_creation_input_tokens: 2000,
            cache_read_input_tokens: 8000,
          },
        },
      }),
    ].join("\n"),
    "utf8"
  );

  return {
    home,
    env: {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      CLAUDE_CONFIG_DIR: claudeDir,
    },
    projectRoot,
    transcript,
    handoffDir: join(projectRoot, ".claude", "handoff"),
  };
}

function writeHandoff(
  handoffDir: string,
  meta: Record<string, unknown>,
  markdown = "# Handoff Snapshot\n\n## Goal\nShip the parser\n"
): void {
  mkdirSync(handoffDir, { recursive: true });
  writeFileSync(join(handoffDir, "latest.md"), markdown, "utf8");
  writeFileSync(
    join(handoffDir, "latest.meta.json"),
    JSON.stringify(meta, null, 2),
    "utf8"
  );
}

function readMeta(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
}

const baseMeta = {
  schema: 1,
  created: new Date().toISOString(),
  sourceProfile: "personal",
  sourceSession: SESSION_ID,
  project: "-work-app",
  branch: "main",
  contextTokens: 5000,
  distilled: false,
  consumed: false,
};

// ── session-end / pre-compact: the auto-snapshot ────────────────────────────

test("hook session-end: snapshot records the profile, session and project it came from", async () => {
  const w = world();

  const { code } = await runHook(
    "session-end",
    { transcript_path: w.transcript, cwd: w.projectRoot, session_id: SESSION_ID },
    w.env
  );
  assert.equal(code, 0, "a hook must never fail the session");

  const metaPath = join(w.handoffDir, "auto", `${SESSION_ID}.meta.json`);
  assert.ok(existsSync(metaPath), "session-end should bank a snapshot");
  const meta = readMeta(metaPath);

  // audit reads sourceProfile as the account a boundary was crossed FROM. The
  // literal "auto" is the directory the file sits in, not an account, and
  // reporting it would invent a crossing from an account that does not exist.
  assert.equal(meta.sourceProfile, "personal", "must record the real profile");

  // sourceSession is a resume target: `handoff --distill` hands it to
  // `claude --resume`. The slug is a display name and resumes nothing.
  assert.equal(meta.sourceSession, SESSION_ID, "must record the real session id");
  assert.notEqual(meta.sourceSession, SLUG, "the slug is not a session id");

  // The project field took the git branch for a project name, so every auto
  // snapshot claimed to belong to a project called "main".
  assert.equal(meta.project, mungeCwd(w.projectRoot), "must record the munged project");
  assert.notEqual(meta.project, GIT_BRANCH, "a branch is not a project");
});

test("hook pre-compact: banks a snapshot on the same terms", async () => {
  const w = world();

  const { code } = await runHook(
    "pre-compact",
    { transcript_path: w.transcript, cwd: w.projectRoot, session_id: SESSION_ID },
    w.env
  );

  assert.equal(code, 0);
  const metaPath = join(w.handoffDir, "auto", `${SESSION_ID}.meta.json`);
  assert.ok(existsSync(metaPath), "pre-compact should bank a snapshot");
  assert.equal(readMeta(metaPath).sourceProfile, "personal");
});

test("hook session-end: honors autoSnapshot=false", async () => {
  const w = world();
  const cfgPath = join(w.home, ".config", "lodestone", "config.json");
  const cfg = readMeta(cfgPath);
  cfg.settings = { autoSnapshot: false };
  writeFileSync(cfgPath, JSON.stringify(cfg), "utf8");

  await runHook(
    "session-end",
    { transcript_path: w.transcript, cwd: w.projectRoot, session_id: SESSION_ID },
    w.env
  );

  assert.ok(
    !existsSync(join(w.handoffDir, "auto", `${SESSION_ID}.md`)),
    "opting out must actually opt out"
  );
});

// ── session-start: the injection ────────────────────────────────────────────

test("hook session-start: injects a fresh handoff into the new session", async () => {
  const w = world();
  writeHandoff(w.handoffDir, baseMeta);

  const { stdout, code } = await runHook(
    "session-start",
    { cwd: w.projectRoot, session_id: "new-session-id", source: "startup" },
    w.env
  );

  assert.equal(code, 0);
  const out = JSON.parse(stdout.trim()) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
    systemMessage?: string;
  };
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(
    out.hookSpecificOutput.additionalContext,
    /Ship the parser/,
    "the handoff body should reach the new session"
  );
  assert.match(out.systemMessage ?? "", /restored handoff/i);
});

test("hook session-start: marks the handoff consumed, attributed to the consumer", async () => {
  const w = world();
  writeHandoff(w.handoffDir, baseMeta);

  await runHook(
    "session-start",
    { cwd: w.projectRoot, session_id: "new-session-id", source: "startup" },
    w.env
  );

  const meta = readMeta(join(w.handoffDir, "latest.meta.json"));
  assert.equal(meta.consumed, true, "a consumed handoff must be recorded as such");
  assert.equal(meta.consumedBy.profile, "personal");
  assert.equal(meta.consumedBy.session, "new-session-id");
  assert.ok(meta.consumedBy.at, "consumption needs a timestamp for audit");
});

test("hook session-start: never injects the same handoff twice", async () => {
  const w = world();
  writeHandoff(w.handoffDir, baseMeta);

  const first = await runHook(
    "session-start",
    { cwd: w.projectRoot, session_id: "s1", source: "startup" },
    w.env
  );
  assert.notEqual(first.stdout.trim(), "", "the first session should get it");

  const second = await runHook(
    "session-start",
    { cwd: w.projectRoot, session_id: "s2", source: "startup" },
    w.env
  );
  assert.equal(second.stdout.trim(), "", "the second must not get it again");
});

test("hook session-start: ignores a handoff older than the age gate", async () => {
  const w = world();
  const stale = new Date();
  stale.setDate(stale.getDate() - 30); // default maxAgeDays is 7
  writeHandoff(w.handoffDir, { ...baseMeta, created: stale.toISOString() });

  const { stdout } = await runHook(
    "session-start",
    { cwd: w.projectRoot, session_id: "s1", source: "startup" },
    w.env
  );

  assert.equal(stdout.trim(), "", "a month-old handoff is not worth restoring");
});

test("hook session-start: ignores sources other than startup and clear", async () => {
  const w = world();
  writeHandoff(w.handoffDir, baseMeta);

  const { stdout } = await runHook(
    "session-start",
    { cwd: w.projectRoot, session_id: "s1", source: "resume" },
    w.env
  );

  // Resuming a session already carries its own context. Injecting on top of it
  // would pay for the handoff twice.
  assert.equal(stdout.trim(), "", "resume must not trigger an injection");
  assert.equal(
    readMeta(join(w.handoffDir, "latest.meta.json")).consumed,
    false,
    "and must not burn the handoff"
  );
});

// ── the hard rule: a hook can never break a session ─────────────────────────

test("hook: exits 0 on malformed input rather than failing the session", async () => {
  const w = world();

  for (const payload of [{}, { cwd: "/nonexistent/nowhere" }, "not json at all"]) {
    for (const event of ["session-start", "session-end", "pre-compact"]) {
      const { code } = await runHook(event, payload, w.env);
      assert.equal(code, 0, `${event} must exit 0 on ${JSON.stringify(payload)}`);
    }
  }
});

test("hook session-end: exits 0 when the transcript is missing", async () => {
  const w = world();

  const { code } = await runHook(
    "session-end",
    {
      transcript_path: join(w.home, "does-not-exist.jsonl"),
      cwd: w.projectRoot,
      session_id: SESSION_ID,
    },
    w.env
  );

  assert.equal(code, 0, "a missing transcript is not the user's problem");
});

// ── user-prompt-submit: the advisor ─────────────────────────────────────────

test("hook user-prompt-submit: warns when the 5h window crosses the threshold", async () => {
  const w = world();

  // The advisor reads quota from the statusline bridge. Plant a fresh bridge
  // entry over the default 85% threshold.
  const bridgeDir = join(w.env.CLAUDE_CONFIG_DIR!, "lodestone");
  mkdirSync(bridgeDir, { recursive: true });
  writeFileSync(
    join(bridgeDir, "usage-cache.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      source: "statusline",
      five_hour: { used_percentage: 87, resets_at_ts: Math.floor(Date.now() / 1000) + 3600 },
    }),
    "utf8"
  );

  const { stdout, code } = await runHook(
    "user-prompt-submit",
    { session_id: "s1", cwd: w.projectRoot, transcript_path: w.transcript },
    w.env
  );

  assert.equal(code, 0);
  const out = JSON.parse(stdout.trim()) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
    systemMessage?: string;
  };
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(out.systemMessage ?? "", /5h window at 87%/, "the user must see the warning");
  assert.match(out.systemMessage ?? "", /cache is warm/);
});

test("hook user-prompt-submit: stays silent below the thresholds", async () => {
  const w = world();
  const bridgeDir = join(w.env.CLAUDE_CONFIG_DIR!, "lodestone");
  mkdirSync(bridgeDir, { recursive: true });
  writeFileSync(
    join(bridgeDir, "usage-cache.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      source: "statusline",
      five_hour: { used_percentage: 30 },
      seven_day: { used_percentage: 40 },
    }),
    "utf8"
  );

  const { stdout, code } = await runHook(
    "user-prompt-submit",
    { session_id: "s1", cwd: w.projectRoot, transcript_path: w.transcript },
    w.env
  );

  assert.equal(code, 0);
  assert.equal(stdout.trim(), "", "a healthy quota must inject nothing");
});

test("hook user-prompt-submit: banks a recovery snapshot at the critical threshold", async () => {
  const w = world();
  const bridgeDir = join(w.env.CLAUDE_CONFIG_DIR!, "lodestone");
  mkdirSync(bridgeDir, { recursive: true });
  writeFileSync(
    join(bridgeDir, "usage-cache.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      source: "statusline",
      five_hour: { used_percentage: 97 },
    }),
    "utf8"
  );

  const { stdout, code } = await runHook(
    "user-prompt-submit",
    { session_id: SESSION_ID, cwd: w.projectRoot, transcript_path: w.transcript },
    w.env
  );

  assert.equal(code, 0);
  const out = JSON.parse(stdout.trim()) as { systemMessage?: string };
  assert.match(out.systemMessage ?? "", /snapshot saved/, "the wall message must confirm the bank");
  assert.ok(
    existsSync(join(w.handoffDir, "auto", `${SESSION_ID}.md`)),
    "the recovery snapshot must actually exist on disk"
  );
});
