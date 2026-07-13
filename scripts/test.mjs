/**
 * Run the test suite.
 *
 * Two reasons this is a script rather than a one-liner in package.json:
 *
 * 1. `node --test "dist-test/test/*.test.js"` hands the glob to Node, and Node
 *    only learned to expand globs in `--test` at v21. We support Node 20, so on
 *    the very floor of our stated range the command matched nothing and every CI
 *    run failed with "Could not find". Enumerating the files here works on every
 *    version, and on Windows, where the shell would not expand a glob either.
 *
 * 2. The suite runs against a scratch HOME. Two separate bugs have already
 *    shipped where a test wrote into the developer's real configuration, each
 *    time because it isolated one environment variable and not the next one
 *    (HOME, but not XDG_CONFIG_HOME; and one that isolated nothing at all, which
 *    accumulated 369 junk hooks in a real ~/.claude/settings.json). Tests are
 *    still expected to isolate themselves. This makes forgetting harmless
 *    instead of destructive.
 */
import { readdirSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = join("dist-test", "test");

let files;
try {
  files = readdirSync(testDir)
    .filter((f) => f.endsWith(".test.js"))
    .sort()
    .map((f) => join(testDir, f));
} catch {
  console.error(`Cannot read ${testDir}. Run \`npm run build\` first.`);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`No test files in ${testDir}. Did the build emit anything?`);
  process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), "lodestone-test-home-"));

const { status } = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home, // Windows
    XDG_CONFIG_HOME: join(home, ".config"),
  },
});

process.exit(status ?? 1);
