import { test } from "node:test";
import assert from "node:assert";
import { parseSession, contextTokensOf } from "../src/core/transcript.js";
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

test("transcript: parseSession parses small session", async () => {
  const parsed = await parseSession(join(fixturesDir, "session-small.jsonl"));

  assert.ok(parsed.meta.sessionId);
  assert.ok(parsed.turns.length > 0);
  // New model: turns = all unique assistant messages (deduped by message.id)
  // session-small.jsonl has a1 (deduplicated), a2, a3, a4 = 4 turns
  assert.equal(parsed.turns.length, 4);
});

test("transcript: parseSession dedupes assistant lines by message.id", async () => {
  const parsed = await parseSession(join(fixturesDir, "session-small.jsonl"));

  // session-small.jsonl has duplicate a1 with same message.id - should keep only last
  // Plus a2, a3, a4 = 4 turns total
  assert.equal(parsed.turns.length, 4);
});

test("transcript: parseSession filters sidechains", async () => {
  const parsed = await parseSession(join(fixturesDir, "session-sidechain.jsonl"));

  // session-sidechain has sidechain lines - they should be excluded from main thread
  // Main thread should only have u1, a1, u2, a2 (not sidechain-u1, sidechain-a1)
  assert.equal(parsed.turns.length, 2);
});

test("transcript: parseSession captures compact summaries", async () => {
  const parsed = await parseSession(join(fixturesDir, "session-compacted.jsonl"));

  assert.ok(parsed.compactSummaries.length > 0);
  assert.match(parsed.compactSummaries[0] ?? "", /conversation so far/i);
});

test("transcript: parseSession extracts tool uses", async () => {
  const parsed = await parseSession(join(fixturesDir, "session-small.jsonl"));

  // session-small has TodoWrite and Read tool_use
  const todoWrite = parsed.toolUses.find((t) => t.name === "TodoWrite");
  assert.ok(todoWrite);

  const read = parsed.toolUses.find((t) => t.name === "Read");
  assert.ok(read);
});

test("transcript: parseSession captures session meta", async () => {
  const parsed = await parseSession(join(fixturesDir, "session-small.jsonl"));

  assert.ok(parsed.meta.sessionId);
  assert.ok(parsed.meta.slug);
  assert.ok(parsed.meta.model);
  assert.ok(parsed.meta.gitBranch);
  assert.ok(parsed.meta.firstTs);
  assert.ok(parsed.meta.lastTs);
});

test("transcript: contextTokensOf calculates correctly", () => {
  const usage = {
    input_tokens: 100,
    cache_read_input_tokens: 200,
    cache_creation_input_tokens: 300,
  };

  const tokens = contextTokensOf(usage);
  assert.equal(tokens, 600);
});

test("transcript: contextTokensOf handles missing fields", () => {
  const usage = {
    input_tokens: 100,
  };

  const tokens = contextTokensOf(usage);
  assert.equal(tokens, 100);
});

test("transcript: contextTokensOf handles undefined", () => {
  const tokens = contextTokensOf(undefined);
  assert.equal(tokens, 0);
});
