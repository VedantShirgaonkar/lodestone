import { isatty } from "node:tty";
import { stdout, stderr } from "node:process";
import { createInterface } from "node:readline";

/**
 * How much color this terminal can actually render: 24 (truecolor), 8 (256
 * colors), 4 (16 colors), or 1 (none). Node works this out from TERM,
 * COLORTERM, TERM_PROGRAM, the CI variables, FORCE_COLOR and NO_COLOR, which is
 * a great deal more than we would get right by hand, and it re-reads the
 * environment on every call.
 *
 * Getting this wrong is not a cosmetic miss. A terminal that cannot parse a
 * truecolor escape does not ignore it. Apple's Terminal.app advertises
 * TERM=xterm-256color, has never supported 24-bit color, and reads
 * `ESC[38;2;124;108;186m` as a run of unrelated SGR codes, then paints the
 * result. The banner used to emit exactly that sequence for every one of its
 * 462 characters, so on the default macOS terminal it came out as noise.
 */
function colorDepth(): Depth {
  if (!isatty(stdout.fd)) return 1;
  const bits =
    typeof stdout.getColorDepth === "function" ? stdout.getColorDepth() : 4;
  return bits >= 24 ? 24 : bits >= 8 ? 8 : bits >= 4 ? 4 : 1;
}

/**
 * Whether we can run an interactive prompt. Deliberately independent of color:
 * NO_COLOR asks us not to paint, not to stop asking questions. Gating the
 * prompts on it meant `NO_COLOR=1 lodestone setup` silently accepted every
 * default without ever showing the user a question.
 */
function canPrompt(): boolean {
  return isatty(stdout.fd);
}

export type Depth = 1 | 4 | 8 | 24;

type RGB = [number, number, number];

/** The brand ramp: violet through to cyan. */
const BRAND_FROM: RGB = [124, 108, 186];
const BRAND_TO: RGB = [74, 214, 240];

const RESET = "\x1b[0m";

/** Plain cyan. Every terminal has had this one since the 1970s. */
const FLAT = "\x1b[36m";

function mix(from: RGB, to: RGB, t: number): RGB {
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
  ];
}

/** The six values one channel of the xterm-256 color cube can take. */
const CUBE = [0, 95, 135, 175, 215, 255];

function nearestCube(v: number): number {
  let best = 0;
  for (let i = 1; i < CUBE.length; i++) {
    if (Math.abs(CUBE[i]! - v) < Math.abs(CUBE[best]! - v)) best = i;
  }
  return best;
}

/** The foreground escape for one color, at the best fidelity this terminal has. */
function fg([r, g, b]: RGB, depth: Depth): string {
  if (depth >= 24) return `\x1b[38;2;${r};${g};${b}m`;
  const cube = 16 + 36 * nearestCube(r) + 6 * nearestCube(g) + nearestCube(b);
  return `\x1b[38;5;${cube}m`;
}

/**
 * Paint text left to right along the brand ramp, at whatever fidelity the
 * terminal has: a smooth gradient in truecolor, the same gradient quantized to
 * the color cube at 256, and a flat cyan where only sixteen colors exist.
 *
 * An escape is emitted only where the color actually changes. At 256 colors
 * neighbouring columns usually quantize to the same cube entry, so a line costs
 * a handful of escapes instead of one per character.
 */
export function paint(text: string, depth: Depth): string {
  if (depth === 1) return text;
  if (depth === 4) return `${FLAT}${text}${RESET}`;

  const span = Math.max(1, text.length - 1);
  let out = "";
  let last = "";
  for (let col = 0; col < text.length; col++) {
    const code = fg(mix(BRAND_FROM, BRAND_TO, col / span), depth);
    if (code !== last) {
      out += code;
      last = code;
    }
    out += text[col];
  }
  return out + RESET;
}

/** LODESTONE in block capitals: 6 rows, 77 columns. */
const BANNER_ART = [
  "██╗      ██████╗ ██████╗ ███████╗███████╗████████╗ ██████╗ ███╗   ██╗███████╗",
  "██║     ██╔═══██╗██╔══██╗██╔════╝██╔════╝╚══██╔══╝██╔═══██╗████╗  ██║██╔════╝",
  "██║     ██║   ██║██║  ██║█████╗  ███████╗   ██║   ██║   ██║██╔██╗ ██║█████╗  ",
  "██║     ██║   ██║██║  ██║██╔══╝  ╚════██║   ██║   ██║   ██║██║╚██╗██║██╔══╝  ",
  "███████╗╚██████╔╝██████╔╝███████╗███████║   ██║   ╚██████╔╝██║ ╚████║███████╗",
  "╚══════╝ ╚═════╝ ╚═════╝ ╚══════╝╚══════╝   ╚═╝    ╚═════╝ ╚═╝  ╚═══╝╚══════╝",
];

