import { test } from "node:test";
import assert from "node:assert";
import { composeHandoff } from "../src/core/composeHandoff.js";
import { ExtractedSnapshot } from "../src/core/extract.js";

test("composeHandoff: calculates quality 5/5 when all sections present", () => {
  const extracted: ExtractedSnapshot = {
    goal: "Build the landing page",
    lastThreePrompts: ["First prompt", "Second prompt"],
    latestCompactSummary: "We decided to use React",
    filesEdited: [{ name: "index.tsx", count: 5 }],
    filesRead: ["config.ts"],
    finalAssistantText: "I've completed the landing page",
    latestTodos: ["Deploy to production"],
    metrics: { contextTokens: 50000, turnCount: 10, sessionDurationMin: 25 },
    gitInfo: { branch: "main", isDirty: false },
  };

  const composed = composeHandoff(extracted, {
    sourceProfile: "personal",
    sourceSession: "session-123",
    project: "website",
    branch: "main",
    contextTokens: 50000,
    distilled: false,
  });

  assert.equal(composed.quality, 5, "should have quality 5 when all sections present");
  assert(composed.markdown.includes("Build the landing page"), "should include goal");
  assert(composed.markdown.includes("First prompt"), "should include prompts");
  assert.equal(composed.meta.quality, 5);
});

test("composeHandoff: calculates quality 0/5 when all sections placeholder", () => {
  const extracted: ExtractedSnapshot = {
    goal: "",
    lastThreePrompts: [],
    latestCompactSummary: undefined,
    filesEdited: [],
    filesRead: [],
    finalAssistantText: "",
    latestTodos: [],
    metrics: { contextTokens: 10000, turnCount: 1, sessionDurationMin: 5 },
    gitInfo: { branch: undefined, isDirty: false },
  };

  const composed = composeHandoff(extracted, {
    sourceProfile: "personal",
    sourceSession: "session-456",
    project: "empty",
    contextTokens: 10000,
    distilled: false,
  });

  assert.equal(composed.quality, 0, "should have quality 0 when all sections empty");
  assert(composed.markdown.includes("(no goal found)"), "should have placeholder for goal");
  assert(composed.markdown.includes("(no recent activity)"), "should have placeholder for state");
  assert.equal(composed.meta.quality, 0);
});

test("composeHandoff: calculates quality 2/5 with partial data", () => {
  const extracted: ExtractedSnapshot = {
    goal: "Fix the bug",
    lastThreePrompts: [],
    latestCompactSummary: "Used binary search to find it",
    filesEdited: [],
    filesRead: [],
    finalAssistantText: "",
    latestTodos: [],
    metrics: { contextTokens: 25000, turnCount: 5, sessionDurationMin: 15 },
    gitInfo: { branch: "feature/debug", isDirty: false },
  };

  const composed = composeHandoff(extracted, {
    sourceProfile: "personal",
    sourceSession: "session-789",
    project: "debugger",
    branch: "feature/debug",
    contextTokens: 25000,
    distilled: false,
  });

  assert.equal(composed.quality, 2, "should have quality 2 with goal and decisions only");
});

test("composeHandoff: includes metadata with quality", () => {
  const extracted: ExtractedSnapshot = {
    goal: "Test",
    lastThreePrompts: ["prompt"],
    latestCompactSummary: undefined,
    filesEdited: [{ name: "test.ts", count: 1 }],
    filesRead: [],
    finalAssistantText: "done",
    latestTodos: ["cleanup"],
    metrics: { contextTokens: 5000, turnCount: 3, sessionDurationMin: 10 },
    gitInfo: { branch: "test", isDirty: false },
  };

  const composed = composeHandoff(extracted, {
    sourceProfile: "work",
    sourceSession: "sess-test",
    project: "proj",
    branch: "test",
    contextTokens: 5000,
    distilled: true,
  });

  assert.equal(composed.meta.sourceProfile, "work");
  assert.equal(composed.meta.distilled, true);
  assert(typeof composed.meta.created === "string");
  assert(composed.quality >= 0 && composed.quality <= 5);
});

test("composeHandoff: estimates tokens correctly", () => {
  const extracted: ExtractedSnapshot = {
    goal: "A simple goal",
    lastThreePrompts: ["simple prompt"],
    latestCompactSummary: undefined,
    filesEdited: [],
    filesRead: [],
    finalAssistantText: "",
    latestTodos: [],
    metrics: { contextTokens: 1000, turnCount: 2, sessionDurationMin: 5 },
    gitInfo: { branch: undefined, isDirty: false },
  };

  const composed = composeHandoff(extracted, {
    sourceProfile: "p",
    sourceSession: "s",
    project: "proj",
    contextTokens: 1000,
    distilled: false,
  });

  assert(composed.tokens > 0, "should estimate some tokens");
  assert(typeof composed.tokens === "number");
});
