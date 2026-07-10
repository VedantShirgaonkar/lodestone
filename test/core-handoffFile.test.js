import { test } from "node:test";
import assert from "node:assert";
import { renderHandoff, saveHandoff, loadLatestHandoff, markConsumed, estimateTokens, } from "../src/core/handoffFile.js";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const testDir = join(tmpdir(), "cchandoff-test-handoff");
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
    // Check archive directory has at most 20 files
    const archiveDir = join(projectRoot, ".claude", "handoff", "archive");
    const files = require("node:fs").readdirSync(archiveDir);
    assert.ok(files.length <= 20);
});
