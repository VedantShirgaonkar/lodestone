import { stdin, stdout } from "node:process";
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { findProjectRoot, handoffDirFor, mungeCwd, projectsDirFor } from "../core/paths.js";
import { freshest, markConsumed, markTrailConsumed, markAutoConsumed, estimateTokens } from "../core/handoffFile.js";
import { loadConfig } from "../core/config.js";
import { resolveActingProfile } from "../core/profiles.js";
import { parseSession } from "../core/transcript.js";
import { captureGitInfo, extractSnapshot } from "../core/extract.js";
import { composeHandoff } from "../core/composeHandoff.js";
import { saveHandoff } from "../core/handoffFile.js";
import { getQuota, advisorStatePath } from "../core/realUsage.js";
import { logError, logInfo } from "../util/log.js";

interface HookSessionStartInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  model?: string;
  source?: string;
}

interface HookSessionEndInput {
  transcript_path?: string;
  cwd?: string;
  session_id?: string;
}

interface HookSpecificOutput {
  hookEventName: string;
  additionalContext: string;
}

interface HookOutput {
  hookSpecificOutput: HookSpecificOutput;
  systemMessage?: string;
}

export async function hook(args: string[]): Promise<number> {
  try {
    const { values: parsedOpts, positionals } = parseArgs({
      args,
      options: {
        "self-test": { type: "boolean" },
      },
      allowPositionals: true,
    });

    const subcommand = positionals[0];
    const selfTest = (parsedOpts["self-test"] as boolean) ?? false;

    if (selfTest) {
      return await hookSelfTest();
    }

    if (!subcommand) {
      return 0;
    }

    // Read stdin with 200ms guard for TTY
    const input = await readStdinJson();
    if (!input) {
      return 0;
    }

    if (subcommand === "session-start") {
      return await hookSessionStart(input);
    } else if (subcommand === "session-end") {
      return await hookSessionEnd(input);
    } else if (subcommand === "pre-compact") {
      return await hookPreCompact(input);
    } else if (subcommand === "user-prompt-submit") {
      return await hookUserPromptSubmit(input);
    }

    return 0;
  } catch (err) {
    logError(`hook: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/**
 * Read JSON from stdin with a 200ms guard for TTY (no-input).
 */
async function readStdinJson(): Promise<unknown> {
  return new Promise((resolve) => {
    let data = "";
    let timeoutId: NodeJS.Timeout | undefined;

    // If stdin is a TTY, timeout after 200ms
    if (stdin.isTTY) {
      timeoutId = setTimeout(() => {
        resolve(undefined);
      }, 200);
    }

    stdin.on("data", (chunk) => {
      if (timeoutId) clearTimeout(timeoutId);
      data += chunk.toString();
    });

    stdin.on("end", () => {
      if (timeoutId) clearTimeout(timeoutId);
      try {
        const parsed = JSON.parse(data) as unknown;
        resolve(parsed);
      } catch {
        resolve(undefined);
      }
    });

    stdin.on("error", () => {
      if (timeoutId) clearTimeout(timeoutId);
      resolve(undefined);
    });

    // Set timeout for non-TTY input after 200ms if no data received
    if (!stdin.isTTY) {
      setTimeout(() => {
        if (data === "") {
          resolve(undefined);
        }
      }, 200);
    }
  });
}

/**
 * Hook session-start: inject handoff if fresh and unconsumed.
 */
async function hookSessionStart(input: unknown): Promise<number> {
  try {
    const typedInput = input as HookSessionStartInput;
    const { cwd, source, session_id: sessionId } = typedInput;

    if (!cwd) {
      return 0;
    }

    // Only act when source is "startup" or "clear", or when source is missing
    if (source && source !== "startup" && source !== "clear") {
      return 0;
    }

    const projectRoot = findProjectRoot(cwd);
    const config = loadConfig();

    // Get freshest handoff
    const handoff = freshest(projectRoot);
    if (!handoff) {
      return 0;
    }

    const { markdown, meta, origin, path: handoffPath } = handoff;

    // freshest() already filters consumed entries per-origin (including the
    // revived-trail case, where meta.consumed is true but a newer trail
    // version makes it eligible again) — do not re-check meta.consumed here.

    // Age gate: trail freshness was already mtime-gated inside freshest();
    // latest/auto metas carry an accurate created timestamp.
    const maxAgeDays = config.settings.maxAgeDays ?? 7;
    const created = new Date(meta.created);
    const now = new Date();
    const ageMs = now.getTime() - created.getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    if (origin !== "trail" && ageDays > maxAgeDays) {
      return 0;
    }

    // Format age for display
    const ageStr = ageDays < 1
      ? Math.round(ageDays * 24) + "h"
      : Math.round(ageDays) + "d";

    // Estimate tokens
    const tokens = estimateTokens(markdown);

    // Create framing wrapper
    const frame = `[Restored handoff from ${meta.sourceProfile || "unknown"}/${ageStr} — verify file paths and git state before relying on details]\n\n`;
    const additionalContext = frame + markdown;

    // Create output
    const output: HookOutput = {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext,
      },
      systemMessage: `lodestone: restored handoff (~${tokens} tokens, from ${meta.sourceProfile || "unknown"}, ${ageStr})`,
    };

    stdout.write(JSON.stringify(output) + "\n");

    // Mark the ORIGIN store consumed — attributed to the consuming profile.
    // Marking latest.meta.json for a trail/auto injection would let that
    // trail/auto re-inject on every future session start.
    const consumer = resolveActingProfile()?.name ?? "unknown";
    const sessionStr = sessionId ?? "unknown";
    if (origin === "latest") {
      markConsumed(projectRoot, consumer, sessionStr);
    } else if (origin === "trail") {
      markTrailConsumed(projectRoot, consumer, sessionStr);
    } else {
      markAutoConsumed(projectRoot, handoffPath, consumer, sessionStr);
    }

    return 0;
  } catch (err) {
    logError(`hook session-start: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/**
 * Hook session-end / pre-compact: auto-snapshot to auto/ directory.
 * Budget: 2s total, exit 0 on any error.
 */
async function hookSessionEnd(input: unknown): Promise<number> {
  const deadline = Date.now() + 2000; // 2-second deadline

  try {
    const typedInput = input as HookSessionEndInput;
    const { transcript_path: transcriptPath, cwd, session_id: sessionId } = typedInput;

    if (!transcriptPath || !cwd) {
      return 0;
    }

    const config = loadConfig();
    if (config.settings.autoSnapshot === false) {
      return 0;
    }

    // Check deadline
    if (Date.now() > deadline) {
      return 0;
    }

    const projectRoot = findProjectRoot(cwd);

    // Parse transcript
    if (!existsSync(transcriptPath)) {
      logError(`hook session-end: transcript not found: ${transcriptPath}`);
      return 0;
    }

    const parsed = await parseSession(transcriptPath);

    // Check deadline
    if (Date.now() > deadline) {
      return 0;
    }

    // Extract snapshot
    const gitInfo = captureGitInfo(projectRoot);
    const extracted = extractSnapshot(parsed, { gitInfo });

    // Compose handoff
    const created = new Date().toISOString();
    const composed = composeHandoff(extracted, {
      sourceProfile: "auto",
      sourceSession: parsed.meta.slug || sessionId || "unknown",
      project: parsed.meta.gitBranch || "unknown",
      branch: extracted.gitInfo.branch || undefined,
      contextTokens: extracted.metrics.contextTokens,
      distilled: false,
      created,
    });

    const { markdown, meta } = composed;

    // Check deadline
    if (Date.now() > deadline) {
      return 0;
    }

    // Write to auto/
    const handoffDir = handoffDirFor(projectRoot);
    const autoDir = join(handoffDir, "auto");
    mkdirSync(autoDir, { recursive: true });

    const autoId = sessionId || parsed.meta.sessionId || "unknown";
    const autoPath = join(autoDir, `${autoId}.md`);
    const autoMetaPath = join(autoDir, `${autoId}.meta.json`);

    writeFileSync(autoPath, markdown, "utf8");
    writeFileSync(autoMetaPath, JSON.stringify(meta, null, 2), "utf8");

    logInfo(`auto-snapshot: ${autoId}`);
    return 0;
  } catch (err) {
    logError(`hook session-end: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/**
 * Hook pre-compact: alias for session-end flow
 */
async function hookPreCompact(input: unknown): Promise<number> {
  return hookSessionEnd(input);
}

/**
 * Hook user-prompt-submit: advisor hook to warn when quota thresholds are crossed.
 * Reads quota via bridge cache or OAuth (opt-in); thresholds from settings.advisor.
 * Debounces: warns once per 5%-step per session (state file).
 */
interface UserPromptSubmitInput {
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
}

async function hookUserPromptSubmit(input: unknown): Promise<number> {
  const deadline = Date.now() + 500; // 500ms budget (critical snapshot may exceed once)

  try {
    const typedInput = input as UserPromptSubmitInput;
    const { session_id: sessionId, cwd, transcript_path: transcriptPath } = typedInput;

    if (!cwd) {
      return 0;
    }

    // Resolve profile
    const profile = resolveActingProfile();
    if (!profile) {
      return 0;
    }

    const config = loadConfig();
    const sessionKey = sessionId || "unknown";
    const advisorState = readAdvisorState(profile.configDir, sessionKey);

    const messages: string[] = [];
    const contexts: string[] = [];
    let stateChanged = false;

    // ── Trail staleness reminder (independent of quota) ──────────────────
    // Only when trail mode is installed for this project.
    try {
      const projectRoot = findProjectRoot(cwd);
      const rulesPath = join(projectRoot, ".claude", "rules", "lodestone-trail.md");
      if (existsSync(rulesPath)) {
        const staleMinutes = config.settings.advisor?.trailStaleMinutes ?? 20;
        const trailPath = join(projectRoot, ".claude", "handoff", "trail.md");
        const trailMtime = existsSync(trailPath)
          ? statSync(trailPath).mtime.getTime()
          : 0; // 0 = never written
        const staleMs = staleMinutes * 60 * 1000;
        const isStale = Date.now() - trailMtime > staleMs;
        // Remind once per trail version: again only after Claude updates it
        // (new mtime) and it goes stale again.
        const alreadyRemindedFor = advisorState.trailRemindMtime;
        if (isStale && alreadyRemindedFor !== trailMtime) {
          advisorState.trailRemindMtime = trailMtime;
          stateChanged = true;
          contexts.push(
            trailMtime === 0
              ? "(Trail mode is on but .claude/handoff/trail.md does not exist yet — create it now per the trail rules, then continue the task.)"
              : "(The session trail at .claude/handoff/trail.md is stale — update its sections now per the trail rules, then continue the task.)"
          );
        }
      }
    } catch {
      // never block on trail bookkeeping
    }

    // ── Quota thresholds ─────────────────────────────────────────────────
    const fiveHourThreshold = config.settings.advisor?.fiveHourPct ?? 85;
    const weeklyThreshold = config.settings.advisor?.weeklyPct ?? 90;
    const criticalThreshold = config.settings.advisor?.criticalPct ?? 95;

    const quota = await getQuota(
      profile.configDir,
      undefined,
      config.settings.realUsage ?? false
    );

    let warningUtilization: number | undefined;
    let warningWindow: "5h" | "7d" | undefined;

    if (
      quota.fiveHourUtilization !== undefined &&
      quota.fiveHourUtilization >= fiveHourThreshold
    ) {
      warningUtilization = quota.fiveHourUtilization;
      warningWindow = "5h";
    } else if (
      quota.sevenDayUtilization !== undefined &&
      quota.sevenDayUtilization >= weeklyThreshold
    ) {
      warningUtilization = quota.sevenDayUtilization;
      warningWindow = "7d";
    }

    if (warningUtilization !== undefined && warningWindow !== undefined) {
      const currentBucket = Math.floor(warningUtilization / 5) * 5;
      const lastBucket = advisorState[warningWindow];
      const isNewBucket = lastBucket === undefined || currentBucket > lastBucket;

      const isCritical = warningUtilization >= criticalThreshold;

      if (isCritical && !advisorState.criticalSnapshotDone) {
        // Wall imminent: bank a snapshot NOW so the wall can't catch us
        // empty-handed, regardless of what the user does next. Reuses the
        // session-end flow (2s budget, exit-0, respects autoSnapshot=false).
        advisorState.criticalSnapshotDone = true;
        stateChanged = true;
        if (transcriptPath && config.settings.autoSnapshot !== false) {
          await hookSessionEnd({
            transcript_path: transcriptPath,
            cwd,
            session_id: sessionId,
          });
        }
        messages.push(
          `lodestone: ${warningWindow} window at ${warningUtilization}% — snapshot saved. ` +
            `If the limit hits: after reset, start a fresh session here and it loads automatically. ` +
            `Cross-account: lodestone switch <profile>.`
        );
        contexts.push(
          "(A recovery snapshot was just saved. Claude may suggest /handoff for a higher-quality handoff while the session is still alive.)"
        );
      } else if (isNewBucket && !isCritical) {
        advisorState[warningWindow] = currentBucket;
        stateChanged = true;
        messages.push(
          `lodestone: ${warningWindow} window at ${warningUtilization}% — cache is warm. ` +
            `Shedding bloat in place? use /compact (native). Crossing a boundary? /handoff then ` +
            `lodestone switch <profile> or /clear to refresh here.`
        );
        contexts.push(
          "(Claude may suggest running /handoff to write a high-quality handoff while cache is warm — for a same-account context refresh via /clear, or before switching accounts.)"
        );
      } else if (isNewBucket) {
        // critical bucket repeat (snapshot already banked) — stay quiet
        advisorState[warningWindow] = currentBucket;
        stateChanged = true;
      }
    }

    if (stateChanged) {
      writeAdvisorState(profile.configDir, sessionKey, advisorState);
    }

    if (messages.length === 0 && contexts.length === 0) {
      return 0;
    }

    const output: HookOutput = {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: contexts.join("\n"),
      },
    };
    if (messages.length > 0) {
      output.systemMessage = messages.join(" · ");
    }

    stdout.write(JSON.stringify(output) + "\n");
    void deadline; // budget is advisory; the critical branch may exceed once
    return 0;
  } catch (err) {
    logError(`hook user-prompt-submit: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/**
 * Read advisor debounce state for a session
 */
interface AdvisorState {
  "5h"?: number;
  "7d"?: number;
  /** trail.md mtime (ms) the staleness reminder was last issued for; 0 = missing file */
  trailRemindMtime?: number;
  /** critical-threshold snapshot already banked for this session */
  criticalSnapshotDone?: boolean;
}

function readAdvisorState(
  configDir: string,
  sessionId: string
): AdvisorState {
  const statePath = advisorStatePath(configDir);

  if (!existsSync(statePath)) {
    return {};
  }

  try {
    const raw = readFileSync(statePath, "utf8");
    const data = JSON.parse(raw) as Record<string, AdvisorState>;
    return data[sessionId] ?? {};
  } catch {
    return {};
  }
}

/**
 * Write advisor debounce state for a session
 */
function writeAdvisorState(
  configDir: string,
  sessionId: string,
  state: AdvisorState
): void {
  const statePath = advisorStatePath(configDir);
  const stateDir = dirname(statePath);

  try {
    mkdirSync(stateDir, { recursive: true });

    let data: Record<string, AdvisorState> = {};

    // Read existing state
    if (existsSync(statePath)) {
      try {
        const raw = readFileSync(statePath, "utf8");
        data = JSON.parse(raw) as Record<string, Record<string, number>>;
      } catch {
        data = {};
      }
    }

    // Update session state
    data[sessionId] = state;

    // Atomic write
    const tmpPath = `${statePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmpPath, statePath);
  } catch {
    // Silent fail
  }
}

/**
 * Self-test: verify hook works end-to-end with synthetic input.
 * Doctor uses this to verify hook installation.
 */
async function hookSelfTest(): Promise<number> {
  try {
    const tempDir = `/tmp/lodestone-hook-test-${Date.now()}`;
    mkdirSync(tempDir, { recursive: true });

    // Create synthetic handoff
    const handoffDir = join(tempDir, ".claude", "handoff");
    mkdirSync(handoffDir, { recursive: true });

    const markdown = `# Handoff Snapshot

## Goal
Test goal`;

    const meta = {
      schema: 1,
      created: new Date().toISOString(),
      sourceProfile: "test-profile",
      sourceSession: "test-session",
      project: "test",
      branch: "main",
      contextTokens: 5000,
      distilled: false,
      consumed: false,
    };

    const latestPath = join(handoffDir, "latest.md");
    const metaPath = join(handoffDir, "latest.meta.json");

    writeFileSync(latestPath, markdown, "utf8");
    writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");

    // Verify files exist
    if (!existsSync(latestPath) || !existsSync(metaPath)) {
      console.log("fail self-test: could not create test files");
      return 1;
    }

    // Simulate session-start input
    const testInput: HookSessionStartInput = {
      cwd: tempDir,
      session_id: "test-session-id",
      source: "startup",
    };

    // Run test
    const mockInput: unknown = testInput;
    // We're not actually testing stdout capture here, just that the function runs
    const result = await hookSessionStart(mockInput);

    // The function should complete without throwing
    if (result === 0) {
      console.log("ok self-test: hook session-start works");
      return 0;
    } else {
      console.log("fail self-test: hook returned error code");
      return 1;
    }
  } catch (err) {
    console.log(`fail self-test: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
