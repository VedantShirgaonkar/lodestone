import { appendFileSync, existsSync, renameSync, statSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(homedir(), ".config", "warmswap");
const LOG_FILE = join(LOG_DIR, "warmswap.log");
const MAX_SIZE_BYTES = 1024 * 1024; // 1MB

function ensureLogDir(): void {
  try {
    statSync(LOG_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        mkdirSync(LOG_DIR, { recursive: true });
      } catch {
        // Silent fail
      }
    }
  }
}

function rotateIfNeeded(): void {
  try {
    if (existsSync(LOG_FILE)) {
      const stat = statSync(LOG_FILE);
      if (stat.size > MAX_SIZE_BYTES) {
        const rotatedPath = `${LOG_FILE}.1`;
        renameSync(LOG_FILE, rotatedPath);
      }
    }
  } catch {
    // Silent fail on rotation
  }
}

export function logError(message: string): void {
  logInternal("ERROR", message);
}

export function logInfo(message: string): void {
  logInternal("INFO", message);
}

function logInternal(level: string, message: string): void {
  try {
    ensureLogDir();
    rotateIfNeeded();
    const timestamp = new Date().toISOString();
    const line = `${timestamp} [${level}] ${message}\n`;
    appendFileSync(LOG_FILE, line, "utf8");
  } catch {
    // Silent fail on any logging error
  }
}
