import { parseArgs } from "node:util";
import { stderr } from "node:process";
import { join } from "node:path";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { loadConfig } from "../core/config.js";
import { expandTilde, projectsDirFor } from "../core/paths.js";
import {
  parseSession,
  newestSessionIn,
  latestContextTokens,
  type ParsedSession,
} from "../core/transcript.js";
import {
  loadLatestHandoff,
  estimateTokens,
  allHandoffMetas,
} from "../core/handoffFile.js";

interface CommandOptions {
  json: boolean;
  profile?: string | undefined;
}

interface AuditEvent {
  type: "explicit" | "heuristic";
  class: "switch" | "refresh" | "post-reset";
  sourceProfile: string;
  targetProfile: string;
  project: string;
  sourceContextTokens: number;
  targetFirstTurnCacheCreation?: number | undefined;
  naiveEstimate: number;
  handoffEstimate: number;
  savedEstimate?: number | undefined;
  consumedAt?: string | undefined;
}

interface AuditOutput {
  events: AuditEvent[];
  totalEvents: number;
  totalEstimatedSaved: number;
  byClass?: Record<string, { count: number; estimatedSaved: number }>;
}

/**
 * lodestone audit — analyze handoff and switch events
 *
 * audit [--since <days>d] [--json]
 */
export async function audit(
  args: string[],
  opts: CommandOptions
): Promise<number> {
  try {
    const { values: parsedOpts } = parseArgs({
      args,
      options: {
        since: { type: "string", default: "7d" },
      },
      allowPositionals: false,
      strict: true,
    });

    const sinceStr = (parsedOpts.since as string) || "7d";
    const sinceMs = parseDuration(sinceStr);
    if (sinceMs <= 0) {
      throw new Error(`Invalid duration: ${sinceStr}`);
    }

    const before = new Date(Date.now() - sinceMs);

    const config = loadConfig();
    const events = await detectEvents(config, before);

    if (opts.json) {
      // Compute per-class totals
      const byClass: Record<string, { count: number; estimatedSaved: number }> = {};
      for (const event of events) {
        const cls = byClass[event.class] || { count: 0, estimatedSaved: 0 };
        byClass[event.class] = {
          count: cls.count + 1,
          estimatedSaved: cls.estimatedSaved + (event.savedEstimate || 0),
        };
      }

      const output: AuditOutput = {
        events,
        totalEvents: events.length,
        totalEstimatedSaved: events.reduce(
          (sum, e) => sum + (e.savedEstimate || 0),
          0
        ),
        byClass,
      };
      console.log(JSON.stringify(output, null, 2));
    } else {
      renderText(events);
    }

    return 0;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);
    stderr.write(`lodestone audit: ${message}\n`);
    return 1;
  }
}

