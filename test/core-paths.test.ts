import { test } from "node:test";
import assert from "node:assert";
import {
  mungeCwd,
  projectsDirFor,
  handoffDirFor,
  expandTilde,
  findProjectRoot,
} from "../src/core/paths.js";
import { homedir } from "node:os";

test("paths: mungeCwd replaces slashes", () => {
  assert.equal(mungeCwd("/Users/alex/code/myapp"), "-Users-alex-code-myapp");
  assert.equal(mungeCwd("/home/user/project"), "-home-user-project");
  assert.equal(mungeCwd("relative/path"), "relative-path");
});

test("paths: projectsDirFor returns correct path", () => {
  const configDir = "/Users/alex/.claude";
  const projectsDir = projectsDirFor(configDir);
  assert.equal(projectsDir, "/Users/alex/.claude/projects");
});

test("paths: handoffDirFor returns correct path", () => {
  const projectRoot = "/Users/alex/code/myapp";
  const handoffDir = handoffDirFor(projectRoot);
  assert.equal(handoffDir, "/Users/alex/code/myapp/.claude/handoff");
});

test("paths: expandTilde expands home dir", () => {
  const expanded = expandTilde("~/.config/test");
  assert.ok(expanded.startsWith(homedir()));
  assert.ok(expanded.includes(".config/test"));
});

test("paths: expandTilde leaves non-tilde paths unchanged", () => {
  const path = "/absolute/path";
  assert.equal(expandTilde(path), path);

  const relPath = "relative/path";
  assert.equal(expandTilde(relPath), relPath);
});

test("paths: findProjectRoot handles no .git", () => {
  // Should return input cwd if no .git found
  const result = findProjectRoot("/tmp");
  assert.equal(result, "/tmp");
});