/** Stands in for the art when the window is too narrow to hold it. */
const BANNER_COMPACT = "L O D E S T O N E";

/** The same two-space gutter every step line below the banner uses. */
const GUTTER = "  ";

const BANNER_WIDTH = Math.max(...BANNER_ART.map((line) => line.length));

export function banner(
  depth: Depth = colorDepth(),
  columns: number = stdout.columns
): string {
  // A width of 0 is not a narrow terminal, it is a terminal that declined to
  // answer, and some ptys answer exactly that. Treat anything falsy as unknown
  // and assume the classic 80. Doing this in the body rather than as a default
  // argument matters: a caller passing a literal 0 needs the same treatment,
  // and a default only fires on `undefined`.
  const width = columns || 80;

  // Block art in a window too narrow for it wraps in the middle of an escape
  // sequence and shreds itself. The wordmark always fits.
  if (width < BANNER_WIDTH + GUTTER.length) {
    return GUTTER + paint(BANNER_COMPACT, depth);
  }
  return BANNER_ART.map((line) => GUTTER + paint(line, depth)).join("\n");
}

/**
 * Run a command that prints its own progress, without letting that chatter
 * land in the middle of a wizard prompt. The wizard reports the outcome itself,
 * after verifying it.
 */
export async function silently(fn: () => Promise<number>): Promise<number> {
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = err;
  }
}

type StepState = "done" | "active" | "todo" | "warn" | "fail";

function stepSymbol(state: StepState): string {
  switch (state) {
    case "done":
      return "✔";
    case "active":
      return "▸";
    case "todo":
      return "○";
    case "warn":
      return "!";
    case "fail":
      return "✖";
  }
}

function stepColor(state: StepState, text: string): string {
  if (colorDepth() === 1) return text;

  // Semantic colors from ADR-013. All sixteen-color codes, so every terminal
  // that can show color at all can show these.
  const colors: Record<StepState, string> = {
    done: "\x1b[32m", // green
    active: "\x1b[36m", // cyan
    todo: "\x1b[90m", // dim
    warn: "\x1b[33m", // amber
    fail: "\x1b[31m", // red
  };

  return `${colors[state]}${text}${RESET}`;
}

export function step(
  state: StepState,
  label: string,
  detail?: string
): string {
  const symbol = stepSymbol(state);
  const colored = stepColor(state, symbol);

  if (detail !== undefined) {
    // Align detail column at position 35
    const padding = Math.max(1, 35 - (2 + symbol.length + label.length));
    return `  ${colored} ${label}${" ".repeat(padding)}${stepColor("todo", detail)}`;
  }

  return `  ${colored} ${label}`;
}

/**
 * A boxed summary.
 *
 * A row is `│` + space + content + space + `│`, so it occupies four columns more
 * than its content. The old version sized the frame at `contentWidth + 2` and
 * then padded each row to a *different* width again, so every row came out one
 * column wider than the border above it, and a row longer than the frame came
 * out two wider. The box's right edge came apart into a column of stray bars at
 * varying offsets. It clamped the frame to 80 columns without clamping the
 * content to match, which turned a long line into exactly that.
 *
 * Every row here is built from the same content width, so they cannot disagree.
 */
export function panel(
  title: string,
  lines: string[],
  columns: number = stdout.columns || 80
): string {
  const visible = (s: string): number => stripAnsi(s).length;

  // Content that cannot fit is truncated, never allowed to push the border out.
  const budget = Math.max(8, columns - 4);
  const fit = (s: string): string =>
    visible(s) <= budget ? s : stripAnsi(s).slice(0, budget - 1) + "…";

  const head = fit(title);
  const body = lines.map(fit);
  const contentWidth = Math.max(visible(head), 0, ...body.map(visible));

  const rule = (left: string, right: string): string =>
    left + "─".repeat(contentWidth + 2) + right;
  const row = (s: string): string =>
    `│ ${s}${" ".repeat(contentWidth - visible(s))} │`;

  return [
    rule("╭", "╮"),
    row(head),
    rule("├", "┤"),
    ...body.map(row),
    rule("╰", "╯"),
  ].join("\n");
}

/** Strip ANSI codes for length calculation */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Where a prompt reads from, and whether it may prompt at all. Injectable so
 * the wizard's answers can be tested without a terminal, which is the only
 * reason the bug below survived: nothing could drive a question and check what
 * came back.
 */
export interface PromptIO {
  input?: NodeJS.ReadableStream;
  interactive?: boolean;
}