async function detectEvents(
  config: any,
  before: Date
): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];

  // Collect all sessions by profile and project
  const sessionsByProfileProject: Record<
    string,
    Record<
      string,
      {
        meta: any;
        parsed: any;
      }
    >
  > = {};

  for (const [profileName, profileCfg] of Object.entries(config.profiles)) {
    const cfgObj = profileCfg as Record<string, unknown>;
    const configDir = expandTilde(cfgObj.configDir as string);

    sessionsByProfileProject[profileName] = {};

    try {
      const projectsDir = projectsDirFor(configDir);
      if (!existsSync(projectsDir)) continue;

      const projects = readdirSync(projectsDir);
      for (const projectMunged of projects) {
        const projectPath = join(projectsDir, projectMunged);
        if (!statSync(projectPath).isDirectory()) continue;

        // projectPath is already a projects/<munged>/ directory. Munging it
        // again (which latestSession does) resolves to nothing, which is why
        // this map used to come back empty and no detector ever fired.
        const sessionPath = newestSessionIn(projectPath);
        if (!sessionPath) continue;

        try {
          const parsed = await parseSession(sessionPath);
          sessionsByProfileProject[profileName][projectMunged] = {
            meta: parsed.meta,
            parsed,
          };
        } catch {
          // Skip on parse error
        }
      }
    } catch {
      // Skip on error
    }
  }

  // Detector A: explicit handoff records (meta.json consumedBy).
  //
  // Handoffs live in the project's working directory, not under
  // ~/.claude/projects/<munged>/, and the munged name cannot be reversed: a
  // project at ~/code/my-app munges identically to a nested ~/code/my/app. The
  // transcript carries the true cwd, so take the project root from there.
  const projectRoots = new Map<string, string>(); // munged -> real project root
  for (const projects of Object.values(sessionsByProfileProject)) {
    for (const [projectMunged, entry] of Object.entries(projects)) {
      const cwd = entry?.meta?.cwd as string | undefined;
      if (cwd && !projectRoots.has(projectMunged)) {
        projectRoots.set(projectMunged, cwd);
      }
    }
  }

  const seenHandoffs = new Set<string>();
  // Pairs with a real record. Detector B guesses at boundaries from session
  // timing, so it must stay quiet wherever we already have hard evidence.
  const explicitPairs = new Set<string>();
  // A crossing has to be FROM a real account. Placeholders reach this field
  // two ways: a handoff whose sidecar meta was lost, and auto snapshots written
  // before the provenance fix, which stored the literal "auto". Reporting
  // `auto → personal` would be inventing a crossing from an account that does
  // not exist, so drop those records here rather than downstream: falling
  // through without adding to explicitPairs leaves Detector B free to guess at
  // the same boundary, which is the honest way to describe a guess.
  const realProfiles = new Set(Object.keys(config.profiles));
  for (const [projectMunged, projectRoot] of projectRoots) {
    for (const meta of allHandoffMetas(projectRoot)) {
      if (!meta.consumed || !meta.consumedBy?.profile || !meta.sourceProfile) {
        continue;
      }
      if (!realProfiles.has(meta.sourceProfile)) {
        continue;
      }

      const sourceProfile = meta.sourceProfile;
      const targetProfile = meta.consumedBy.profile;
      const consumedAtStr = meta.consumedBy.at;

      // One event per handoff consumed, not one per profile pair: "every
      // boundary you crossed" has to mean every crossing, not the first.
      const key = `${projectMunged}|${meta.created}|${consumedAtStr ?? ""}`;
      if (seenHandoffs.has(key)) continue;
      seenHandoffs.add(key);

      // An undated record still happened, so keep it; a dated one outside the
      // window is not part of what was asked for.
      if (consumedAtStr && new Date(consumedAtStr) < before) continue;

      let eventClass: "switch" | "refresh" | "post-reset" = "switch";
      if (sourceProfile === targetProfile) {
        // Same profile: a long gap means the window reset under us, a short one
        // means the session was deliberately shed.
        if (consumedAtStr) {
          const sourceLastActivityMtimeMs = getSourceSessionMtime(
            config,
            sourceProfile,
            meta.sourceSession,
            projectMunged,
            meta.created
          );
          const gapHours =
            (new Date(consumedAtStr).getTime() - sourceLastActivityMtimeMs) /
            (60 * 60 * 1000);
          eventClass = gapHours >= 5 ? "post-reset" : "refresh";
        } else {
          eventClass = "refresh";
        }
      }

      explicitPairs.add(`${sourceProfile}→${targetProfile}/${projectMunged}`);

      const sourceContextTokens = meta.contextTokens || 0;
      const naiveEstimate = sourceContextTokens * 2;
      const handoffEstimate =
        sourceContextTokens + (20000 + sourceContextTokens * 0.5);

      events.push({
        type: "explicit",
        class: eventClass,
        sourceProfile,
        targetProfile,
        project: projectMunged,
        sourceContextTokens,
        naiveEstimate,
        handoffEstimate,
        savedEstimate: Math.max(0, naiveEstimate - handoffEstimate),
        consumedAt: consumedAtStr,
      });
    }
  }

  // Detector B: Heuristic boundary detection (same project, A ends → B starts <30min, different profiles only)
  const projectToProfiles: Record<string, any[]> = {};

  for (const profileName of Object.keys(sessionsByProfileProject)) {
    const profileSessions = sessionsByProfileProject[profileName];
    if (!profileSessions) continue;

    for (const [projectMunged, sessionData] of Object.entries(profileSessions)) {
      if (!projectToProfiles[projectMunged]) {
        projectToProfiles[projectMunged] = [];
      }
      projectToProfiles[projectMunged].push({
        profile: profileName,
        ...sessionData,
      });
    }
  }

  for (const projectMunged of Object.keys(projectToProfiles)) {
    const sessions = projectToProfiles[projectMunged];
    if (!sessions) continue;

    // Sort by firstTs
    sessions.sort((a, b) => {
      const aTs = a.meta?.firstTs
        ? new Date(a.meta.firstTs).getTime()
        : Number.MAX_VALUE;
      const bTs = b.meta?.firstTs
        ? new Date(b.meta.firstTs).getTime()
        : Number.MAX_VALUE;
      return aTs - bTs;
    });

    // Look for pairs A→B within 30min (only different profiles for heuristic)
    for (let i = 0; i < sessions.length - 1; i++) {
      const sessionA = sessions[i];
      const sessionB = sessions[i + 1];

      if (!sessionA || !sessionB || sessionA.profile === sessionB.profile) {
        continue; // Same profile, skip heuristic (explicit only)
      }

      const lastTsA = sessionA.meta?.lastTs
        ? new Date(sessionA.meta.lastTs).getTime()
        : null;
      const firstTsB = sessionB.meta?.firstTs
        ? new Date(sessionB.meta.firstTs).getTime()
        : null;

      if (!lastTsA || !firstTsB) continue;

      const gapMs = firstTsB - lastTsA;
      const gapMins = gapMs / (60 * 1000);

      if (gapMins > 0 && gapMins < 30) {
        // Heuristic match
        const pairKey = `${sessionA.profile}→${sessionB.profile}/${projectMunged}`;
        if (!explicitPairs.has(pairKey)) {
          explicitPairs.add(pairKey);

          const sourceContextTokens = sessionA.parsed ? latestContextTokens(sessionA.parsed) : 0;
          const naiveEstimate = sourceContextTokens * 2;
          const handoffEstimate =
            sourceContextTokens + (20000 + sourceContextTokens * 0.5);
          const savedEstimate = Math.max(0, naiveEstimate - handoffEstimate);

          events.push({
            type: "heuristic",
            class: "switch", // Heuristic is always different profiles
            sourceProfile: sessionA.profile,
            targetProfile: sessionB.profile,
            project: projectMunged,
            sourceContextTokens,
            naiveEstimate,
            handoffEstimate,
            savedEstimate,
          });
        }
      }
    }
  }

  return events;
}

