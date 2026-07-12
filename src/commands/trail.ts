import { parseArgs } from "node:util";
import { stderr } from "node:process";
import { existsSync, statSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { findProjectRoot, trailRulesPathFor, trailSkillPathFor } from "../core/paths.js";

interface CommandOptions {
  json: boolean;
  profile?: string;
}

/**
 * warmswap trail — enable/disable/check trail mode for a project
 *
 * trail on|off|status
 */
export async function trail(args: string[], opts: CommandOptions): Promise<number> {
  try {
    const { positionals } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
    });

    const subcommand = positionals[0];

    if (!subcommand) {
      stderr.write("warmswap trail: usage: trail on|off|status\n");
      return 2;
    }

    const cwd = process.cwd();
    const projectRoot = findProjectRoot(cwd);

    if (subcommand === "on") {
      return await trailOn(projectRoot, opts);
    } else if (subcommand === "off") {
      return await trailOff(projectRoot, opts);
    } else if (subcommand === "status") {
      return await trailStatus(projectRoot, opts);
    } else {
      stderr.write("warmswap trail: unknown subcommand. usage: trail on|off|status\n");
      return 2;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`warmswap trail: ${message}\n`);
    return 1;
  }
}

async function trailOn(projectRoot: string, opts: CommandOptions): Promise<number> {
  try {
    const rulesPath = trailRulesPathFor(projectRoot);
    const skillPath = trailSkillPathFor(projectRoot);

    // Create directories
    mkdirSync(dirname(rulesPath), { recursive: true });
    mkdirSync(dirname(skillPath), { recursive: true });

    // Write rules file. This text is read by CLAUDE at session start — it
    // must command the agent directly, unprompted, with unambiguous triggers.
    const rulesContent = `# Session trail (warmswap)

You maintain \`.claude/handoff/trail.md\` throughout this session, without being asked. It is the session's survival record: if this session ends abruptly (usage limit, crash, closed terminal), the next session continues from that file alone. Write it for a successor who knows nothing you haven't written down.

## When to update (do it immediately, then continue the task)
- After completing a task or a significant piece of work
- After any decision that shapes the work (approach chosen, approach rejected and why, constraint discovered)
- After the user changes direction or priorities
- Before starting anything long-running or risky

## Format — overwrite sections in place; the file never grows beyond ~1,500 tokens
\`\`\`
# Trail
## Goal
<the user's objective and the current task — 1-2 sentences>
## State
<done / in-flight / blocked — 3-5 terse bullets, verification status included>
## Decisions
<choices made WITH the reason; rejected approaches too — they're expensive to rediscover>
## Files
<paths that matter right now, one note each on why>
## Next
<numbered, concrete; first item immediately executable>
\`\`\`

## Hard rules
- Overwrite stale content; never append a diary. If a section outgrows its cap, drop the oldest detail first — never drop Decisions or Next.
- Never write secrets, tokens, or credential material into the trail.
- Reference file paths instead of pasting code blocks.
- Keep each update terse; this file costs tokens every time it is written.
`;

    writeFileSync(rulesPath, rulesContent, "utf8");

    // Write skill file
    const skillContent = `# /trail

Update the trail markdown to reflect current state.

When you complete a work block or make significant decisions, update or create \`.claude/handoff/trail.md\`
with these fixed sections (overwrite each section in place; never append):
- Goal: Current objective (1-2 sentences)
- State: Progress snapshot (3-5 bullets)
- Decisions: Key choices made (3-5 bullets)
- Files: Active files (list with change type)
- Next: Immediate next steps (2-4 bullets)

Keep the total under 1.5k tokens. Never include secrets or credentials.
`;

    writeFileSync(skillPath, skillContent, "utf8");

    if (opts.json) {
      console.log(
        JSON.stringify({
          status: "installed",
          rulesPath,
          skillPath,
        })
      );
    } else {
      console.log(`Trail mode installed`);
      console.log(`  Rules: ${rulesPath}`);
      console.log(`  Skill: ${skillPath}`);
    }

    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`warmswap trail on: ${message}\n`);
    return 1;
  }
}

async function trailOff(projectRoot: string, opts: CommandOptions): Promise<number> {
  try {
    const rulesPath = trailRulesPathFor(projectRoot);
    const skillPath = trailSkillPathFor(projectRoot);

    let rulesRemoved = false;
    let skillRemoved = false;

    if (existsSync(rulesPath)) {
      unlinkSync(rulesPath);
      rulesRemoved = true;
    }

    if (existsSync(skillPath)) {
      unlinkSync(skillPath);
      skillRemoved = true;
    }

    if (opts.json) {
      console.log(
        JSON.stringify({
          status: "removed",
          rulesRemoved,
          skillRemoved,
        })
      );
    } else {
      console.log("Trail mode disabled");
      if (rulesRemoved) console.log(`  Removed: ${rulesPath}`);
      if (skillRemoved) console.log(`  Removed: ${skillPath}`);
    }

    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`warmswap trail off: ${message}\n`);
    return 1;
  }
}

async function trailStatus(projectRoot: string, opts: CommandOptions): Promise<number> {
  try {
    const rulesPath = trailRulesPathFor(projectRoot);
    const skillPath = trailSkillPathFor(projectRoot);

    const rulesExists = existsSync(rulesPath);
    const skillExists = existsSync(skillPath);

    let rulesAge: string | undefined;
    if (rulesExists) {
      const stat = statSync(rulesPath);
      const ageMs = Date.now() - stat.mtime.getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      rulesAge =
        ageDays < 1
          ? Math.round(ageDays * 24) + "h"
          : Math.round(ageDays) + "d";
    }

    const installed = rulesExists && skillExists;

    if (opts.json) {
      console.log(
        JSON.stringify({
          installed,
          rulesExists,
          skillExists,
          rulesAge,
          rulesPath: rulesExists ? rulesPath : undefined,
          skillPath: skillExists ? skillPath : undefined,
        })
      );
    } else {
      if (installed) {
        console.log("Trail mode: installed");
        if (rulesAge) {
          console.log(`  Last update: ${rulesAge} ago`);
        }
        console.log(`  Rules: ${rulesPath}`);
        console.log(`  Skill: ${skillPath}`);
      } else {
        console.log("Trail mode: not installed");
      }
    }

    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`warmswap trail status: ${message}\n`);
    return 1;
  }
}
