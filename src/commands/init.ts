import { parseArgs } from "node:util";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, appendFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "../core/config.js";
import { findProjectRoot } from "../core/paths.js";
import { installHooks } from "../core/settingsEdit.js";

interface CommandOptions {
  json: boolean;
  profile?: string | undefined;
}

export async function init(args: string[], opts: CommandOptions): Promise<number> {
  try {
    const { values: parsedOpts } = parseArgs({
      args,
      options: {
        project: { type: "boolean" },
        statusline: { type: "boolean" },
        force: { type: "boolean" },
      },
      allowPositionals: false,
      strict: true,
    });

    const isProject = (parsedOpts.project as boolean) ?? false;
    const isStatusline = (parsedOpts.statusline as boolean) ?? false;
    const force = (parsedOpts.force as boolean) ?? false;

    if (isProject) {
      return await initProject(isStatusline, force);
    } else {
      return await initUser(isStatusline, force);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`lodestone init: ${msg}`);
    return 1;
  }
}

/**
 * User-level init: install hooks into all registered profiles.
 */
async function initUser(isStatusline: boolean, force: boolean): Promise<number> {
  try {
    const config = loadConfig();

    // Get the hook command (allow override via env for testing)
    const hookCmd = process.env.LODESTONE_HOOK_CMD || "lodestone hook";

    // Create ~/.config/lodestone if it doesn't exist
    const configDir = dirname(config.settings ? "" : join(homedir(), ".config", "lodestone", "config.json"));
    mkdirSync(configDir, { recursive: true });

    // Install hooks into each profile
    for (const [profileName, profile] of Object.entries(config.profiles)) {
      const profileConfigDir = profile.configDir;

      try {
        installHooks(profileConfigDir, {
          sessionStartCmd: `${hookCmd} session-start`,
          sessionStartMatcher: "startup|clear",
          sessionEndCmd: `${hookCmd} session-end`,
          preCompactCmd: `${hookCmd} pre-compact`,
        });

        console.log(`profile ${profileName}: hooks installed`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`profile ${profileName}: ${msg}`);
      }

      // Install statusline if requested
      if (isStatusline) {
        try {
          const settingsPath = join(profileConfigDir, "settings.json");
          let settings: Record<string, unknown> = {};

          if (existsSync(settingsPath)) {
            const raw = readFileSync(settingsPath, "utf8");
            settings = JSON.parse(raw) as Record<string, unknown>;
          }

          // Check if statusLine already exists and is different
          const existingStatusLine = settings.statusLine as Record<string, unknown> | undefined;
          if (existingStatusLine && typeof existingStatusLine === "object") {
            const existingCmd = existingStatusLine.command;
            const ourCmd = "lodestone statusline";
            if (
              existingCmd &&
              typeof existingCmd === "string" &&
              existingCmd !== ourCmd &&
              !force
            ) {
              console.error(
                `profile ${profileName}: statusLine command already set; use --force to override`
              );
              continue;
            }
          }

          // Set statusLine
          settings.statusLine = {
            type: "command",
            command: "lodestone statusline",
          };

          mkdirSync(dirname(settingsPath), { recursive: true });
          writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
          console.log(`profile ${profileName}: statusline configured`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`profile ${profileName}: statusline failed: ${msg}`);
        }
      }
    }

    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`lodestone init: ${msg}`);
    return 1;
  }
}

/**
 * Project-level init: install hooks into .claude/settings.json,
 * add to .gitignore, and copy SKILL.md.
 */
async function initProject(isStatusline: boolean, force: boolean): Promise<number> {
  try {
    const projectRoot = findProjectRoot(process.cwd());
    const claudeDir = join(projectRoot, ".claude");
    const settingsPath = join(claudeDir, "settings.json");

    // Get the hook command
    const hookCmd = process.env.LODESTONE_HOOK_CMD || "lodestone hook";

    // Install hooks
    mkdirSync(claudeDir, { recursive: true });
    installHooks(settingsPath, {
      sessionStartCmd: `${hookCmd} session-start`,
      sessionStartMatcher: "startup|clear",
      sessionEndCmd: `${hookCmd} session-end`,
      preCompactCmd: `${hookCmd} pre-compact`,
    });

    console.log(`project settings: hooks installed`);

    // Add to .gitignore
    const gitignorePath = join(projectRoot, ".gitignore");
    const handoffIgnore = ".claude/handoff/";

    let gitignoreContent = "";
    if (existsSync(gitignorePath)) {
      gitignoreContent = readFileSync(gitignorePath, "utf8");
    }

    if (!gitignoreContent.includes(handoffIgnore)) {
      if (gitignoreContent && !gitignoreContent.endsWith("\n")) {
        gitignoreContent += "\n";
      }
      gitignoreContent += handoffIgnore + "\n";
      writeFileSync(gitignorePath, gitignoreContent, "utf8");
      console.log(`.gitignore: added ${handoffIgnore}`);
    } else {
      console.log(`.gitignore: ${handoffIgnore} already present`);
    }

    // Copy SKILL.md
    try {
      const skillSourcePath = resolveSkillPath();
      if (existsSync(skillSourcePath)) {
        const skillDestDir = join(claudeDir, "skills", "handoff");
        mkdirSync(skillDestDir, { recursive: true });
        const skillDestPath = join(skillDestDir, "SKILL.md");

        copyFileSync(skillSourcePath, skillDestPath);
        console.log(`skill: /handoff installed`);
      }
    } catch (err) {
      // Silent fail on skill copy
      console.error(`skill copy failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Install statusline if requested
    if (isStatusline) {
      try {
        let settings: Record<string, unknown> = {};
        if (existsSync(settingsPath)) {
          const raw = readFileSync(settingsPath, "utf8");
          settings = JSON.parse(raw) as Record<string, unknown>;
        }

        const existingStatusLine = settings.statusLine as Record<string, unknown> | undefined;
        if (
          existingStatusLine &&
          typeof existingStatusLine === "object"
        ) {
          const existingCmd = existingStatusLine.command;
          const ourCmd = "lodestone statusline";
          if (
            existingCmd &&
            typeof existingCmd === "string" &&
            existingCmd !== ourCmd &&
            !force
          ) {
            console.error(
              `project statusLine command already set; use --force to override`
            );
            return 1;
          }
        }

        settings.statusLine = {
          type: "command",
          command: "lodestone statusline",
        };

        writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
        console.log(`project settings: statusline configured`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`project statusline failed: ${msg}`);
        return 1;
      }
    }

    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`lodestone init --project: ${msg}`);
    return 1;
  }
}

/**
 * Resolve the path to the bundled SKILL.md file.
 * Package structure: dist/commands/, so ../../skills/handoff/SKILL.md
 */
function resolveSkillPath(): string {
  // When compiled, this file is at dist/commands/init.js
  // So we go up to dist/, then into skills/handoff/
  const commandsDir = dirname(import.meta.url.replace("file://", ""));
  const distDir = dirname(commandsDir);
  const skillPath = join(distDir, "..", "skills", "handoff", "SKILL.md");
  return resolve(skillPath);
}