/**
 * Ask a yes/no question.
 *
 * The `close` listener exists for one case only: stdin ending without an answer
 * (a pipe, or Ctrl-D), where the default is all we have. It must never decide a
 * question the user actually answered.
 *
 * That is exactly what it used to do. `rl.close()` emits `close` *synchronously*,
 * and the line handler called `rl.close()` before resolving, so the close
 * listener's `resolve(defaultYes)` always landed first and the line handler's
 * `resolve(answer)` was a no-op on a settled promise. Every question in the
 * setup wizard returned its default no matter what was typed: answering `n` to
 * "Enable real usage?" turned it on anyway, which is an opt-in that cannot be
 * opted out of, and answering `y` to trail mode did nothing at all. Settle once,
 * and settle before closing.
 */
export async function confirm(
  question: string,
  defaultYes: boolean = true,
  io: PromptIO = {}
): Promise<boolean> {
  const interactive = io.interactive ?? canPrompt();
  if (!interactive) {
    return defaultYes;
  }

  return new Promise((resolve) => {
    const rl = createInterface({
      input: io.input ?? process.stdin,
      output: stderr,
      terminal: false,
    });

    let settled = false;
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    stderr.write(question + (defaultYes ? " [Y/n] " : " [y/N] "));

    rl.on("line", (answer) => {
      const normalized = answer.trim().toLowerCase();
      settle(
        normalized === "y" || normalized === "yes"
          ? true
          : normalized === "n" || normalized === "no"
            ? false
            : defaultYes
      );
      rl.close();
    });

    rl.on("close", () => settle(defaultYes));
  });
}

/** Ask for a value. Same settle-before-close rule as `confirm`, same reason. */
export async function ask(
  question: string,
  defaultValue: string = "",
  io: PromptIO = {}
): Promise<string> {
  const interactive = io.interactive ?? canPrompt();
  if (!interactive) {
    return defaultValue;
  }

  return new Promise((resolve) => {
    const rl = createInterface({
      input: io.input ?? process.stdin,
      output: stderr,
      terminal: false,
    });

    let settled = false;
    const settle = (value: string): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    stderr.write(question + (defaultValue ? ` [${defaultValue}] ` : " "));

    rl.on("line", (answer) => {
      settle(answer.trim() || defaultValue);
      rl.close();
    });

    rl.on("close", () => settle(defaultValue));
  });
}

export interface Spinner {
  stop(finalState: StepState, detail?: string): void;
}

const SPINNER_FRAMES: string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

export function spinner(label: string): Spinner {
  if (!canPrompt()) {
    console.log(label);
    return {
      stop: (_state: StepState, _detail?: string) => {
        // Silent
      },
    };
  }

  let frameIdx = 0;
  let stopped = false;

  const interval = setInterval(() => {
    if (stopped) return;
    const frame = SPINNER_FRAMES[frameIdx % SPINNER_FRAMES.length]!;
    process.stderr.write(`\r${stepColor("active", frame)} ${label}...`);
    frameIdx++;
  }, SPINNER_INTERVAL_MS);

  return {
    stop(finalState: StepState, detail?: string) {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);

      // Clear the line and print the final state
      stderr.write("\r");
      console.log(step(finalState, label, detail));
    },
  };
}

/**
 * Erase the last `n` printed lines. Used so a question and its explanation
 * disappear once answered, leaving only the result. Without this the screen
 * fills with every intermediate state and reads like a log, not a wizard.
 */
export function eraseLines(n: number): void {
  if (!canPrompt() || n <= 0) return;
  process.stdout.write(`\x1b[${n}A\x1b[0J`);
}

/**
 * Ask about one optional feature: show what it is, ask, then clear both lines
 * so the caller can print a single result line in their place.
 */
export async function askStep(
  label: string,
  explanation: string,
  question: string,
  defaultYes: boolean,
  io: PromptIO = {}
): Promise<boolean> {
  if (!(io.interactive ?? canPrompt())) return defaultYes;
  // No cursor games. Terminal wrap width cannot be known reliably (process
  // .stdout.columns disagrees with the pty), and an erase that miscounts eats
  // the line above it. The flow simply reads top to bottom, and the summary
  // panel at the end gives the clean checklist.
  console.log();
  console.log(`  ${brandText(label)}`);
  console.log(`  ${dimText(explanation)}`);
  return confirm(`  ${question}`, defaultYes, io);
}

/** The brand violet, degraded to whatever this terminal can show. */
export function brandText(text: string): string {
  const depth = colorDepth();
  if (depth === 1) return text;
  if (depth === 4) return `${FLAT}${text}${RESET}`;
  return `${fg(BRAND_FROM, depth)}${text}${RESET}`;
}

/** Secondary text: present but not competing for attention. */
export function dimText(text: string): string {
  return colorDepth() > 1 ? `\x1b[2m${text}${RESET}` : text;
}
