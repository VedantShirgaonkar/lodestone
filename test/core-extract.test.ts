import { test } from "node:test";
import assert from "node:assert";
import { extractSnapshot, captureGitInfo } from "../src/core/extract.js";
import { parseSession } from "../src/core/transcript.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __file = fileURLToPath(import.meta.url);
const __dir = dirname(__file);
// When tests are run from dist/test, need to go up 2 levels; from test/, need to go up 1 level
const isCompiledTest = __file.includes("/dist/test/");
const projectRoot = isCompiledTest
  ? join(__dir, "../..")
  : join(__dir, "..");
const fixturesDir = join(projectRoot, "test/fixtures");

test("extract: extractSnapshot extracts goal from first substantial user prompt", async () => {
  const parsed = await parseSession(join(fixturesDir, "session-small.jsonl"));
  const snapshot = extractSnapshot(parsed);

  assert.ok(snapshot.goal.length > 0);
  assert.match(snapshot.goal, /todo list app/i);
});

test("extract: extractSnapshot extracts last 3 prompts", async () => {
  const parsed = await parseSession(join(fixturesDir, "session-small.jsonl"));
  const snapshot = extractSnapshot(parsed);

  assert.ok(snapshot.lastThreePrompts.length > 0);
  assert.ok(snapshot.lastThreePrompts.length <= 3);
});

test("extract: extractSnapshot extracts todos from TodoWrite", async () => {
  const parsed = await parseSession(join(fixturesDir, "session-small.jsonl"));
  const snapshot = extractSnapshot(parsed);

  assert.ok(snapshot.latestTodos.length > 0);
  assert.match(snapshot.latestTodos.join("|"), /Implement|Add/);
});

test("extract: extractSnapshot extracts edited files", async () => {
  const parsed = await parseSession(join(fixturesDir, "session-small.jsonl"));
  const snapshot = extractSnapshot(parsed);

  assert.ok(snapshot.filesEdited.length > 0);
  assert.ok(
    snapshot.filesEdited.some((f) => f.name.includes("App.tsx"))
  );
});

test("extract: extractSnapshot extracts read files", async () => {
  const parsed = await parseSession(join(fixturesDir, "session-small.jsonl"));
  const snapshot = extractSnapshot(parsed);

  assert.ok(snapshot.filesRead.length > 0);
  assert.ok(
    snapshot.filesRead.some((f) => f.includes("package.json"))
  );
});

test("extract: extractSnapshot captures final assistant text", async () => {
  const parsed = await parseSession(join(fixturesDir, "session-small.jsonl"));
  const snapshot = extractSnapshot(parsed);

  assert.ok(snapshot.finalAssistantText.length > 0);
});

test("extract: extractSnapshot captures context tokens", async () => {
  const parsed = await parseSession(join(fixturesDir, "session-small.jsonl"));
  const snapshot = extractSnapshot(parsed);

  assert.ok(snapshot.metrics.contextTokens > 0);
});

test("extract: extractSnapshot captures metrics", async () => {
  const parsed = await parseSession(join(fixturesDir, "session-small.jsonl"));
  const snapshot = extractSnapshot(parsed);

  assert.ok(snapshot.metrics.turnCount > 0);
  assert.ok(snapshot.metrics.sessionDurationMin >= 0);
});

test("extract: extractSnapshot captures compact summary", async () => {
  const parsed = await parseSession(join(fixturesDir, "session-compacted.jsonl"));
  const snapshot = extractSnapshot(parsed);

  assert.ok(snapshot.latestCompactSummary);
  assert.match(snapshot.latestCompactSummary ?? "", /conversation/i);
});

test("extract: captureGitInfo returns object", () => {
  const info = captureGitInfo("/tmp");
  assert.ok(typeof info === "object");
  // May or may not have branch/isDirty depending on env
});

test("extract: extractSnapshot accepts injected gitInfo", async () => {
  const parsed = await parseSession(join(fixturesDir, "session-small.jsonl"));
  const gitInfo = { branch: "feature/test", isDirty: true };
  const snapshot = extractSnapshot(parsed, { gitInfo });

  assert.equal(snapshot.gitInfo.branch, "feature/test");
  assert.equal(snapshot.gitInfo.isDirty, true);
});
