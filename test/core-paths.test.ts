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

test("paths: mungeCwd matches Claude Code's real rule, not just slashes", () => {
  // Claude Code replaces every character that is not ASCII alphanumeric or `-`
  // with `-` (verified against live ~/.claude/projects entries and
  // anthropics/claude-code#19972). mungeCwd used to replace only `/`, so for
  // any project with a space in its path — 3 of 9 on the machine this was
  // found on — every session lookup resolved to a directory that does not
  // exist and every per-project command reported "no session".

  // The real pair that exposed it:
  assert.equal(
    mungeCwd("/Users/rahul/Desktop/RAIT QA"),
    "-Users-rahul-Desktop-RAIT-QA"
  );
  // Dots (anthropics/claude-code: dots become dashes; tmpdirs are full of them)
  assert.equal(mungeCwd("/srv/next.js-app"), "-srv-next-js-app");
  // Underscores (anthropics/claude-code#30828)
  assert.equal(mungeCwd("/home/u/my_project"), "-home-u-my-project");
  // Backslashes (Windows separators)
  assert.equal(mungeCwd("C:\\Users\\alex\\app"), "C--Users-alex-app");
  // Non-ASCII: each character becomes its own dash, runs are not collapsed
  assert.equal(mungeCwd("/data/研究"), "-data---");
  // Hyphens already in the path survive untouched
  assert.equal(mungeCwd("/code/my-app"), "-code-my-app");
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
