import { test } from "node:test";
import assert from "node:assert";
import {
  renderHandoff,
  saveHandoff,
  loadLatestHandoff,
  markConsumed,
  estimateTokens,
  allHandoffMetas,
  type HandoffMeta,
} from "../src/core/handoffFile.js";
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), "lodestone-test-handoff");

test.before(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
  mkdirSync(testDir, { recursive: true });
});

test.after(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
});

test("handoffFile: estimateTokens calculates token count", () => {
  const text = "a".repeat(360); // 360 chars ≈ 100 tokens
  const tokens = estimateTokens(text);
  assert.ok(tokens >= 95 && tokens <= 105);
});

test("handoffFile: renderHandoff creates frontmatter", () => {
  const snapshot = {
    goal: "Build a feature",
    state: "Work in progress",
    decisions: "Use TypeScript",
    files: "app.ts",
    lastExchange: "User asked to continue",
    nextSteps: "Add tests",
    openQuestions: "Performance implications?",
    sourceProfile: "work",
    sourceSession: "sess-123",
    project: "my-project",
    branch: "main",
    contextTokens: 50000,
    distilled: false,
  };

  const { markdown, meta } = renderHandoff(snapshot);

  assert.match(markdown, /---/);
  assert.match(markdown, /created:/);
  assert.match(markdown, /sourceProfile: work/);
  assert.match(markdown, /sourceSession: sess-123/);
  assert.match(markdown, /contextTokens: 50000/);
  assert.match(markdown, /# Handoff Snapshot/);
  assert.match(markdown, /## Goal/);

  assert.equal(meta.schema, 1);
  assert.equal(meta.sourceProfile, "work");
  assert.equal(meta.consumed, false);
});

test("handoffFile: saveHandoff and loadLatestHandoff roundtrip", () => {
  const projectRoot = join(testDir, "project1");
  const snapshot = {
    goal: "Test",
    state: "State",
    decisions: "Decisions",
    files: "Files",
    lastExchange: "Exchange",
    nextSteps: "Steps",
    openQuestions: "Questions",
    sourceProfile: "test",
    sourceSession: "sess-456",
    project: "project1",
    branch: "dev",
    contextTokens: 30000,
    distilled: false,
  };

  const { markdown, meta } = renderHandoff(snapshot);
  saveHandoff(projectRoot, markdown, meta);

  const loaded = loadLatestHandoff(projectRoot);
  assert.ok(loaded);
  assert.equal(loaded?.meta.sourceProfile, "test");
  assert.equal(loaded?.meta.sourceSession, "sess-456");
  assert.match(loaded?.markdown ?? "", /Test/);
});

test("handoffFile: markConsumed updates metadata", () => {
  const projectRoot = join(testDir, "project2");
  const snapshot = {
    goal: "Goal",
    state: "State",
    decisions: "Decisions",
    files: "Files",
    lastExchange: "Exchange",
    nextSteps: "Steps",
    openQuestions: "Questions",
    sourceProfile: "source-profile",
    sourceSession: "sess-789",
    project: "project2",
    branch: "main",
    contextTokens: 40000,
    distilled: true,
  };

  const { markdown, meta } = renderHandoff(snapshot);
  saveHandoff(projectRoot, markdown, meta);

  markConsumed(projectRoot, "target-profile", "sess-999");

  const loaded = loadLatestHandoff(projectRoot);
  assert.ok(loaded?.meta.consumed);
  assert.equal(loaded?.meta.consumedBy?.profile, "target-profile");
  assert.equal(loaded?.meta.consumedBy?.session, "sess-999");
});

test("handoffFile: archive rotation keeps 20 files", () => {
  const projectRoot = join(testDir, "project3");
  const snapshot = {
    goal: "Goal",
    state: "State",
    decisions: "Decisions",
    files: "Files",
    lastExchange: "Exchange",
    nextSteps: "Steps",
    openQuestions: "Questions",
    sourceProfile: "test",
    sourceSession: "sess-000",
    project: "project3",
    branch: "main",
    contextTokens: 30000,
    distilled: false,
  };

  // Save multiple times with different timestamps to simulate rotation
  for (let i = 0; i < 25; i++) {
    const { markdown, meta } = renderHandoff({
      ...snapshot,
      sourceSession: `sess-${i}`,
      created: new Date(Date.now() - i * 1000).toISOString(),
    });
    saveHandoff(projectRoot, markdown, meta);
  }

  // At most 20 handoffs are kept, and each keeps its meta: the markdown and the
  // record of what it cost rotate together, or audit outlives its evidence.
  const archiveDir = join(projectRoot, ".claude", "handoff", "archive");
  const files = readdirSync(archiveDir);
  const markdowns = files.filter((f) => f.endsWith(".md"));
  const metas = files.filter((f) => f.endsWith(".meta.json"));

  assert.ok(markdowns.length <= 20, "keeps at most 20 handoffs");
  assert.equal(metas.length, markdowns.length, "every kept handoff kept its meta");
  for (const md of markdowns) {
    const stem = md.slice(0, -".md".length);
    assert.ok(files.includes(`${stem}.meta.json`), `${stem} rotated as a pair`);
  }
});

test("handoffFile: trail consume-once with revival on newer update", async () => {
  const { freshest, markTrailConsumed } = await import("../src/core/handoffFile.js");
  const { trailHandoffPathFor } = await import("../src/core/paths.js");
  const { writeFileSync, utimesSync } = await import("node:fs");
  const root = join(testDir, "trail-revive");
  mkdirSync(join(root, ".claude", "handoff"), { recursive: true });

  const trailPath = trailHandoffPathFor(root);
  writeFileSync(trailPath, "# Trail\n## Goal\nship it\n", "utf8");

  // Eligible before consumption, with trail origin
  const first = freshest(root);
  assert.ok(first, "fresh trail is returned");
  assert.equal(first.origin, "trail");

  // First consumption must WORK even though no meta file existed yet
  markTrailConsumed(root, "personal", "sess-A");
  const afterConsume = freshest(root);
  assert.equal(afterConsume, undefined, "consumed trail must not re-inject");

  // A newer trail update revives eligibility
  const future = new Date(Date.now() + 5000);
  utimesSync(trailPath, future, future);
  const revived = freshest(root);
  assert.ok(revived, "updated trail is eligible again");
  assert.equal(revived.origin, "trail");
});

test("handoffFile: consumed autos are skipped, older unconsumed wins", async () => {
  const { freshest, markAutoConsumed } = await import("../src/core/handoffFile.js");
  const { writeFileSync, utimesSync } = await import("node:fs");
  const root = join(testDir, "auto-skip");
  const autoDir = join(root, ".claude", "handoff", "auto");
  mkdirSync(autoDir, { recursive: true });

  const older = join(autoDir, "old.md");
  const newer = join(autoDir, "new.md");
  writeFileSync(older, "# Handoff Snapshot\nolder\n", "utf8");
  writeFileSync(newer, "# Handoff Snapshot\nnewer\n", "utf8");
  const past = new Date(Date.now() - 60000);
  utimesSync(older, past, past);

  const pick1 = freshest(root);
  assert.ok(pick1);
  assert.equal(pick1.origin, "auto");
  assert.ok(pick1.path.endsWith("new.md"), "newest auto wins first");

  // Consume the newest (meta created on the fly) -> older unconsumed wins
  markAutoConsumed(root, newer, "personal", "sess-B");
  const pick2 = freshest(root);
  assert.ok(pick2, "older unconsumed auto is still eligible");
  assert.ok(pick2.path.endsWith("old.md"));

  markAutoConsumed(root, older, "personal", "sess-B");
  assert.equal(freshest(root), undefined, "all consumed -> nothing injects");
});

test("handoffFile: a consumption record survives the next handoff", () => {
  // The bug this pins: saveHandoff archived the markdown but overwrote
  // latest.meta.json with a fresh consumed:false record. The only evidence that
  // a boundary was ever crossed lived in that file, so every handoff destroyed
  // the measurement of the one before it and `audit` could never report more
  // than the most recent crossing.
  const root = join(testDir, "durable");
  mkdirSync(join(root, ".claude"), { recursive: true });

  const meta = (created: string, session: string): HandoffMeta => ({
    schema: 1,
    created,
    sourceProfile: "personal",
    sourceSession: session,
    project: "-test-durable",
    contextTokens: 150_000,
    distilled: false,
    consumed: false,
  });

  const first = meta("2026-07-13T10:00:00.000Z", "sess-1");
  saveHandoff(root, "# Handoff\nfirst\n", first);
  markConsumed(root, "work", "sess-2");

  // A second handoff, which used to wipe the record above.
  saveHandoff(root, "# Handoff\nsecond\n", meta("2026-07-13T11:00:00.000Z", "sess-3"));

  const metas = allHandoffMetas(root);
  const recovered = metas.find((m) => m.created === "2026-07-13T10:00:00.000Z");
  assert.ok(recovered, "the first handoff is still on the record");
  assert.equal(recovered.consumed, true, "and still known to have been consumed");
  assert.equal(recovered.consumedBy?.profile, "work", "by the account that picked it up");

  const live = metas.find((m) => m.created === "2026-07-13T11:00:00.000Z");
  assert.ok(live, "the current handoff is there too");
  assert.equal(live.consumed, false, "and is correctly still unconsumed");

  assert.equal(metas.length, 2, "two handoffs, counted once each");
});
