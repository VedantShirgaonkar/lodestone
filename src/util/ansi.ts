import { isatty } from "node:tty";
import { stdout } from "node:process";

const NO_COLOR = process.env.NO_COLOR;
const isTTY = !NO_COLOR && isatty(stdout.fd);

function color(code: number, text: string): string {
  if (!isTTY) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

export function bold(text: string): string {
  return color(1, text);
}

export function red(text: string): string {
  return color(31, text);
}

export function green(text: string): string {
  return color(32, text);
}

export function yellow(text: string): string {
  return color(33, text);
}

export function blue(text: string): string {
  return color(34, text);
}

export function dim(text: string): string {
  return color(2, text);
}

export function progressBar(
  current: number,
  max: number,
  width: number = 20
): string {
  // Estimates legitimately exceed 100% (a marathon session can blow past a
  // plan-window budget), so the bar fill must be clamped. Without this,
  // "░".repeat(negative) throws and takes the whole command down.
  const pct = max > 0 ? (current / max) * 100 : 0;
  const filled = Math.min(width, Math.max(0, Math.round((pct / 100) * width)));
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  return `[${bar}] ${Math.round(pct)}%`;
}
