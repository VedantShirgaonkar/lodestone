import { test } from "node:test";
import assert from "node:assert";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { banner, paint, step, panel, confirm, ask, askStep } from "../src/util/tui.js";

const __testDir = fileURLToPath(new URL(".", import.meta.url));
const CLI = resolve(__testDir, "../..", "bin/lodestone.js");

function runSetup(
  args: string[],
  env: Record<string, string>
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [CLI, "setup", ...args],
      { env: { ...process.env, ...env }, timeout: 10000 },
      (err: unknown, stdout: string, stderr: string) => {
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

test("setup: non-TTY run exits 0 and prints command list", async () => {
  // HOME and XDG_CONFIG_HOME have to move together. lodestoneConfigPath()
  // prefers XDG and falls back to HOME, so overriding one and inheriting the
  // other points the command at a config we did not create.
  const home = "/tmp/test-setup";
  const { stdout, stderr, code } = await runSetup([], {
    HOME: home,
    XDG_CONFIG_HOME: `${home}/.config`,
  });

  assert.equal(code, 0, "exit code should be 0");
  const output = stdout + stderr;
  assert.match(output, /lodestone init/, "should print lodestone init command");
  assert.match(
    output,
    /Not a terminal/,
    "should indicate non-interactive mode"
  );
});

test("tui-banner: emits no escape codes at all when the terminal has no color", () => {
  const result = banner(1);

  assert(!result.includes("\x1b"), "should contain no ANSI codes");
  assert(result.includes("██╗"), "should still draw the block art");
});

test("tui-banner: piped output is plain text", () => {
  // Nothing here is a TTY, so the default depth resolves to 1. A CI log or a
  // `lodestone setup | tee` must not be full of escape codes.
  assert(!banner().includes("\x1b"), "piped banner should be plain");
});

test("tui-banner: uses 256-color escapes, never truecolor, on a 256-color terminal", () => {
  const result = banner(8);

  // The regression that prompted this. Apple Terminal.app advertises
  // xterm-256color and has never supported 24-bit color, but it does not ignore
  // a truecolor escape: it reads `38;2;124;108;186` as a run of separate SGR
  // codes and paints the result, which is why the banner rendered as noise.
  assert(!result.includes("38;2;"), "must not emit a truecolor escape at 8-bit depth");
  assert(result.includes("\x1b[38;5;"), "should emit 256-color escapes");
});

test("tui-banner: uses truecolor escapes only where the terminal has truecolor", () => {
  const result = banner(24);

  assert(result.includes("\x1b[38;2;"), "should emit truecolor escapes at 24-bit depth");
  assert(!result.includes("38;5;"), "should not fall back to the color cube");
});

test("tui-banner: falls back to one flat color at 16 colors", () => {
  const result = banner(4);

  assert(result.includes("\x1b[36m"), "should paint flat cyan");
  assert(!result.includes("38;"), "should emit no extended-color escape");
  assert(result.includes("██╗"), "should still draw the block art");
});

test("tui-banner: swaps in the wordmark when the window is too narrow for the art", () => {
  // The art is 77 columns and sits in a 2-column gutter. Any narrower and it
  // wraps in the middle of an escape sequence and shreds itself.
  const narrow = banner(1, 78);
  assert(!narrow.includes("██╗"), "should not draw block art that cannot fit");
  assert(narrow.includes("L O D E S T O N E"), "should draw the wordmark instead");

  const wide = banner(1, 79);
  assert(wide.includes("██╗"), "should draw the block art once it fits");
});

test("tui-banner: a terminal reporting zero columns still gets the art", () => {
  // Some ptys answer 0 rather than declining to answer. Zero is not nullish, so
  // a `??` default takes it at face value and hides the art on a terminal that
  // had room for it all along.
  assert(banner(1, 0).includes("██╗"), "zero columns means unknown, not narrow");
});

test("tui-paint: emits an escape only where the color changes", () => {
  const text = "x".repeat(77);
  const escapes = (paint(text, 8).match(/\x1b\[38;5;/g) ?? []).length;

  // One escape per character would be 77 of them, roughly 9KB of ANSI for the
  // six-row banner. Quantizing to the color cube collapses neighbouring columns
  // onto the same entry, so the run-length encoding should cost far less.
  assert(escapes > 1, "should still be a gradient, not a single flat color");
  assert(escapes < 20, `expected a handful of escapes, got ${escapes}`);
});

test("tui-step: renders done state", () => {
  const result = step("done", "Test label", "detail");
  assert(result.includes("✔"), "done state should have checkmark");
  assert(result.includes("Test label"), "should include label");
  assert(result.includes("detail"), "should include detail");
});

test("tui-step: renders fail state", () => {
  const result = step("fail", "Error", "something wrong");
  assert(result.includes("✖"), "fail state should have X");
  assert(result.includes("Error"), "should include label");
});

test("tui-step: renders active state", () => {
  const result = step("active", "Working");
  assert(result.includes("▸"), "active state should have arrow");
  assert(result.includes("Working"), "should include label");
});

test("tui-step: renders todo state", () => {
  const result = step("todo", "Pending");
  assert(result.includes("○"), "todo state should have circle");
  assert(result.includes("Pending"), "should include label");
});

test("tui-step: renders warn state", () => {
  const result = step("warn", "Warning", "caution");
  assert(result.includes("!"), "warn state should have exclamation");
  assert(result.includes("Warning"), "should include label");
});

test("tui-panel: renders with title and lines", () => {
  const result = panel("My Title", ["Line 1", "Line 2"]);

  assert(result.includes("My Title"), "should include title");
  assert(result.includes("Line 1"), "should include first line");
  assert(result.includes("Line 2"), "should include second line");
  assert(result.includes("╭"), "should have top-left corner");
  assert(result.includes("╯"), "should have bottom-right corner");
});

test("tui-panel: handles empty lines array", () => {
  const result = panel("Just Title", []);

  assert(result.includes("Just Title"), "should include title");
  assert(result.includes("╭"), "should still have corners");
});

/** Visible width of a rendered row, ignoring color. */
const widthsOf = (box: string): number[] =>
  box.split("\n").map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").length);

test("tui-panel: every row is exactly as wide as its border", () => {
  // The closing panel of `lodestone setup`, which is where this showed up: the
  // right edge came apart into a column of stray bars at varying offsets. The
  // frame was sized at contentWidth + 2 while a row renders at contentWidth + 4,
  // so every row was a column wider than the border above it. The tests above
  // only ever asserted that the text and the corners appeared *somewhere*, which
  // a ragged box does perfectly well.
  const box = panel("One thing left", [
    "Restart your Claude Code session.",
    "The status line and hooks load when a session starts.",
  ]);

  const widths = widthsOf(box);
  assert.equal(
    new Set(widths).size,
    1,
    `box is ragged: rows are ${widths.join(", ")} columns wide`
  );
});

test("tui-panel: a line too wide for the terminal is truncated, not allowed to break the box", () => {
  const box = panel("Title", ["x".repeat(200)], 40);

  const widths = widthsOf(box);
  assert.equal(new Set(widths).size, 1, "must stay square");
  assert.ok(widths[0]! <= 40, `must fit in 40 columns, got ${widths[0]}`);
  assert.ok(box.includes("…"), "and must say that it truncated");
});

test("tui-panel: a colored line is measured by what it shows, not what it stores", () => {
  // An escape sequence occupies no columns. Padding by raw string length would
  // pull the right border in by however many bytes of ANSI the line carried.
  const box = panel("Title", ["\x1b[32mgreen\x1b[0m", "plain"]);

  const widths = widthsOf(box);
  assert.equal(new Set(widths).size, 1, `color skewed the box: ${widths.join(", ")}`);
});

test("tui-paint: every truecolor channel it emits is a valid byte", () => {
  const channels = [...paint("█".repeat(77), 24).matchAll(/38;2;(\d+);(\d+);(\d+)m/g)];

  assert(channels.length > 0, "should have emitted truecolor escapes");
  for (const [, r, g, b] of channels) {
    for (const v of [Number(r), Number(g), Number(b)]) {
      assert(
        Number.isInteger(v) && v >= 0 && v <= 255,
        `channel out of range: ${v}`
      );
    }
  }
});

test("tui-paint: every 256-color index it emits is inside the color cube", () => {
  const indices = [...paint("█".repeat(77), 8).matchAll(/38;5;(\d+)m/g)].map((m) =>
    Number(m[1])
  );

  assert(indices.length > 0, "should have emitted 256-color escapes");
  for (const i of indices) {
    // 16..231 is the 6x6x6 cube. Below it are the 16 system colors, above it
    // the greyscale ramp, and an index outside 0..255 is simply invalid.
    assert(i >= 16 && i <= 231, `index ${i} is outside the 6x6x6 color cube`);
  }
});

// ── the wizard actually listens ─────────────────────────────────────────────
//
// `rl.close()` emits `close` synchronously. The line handler closed the readline
// before resolving, so the close listener's `resolve(default)` always won and the
// typed answer was discarded on an already-settled promise. Every question in
// `lodestone setup` returned its default no matter what was typed. Nothing could
// catch it, because a prompt could not be driven without a terminal.

function stdinOf(text: string): Readable {
  return Readable.from([text]);
}

const driven = (text: string) => ({ input: stdinOf(text), interactive: true });

test("tui-confirm: an explicit yes beats a default of no", async () => {
  // The visible symptom: answering y to trail mode, and being told "skipped".
  assert.equal(await confirm("Turn it on?", false, driven("y\n")), true);
  assert.equal(await confirm("Turn it on?", false, driven("yes\n")), true);
});

test("tui-confirm: an explicit no beats a default of yes", async () => {
  // The dangerous one. "Enable real usage?" defaults to yes and is the only
  // feature in the product that makes a network call. Answering n turned it on.
  assert.equal(await confirm("Enable real usage?", true, driven("n\n")), false);
  assert.equal(await confirm("Enable real usage?", true, driven("no\n")), false);
});

test("tui-confirm: a bare Enter takes the default, either way", async () => {
  assert.equal(await confirm("Install?", true, driven("\n")), true);
  assert.equal(await confirm("Install?", false, driven("\n")), false);
});

test("tui-confirm: an unrecognized answer takes the default rather than guessing", async () => {
  assert.equal(await confirm("Install?", true, driven("maybe\n")), true);
  assert.equal(await confirm("Install?", false, driven("maybe\n")), false);
});

test("tui-confirm: stdin ending with no answer takes the default", async () => {
  // The one case the close listener is actually for: a pipe, or Ctrl-D.
  assert.equal(await confirm("Install?", true, driven("")), true);
  assert.equal(await confirm("Install?", false, driven("")), false);
});

test("tui-confirm: answers are case and whitespace insensitive", async () => {
  assert.equal(await confirm("Install?", false, driven("  Y  \n")), true);
  assert.equal(await confirm("Install?", true, driven("  N  \n")), false);
});

test("tui-ask: returns what was typed, not the default", async () => {
  assert.equal(await ask("Name it", "work", driven("clientwork\n")), "clientwork");
});

test("tui-ask: falls back to the default only when nothing was typed", async () => {
  assert.equal(await ask("Name it", "work", driven("\n")), "work");
  assert.equal(await ask("Name it", "work", driven("")), "work");
});

test("tui-askStep: carries the answer through, it does not re-decide it", async () => {
  const on = await askStep("Trail mode", "notes file", "Turn it on?", false, driven("y\n"));
  assert.equal(on, true, "askStep must not lose the answer confirm read");
});

test("tui-confirm: a non-interactive run takes the default without reading stdin", async () => {
  // A hook, a pipe, CI. Must never block waiting for input that is not coming.
  assert.equal(await confirm("Install?", true, { interactive: false }), true);
  assert.equal(await confirm("Install?", false, { interactive: false }), false);
});
