import { parseArgs } from "node:util";
import { stderr } from "node:process";
import { join } from "node:path";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { loadConfig } from "../core/config.js";
import { expandTilde, projectsDirFor } from "../core/paths.js";
import {
  parseSession,
  latestSession,
  latestContextTokens,
  type ParsedSession,
} from "../core/transcript.js";
import { loadLatestHandoff, estimateTokens } from "../core/handoffFile.js";

interface CommandOptions {
  json: boolean;
  profile?: string | undefined;
}

interface AuditEvent {
  type: "explicit" | "heuristic";
  sourceProfile: string;
  targetProfile: string;
  project: string;
  sourceContextTokens: number;
  targetFirstTurnCacheCreation?: number;
  naiveEstimate: number;
  handoffEstimate: number;
  savedEstimate?: number;
}

interface AuditOutput {
  events: AuditEvent[];
  totalEvents: number;
  totalEstimatedSaved: number;
}

/**
 * warmswap audit — analyze handoff and switch events
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
      const output: AuditOutput = {
        events,
        totalEvents: events.length,
        totalEstimatedSaved: events.reduce(
          (sum, e) => sum + (e.savedEstimate || 0),
          0
        ),
      };
      console.log(JSON.stringify(output, null, 2));
    } else {
      renderText(events);
    }

    return 0;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);
    stderr.write(`warmswap audit: ${message}\n`);
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

        const sessionPath = latestSession(configDir, projectPath);
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

  // Detector A: Explicit handoff records (via meta.json consumedBy)
  const seenHandoffPairs = new Set<string>();
  for (const [profileName, profileCfg] of Object.entries(config.profiles)) {
    const configDir = expandTilde(
      (profileCfg as Record<string, unknown>).configDir as string
    );

    try {
      const projectsDir = projectsDirFor(configDir);
      if (!existsSync(projectsDir)) continue;

      const projects = readdirSync(projectsDir);
      for (const projectMunged of projects) {
        const projectPath = join(projectsDir, projectMunged);
        if (!statSync(projectPath).isDirectory()) continue;

        // Look for handoff meta files
        const handoffDir = join(projectPath, ".claude", "handoff");
        if (!existsSync(handoffDir)) continue;

        const metaFile = join(handoffDir, "latest.meta.json");
        if (!existsSync(metaFile)) continue;

        try {
          const metaContent = JSON.parse(readFileSync(metaFile, "utf8")) as {
            consumed?: boolean;
            consumedBy?: {
              profile?: string;
              sessionId?: string;
            };
            sourceProfile?: string;
            contextTokens?: number;
          };

          if (
            metaContent.consumed &&
            metaContent.consumedBy?.profile &&
            metaContent.sourceProfile &&
            metaContent.consumedBy.profile !== metaContent.sourceProfile
          ) {
            const pairKey = `${metaContent.sourceProfile}→${metaContent.consumedBy.profile}/${projectMunged}`;
            if (!seenHandoffPairs.has(pairKey)) {
              seenHandoffPairs.add(pairKey);

              const sourceContextTokens = metaContent.contextTokens || 0;
              const naiveEstimate = sourceContextTokens * 2;
              const handoffEstimate =
                sourceContextTokens + (20000 + sourceContextTokens * 0.5);
              const savedEstimate = Math.max(0, naiveEstimate - handoffEstimate);

              events.push({
                type: "explicit",
                sourceProfile: metaContent.sourceProfile,
                targetProfile: metaContent.consumedBy.profile,
                project: projectMunged,
                sourceContextTokens,
                naiveEstimate,
                handoffEstimate,
                savedEstimate,
              });
            }
          }
        } catch {
          // Skip on parse error
        }
      }
    } catch {
      // Skip on error
    }
  }

  // Detector B: Heuristic boundary detection (same project, A ends → B starts <30min, different profiles)
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

    // Look for pairs A→B within 30min
    for (let i = 0; i < sessions.length - 1; i++) {
      const sessionA = sessions[i];
      const sessionB = sessions[i + 1];

      if (!sessionA || !sessionB || sessionA.profile === sessionB.profile) {
        continue; // Same profile, not a switch
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
        if (!seenHandoffPairs.has(pairKey)) {
          seenHandoffPairs.add(pairKey);

          const sourceContextTokens = sessionA.parsed ? latestContextTokens(sessionA.parsed) : 0;
          const naiveEstimate = sourceContextTokens * 2;
          const handoffEstimate =
            sourceContextTokens + (20000 + sourceContextTokens * 0.5);
          const savedEstimate = Math.max(0, naiveEstimate - handoffEstimate);

          events.push({
            type: "heuristic",
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
    console.log("No switch events found");
    return;
  }

  console.log(`Found ${events.length} switch event(s):\n`);

  let totalSaved = 0;

  for (const event of events) {
    console.log(
      `${event.type.toUpperCase()} · ${event.sourceProfile} → ${event.targetProfile}`
    );
    console.log(
      `  Project: ${event.project}`
    );
    console.log(
      `  Context abandoned: ${event.sourceContextTokens} tokens`
    );
    console.log(
      `  Naive switch: ~${event.naiveEstimate} tokens`
    );
    console.log(
      `  Handoff path: ~${event.handoffEstimate} tokens`
    );
    if (event.savedEstimate) {
      console.log(
        `  Estimated saved: ~${event.savedEstimate} tokens`
      );
      totalSaved += event.savedEstimate;
    }
    console.log();
  }

  console.log(`Totals: ${events.length} event(s), ~${totalSaved} tokens saved`);
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
