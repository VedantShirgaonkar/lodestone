import { parseArgs } from "node:util";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, appendFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
          userPromptSubmitCmd: `${hookCmd} user-prompt-submit`,
        });

        console.log(`profile ${profileName}: hooks installed`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`profile ${profileName}: ${msg}`);
      }

      // Install the /handoff skill where this profile's Claude Code discovers
      // personal skills: <configDir>/skills/handoff/SKILL.md. Until this line
      // existed, nothing on the documented setup path installed the skill at
      // all — only `init --project` copied it, per project, so every user who
      // ran `lodestone setup` had a README, an advisor and a wizard all
      // recommending a /handoff command that did not exist in their sessions.
      installSkill(join(profileConfigDir, "skills", "handoff", "SKILL.md"), profileName);

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
      userPromptSubmitCmd: `${hookCmd} user-prompt-submit`,
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

    // Copy the /handoff skill into the project's own skills dir.
    installSkill(join(claudeDir, "skills", "handoff", "SKILL.md"));

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
 * Copy the bundled /handoff SKILL.md to a destination, reporting the outcome.
 * A missing bundle is reported, never silently skipped: a silent skip here is
 * how the skill went uninstalled for every user without anyone noticing.
 */
function installSkill(destPath: string, profileName?: string): void {
  const prefix = profileName ? `profile ${profileName}: ` : "";
  try {
    const source = resolveSkillPath();
    if (!existsSync(source)) {
      console.error(`${prefix}skill: bundled SKILL.md not found at ${source}`);
      return;
    }
    mkdirSync(dirname(destPath), { recursive: true });
    copyFileSync(source, destPath);
    console.log(`${prefix}skill: /handoff installed`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${prefix}skill copy failed: ${msg}`);
  }
}

/**
 * Resolve the path to the bundled SKILL.md file.
 * Package structure: dist/commands/, so ../../skills/handoff/SKILL.md
 */
function resolveSkillPath(): string {
  // fileURLToPath, never a string-replace on the URL: `import.meta.url` is
  // percent-encoded (a space is %20) and carries a drive-letter prefix on
  // Windows (file:///C:/…), so the naive strip produced a path that exists on
  // no machine outside a POSIX install with no spaces — and the existsSync
  // guard above then skipped the copy without a word.
  const commandsDir = dirname(fileURLToPath(import.meta.url));
  return resolve(join(commandsDir, "..", "..", "skills", "handoff", "SKILL.md"));
}
