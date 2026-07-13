import { isatty } from "node:tty";
import { stdout, stderr } from "node:process";
import { createInterface } from "node:readline";

const NO_COLOR = process.env.NO_COLOR;
const isTTY = !NO_COLOR && isatty(stdout.fd);

/** LODESTONE banner, 77 cols wide, 6 rows */
const BANNER_ART = [
  "██╗      ██████╗ ██████╗ ███████╗███████╗████████╗ ██████╗ ███╗   ██╗███████╗",
  "██║     ██╔═══██╗██╔══██╗██╔════╝██╔════╝╚══██╔══╝██╔═══██╗████╗  ██║██╔════╝",
  "██║     ██║   ██║██║  ██║█████╗  ███████╗   ██║   ██║   ██║██╔██╗ ██║█████╗  ",
  "██║     ██║   ██║██║  ██║██╔══╝  ╚════██║   ██║   ██║   ██║██║╚██╗██║██╔══╝  ",
  "███████╗╚██████╔╝██████╔╝███████╗███████║   ██║   ╚██████╔╝██║ ╚████║███████╗",
  "╚══════╝ ╚═════╝ ╚═════╝ ╚══════╝╚══════╝   ╚═╝    ╚═════╝ ╚═╝  ╚═══╝╚══════╝",
];

/** Gradient from violet (124,108,186) to cyan (74,214,240) across 77 columns */
function columnGradient(col: number): [number, number, number] {
  const cols = 77;
  const t = col / (cols - 1);

  const r = Math.round(124 + (74 - 124) * t);
  const g = Math.round(108 + (214 - 108) * t);
  const b = Math.round(186 + (240 - 186) * t);

  return [r, g, b];
}

function truecolor(r: number, g: number, b: number, text: string): string {
  if (!isTTY) return text;
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

export function banner(): string {
  if (!isTTY) {
    return BANNER_ART.map((l) => "  " + l).join("\n");
  }

  return BANNER_ART.map((line) => {
    const colored = line
      .split("")
      .map((char, col) => {
        const [r, g, b] = columnGradient(col);
        return truecolor(r, g, b, char);
      })
      .join("");
    // Same two-space gutter as every step line printed below it.
    return "  " + colored;
  }).join("\n");
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
  if (!isTTY) return text;

  // Semantic colors from ADR-013
  const colors: Record<StepState, string> = {
    done: "\x1b[32m", // green
    active: "\x1b[36m", // cyan
    todo: "\x1b[90m", // dim
    warn: "\x1b[33m", // amber
    fail: "\x1b[31m", // red
  };

  return `${colors[state]}${text}\x1b[0m`;
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

export function panel(title: string, lines: string[]): string {
  // Compute width: max of title or any line, with padding
  const titleLen = stripAnsi(title).length;
  const lineLengths = lines.map((l) => stripAnsi(l).length);
  const maxLineLen = lineLengths.length > 0 ? Math.max(...lineLengths) : 0;
  const contentWidth = Math.max(titleLen, maxLineLen);
  const width = contentWidth + 2; // padding left/right

  // Don't exceed terminal width (assume 80)
  const effectiveWidth = Math.min(width, 80);

  const topLine = "╭" + "─".repeat(effectiveWidth - 2) + "╮";
  const bottomLine = "╰" + "─".repeat(effectiveWidth - 2) + "╯";

  const titleLine = `│ ${title.padEnd(effectiveWidth - 3)} │`;
  const divider = "├" + "─".repeat(effectiveWidth - 2) + "┤";

  const contentLines = lines.map((line) => {
    const stripped = stripAnsi(line);
    const padding = effectiveWidth - stripped.length - 3;
    return `│ ${line}${" ".repeat(Math.max(0, padding))} │`;
  });

  return [topLine, titleLine, divider, ...contentLines, bottomLine].join("\n");
}

/** Strip ANSI codes for length calculation */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export async function confirm(
  question: string,
  defaultYes: boolean = true
): Promise<boolean> {
  // If not a TTY, return the default immediately
  if (!isTTY) {
    return defaultYes;
  }

  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: stderr,
      terminal: false,
    });

    const prompt = defaultYes ? " [Y/n] " : " [y/N] ";
    stderr.write(question + prompt);

    rl.on("line", (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      if (normalized === "y" || normalized === "yes") {
        resolve(true);
      } else if (normalized === "n" || normalized === "no") {
        resolve(false);
      } else {
        resolve(defaultYes);
      }
    });

    rl.on("close", () => {
      resolve(defaultYes);
    });
  });
}

export async function ask(
  question: string,
  defaultValue: string = ""
): Promise<string> {
  // If not a TTY, return the default immediately
  if (!isTTY) {
    return defaultValue;
  }

  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: stderr,
      terminal: false,
    });

    const prompt = defaultValue ? ` [${defaultValue}] ` : " ";
    stderr.write(question + prompt);

    rl.on("line", (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed || defaultValue);
    });

    rl.on("close", () => {
      resolve(defaultValue);
    });
  });
}

export interface Spinner {
  stop(finalState: StepState, detail?: string): void;
}

const SPINNER_FRAMES: string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

export function spinner(label: string): Spinner {
  if (!isTTY) {
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
  if (!isTTY || n <= 0) return;
  process.stdout.write(`\x1b[${n}A\x1b[0J`);
}

/** How many terminal rows a printed line actually occupies. A long line wraps,
 *  and erasing without accounting for that eats the line above it. */
function rowsFor(text: string): number {
  const width = process.stdout.columns || 80;
  const visible = text.replace(/\x1b\[[0-9;]*m/g, "").length;
  return Math.max(1, Math.ceil(visible / width));
}

/**
 * Ask about one optional feature: show what it is, ask, then clear both lines
 * so the caller can print a single result line in their place.
 */
export async function askStep(
  label: string,
  explanation: string,
  question: string,
  defaultYes: boolean
): Promise<boolean> {
  if (!isTTY) return defaultYes;
  const brand = "\x1b[38;2;124;108;186m";
  const dim = "\x1b[2m";
  const reset = "\x1b[0m";
  // No cursor games. Terminal wrap width cannot be known reliably (process
  // .stdout.columns disagrees with the pty), and an erase that miscounts eats
  // the line above it. The flow simply reads top to bottom, and the summary
  // panel at the end gives the clean checklist.
  console.log();
  console.log(`  ${brand}${label}${reset}`);
  console.log(`  ${dim}${explanation}${reset}`);
  return confirm(`  ${question}`, defaultYes);
}

/** Secondary text: present but not competing for attention. */
export function dimText(text: string): string {
  return isTTY ? `\x1b[2m${text}\x1b[0m` : text;
}