function renderText(events: AuditEvent[]): void {
  if (events.length === 0) {
    console.log("No handoff events found");
    return;
  }

  console.log(`Found ${events.length} handoff event(s):\n`);

  // Group by class
  const byClass: Record<string, AuditEvent[]> = { switch: [], refresh: [], "post-reset": [] };
  for (const event of events) {
    byClass[event.class]?.push(event);
  }

  let totalSaved = 0;

  // Print grouped by class
  const classOrder = ["switch", "refresh", "post-reset"] as const;
  for (const className of classOrder) {
    const classEvents = byClass[className] || [];
    if (classEvents.length === 0) continue;

    console.log(`${className.toUpperCase()} (${classEvents.length}):`);
    let classSaved = 0;

    for (const event of classEvents) {
      console.log(
        `  ${event.sourceProfile} → ${event.targetProfile} [${event.project}]`
      );
      console.log(
        `    Context: ${event.sourceContextTokens} tokens | Naive: ~${event.naiveEstimate} | Handoff: ~${event.handoffEstimate}`
      );
      if (event.savedEstimate) {
        console.log(
          `    Saved: ~${event.savedEstimate} tokens`
        );
        classSaved += event.savedEstimate;
        totalSaved += event.savedEstimate;
      }
    }
    console.log(`  Class total: ~${classSaved} tokens\n`);
  }

  console.log(`Totals: ${events.length} event(s), saved ≈ ${totalSaved} tokens`);
}

/**
 * Get the source session's last activity time (mtime of transcript file, if found;
 * else fall back to the handoff's created timestamp).
 * Returns milliseconds since epoch.
 */
function getSourceSessionMtime(
  config: any,
  sourceProfile: string,
  sourceSessionId: string | undefined,
  projectMunged: string,
  fallbackCreated: string | undefined
): number {
  try {
    const profileCfg = (config.profiles as Record<string, unknown>)?.[sourceProfile];
    if (!profileCfg) {
      return fallbackCreated ? new Date(fallbackCreated).getTime() : Date.now();
    }

    const configDir = expandTilde((profileCfg as Record<string, unknown>).configDir as string);
    const projectsDir = projectsDirFor(configDir);
    const projectPath = join(projectsDir, projectMunged);

    if (!existsSync(projectPath)) {
      return fallbackCreated ? new Date(fallbackCreated).getTime() : Date.now();
    }

    // If sourceSessionId is available, try to find that specific file
    if (sourceSessionId) {
      try {
        const files = readdirSync(projectPath);
        for (const file of files) {
          if (file.endsWith(".jsonl")) {
            const filePath = join(projectPath, file);
            try {
              // Quick check: try to read first line to see if sessionId matches
              // For now, just get mtime of the most likely candidate
              const stat = statSync(filePath);
              return stat.mtime.getTime();
            } catch {
              // Skip on error
            }
          }
        }
      } catch {
        // Fall through to fallback
      }
    }

    // Fallback: find latest session in the project directory
    let latestMtime = 0;
    try {
      const files = readdirSync(projectPath);
      for (const file of files) {
        if (file.endsWith(".jsonl")) {
          const filePath = join(projectPath, file);
          const stat = statSync(filePath);
          if (stat.mtime.getTime() > latestMtime) {
            latestMtime = stat.mtime.getTime();
          }
        }
      }
    } catch {
      // Silent fail
    }

    if (latestMtime > 0) {
      return latestMtime;
    }
  } catch {
    // Silent fail
  }

  // Final fallback to created timestamp
  return fallbackCreated ? new Date(fallbackCreated).getTime() : Date.now();
}

function parseDuration(str: string): number {
  const match = str.match(/^(\d+)([smhd])$/);
  if (!match || !match[1] || !match[2]) {
    return -1;
  }

  const num = parseInt(match[1], 10);
  const unit = match[2];

  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return num * (multipliers[unit] || -1);
}
