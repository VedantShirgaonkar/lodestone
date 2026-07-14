import { parseArgs } from "node:util";
import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, rmdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { loadConfig } from "../core/config.js";
import { expandTilde, findProjectRoot, lodestoneConfigPath } from "../core/paths.js";
import { uninstallHooks } from "../core/settingsEdit.js";
import { killKeepaliveScheduler } from "../core/keepalive.js";
import { adoptDefault } from "../core/profiles.js";

interface CommandOptions {
  json: boolean;
  profile?: string | undefined;
}

/**
 * lodestone uninstall — remove everything lodestone wired into Claude Code.
 *
 * The inverse of `init`, for people leaving: hooks out of every profile's
 * settings.json, the statusline handed back (only when it is ours), the
 * /handoff skill removed, running keepalive schedulers stopped. It does NOT
 * delete profile config dirs (never — ADR-002), handoff files (your work
 * product), or the lodestone config itself; it says so, and says how.
 */
export async function uninstall(
  args: string[],
  _opts: CommandOptions
): Promise<number> {
  try {
    const { values: parsedOpts } = parseArgs({
      args,
      options: {
        project: { type: "boolean" },
      },
      allowPositionals: false,
      strict: true,
    });

    if ((parsedOpts.project as boolean) ?? false) {
      const projectRoot = findProjectRoot(process.cwd());
      const claudeDir = join(projectRoot, ".claude");
      removeFrom(claudeDir, "project");
      console.log();
      console.log("left in place: .claude/handoff/ (your handoffs), .gitignore entries");
      return 0;
    }

    adoptDefault();
    const config = loadConfig();
    const profiles = Object.entries(config.profiles);

    if (profiles.length === 0) {
      console.log("nothing installed: no profiles registered");
      return 0;
    }

    for (const [name, profileCfg] of profiles) {
      const configDir = expandTilde(profileCfg.configDir);

      // A scheduler pinging on behalf of a tool being removed is a bill
      // nobody is watching. Stop it first.
      const { killed, pid } = killKeepaliveScheduler(name);
      if (killed) {
        console.log(`profile ${name}: stopped keepalive (was pid ${pid})`);
      }

      removeFrom(configDir, `profile ${name}`);
    }

    console.log();
    console.log("left in place:");
    console.log(`  ${lodestoneConfigPath()}  (profile registry — delete it if you want)`);
    console.log("  each project's .claude/handoff/  (your handoffs)");
    console.log("  per-project trail rules  (run `lodestone trail off` in those projects)");
    console.log();
    console.log("then: npm uninstall -g lodestone-cli");
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`lodestone uninstall: ${msg}`);
    return 1;
  }
}

/** Remove hooks, our statusline, and the /handoff skill from one config dir. */
function removeFrom(configDir: string, label: string): void {
  // Hooks: uninstallHooks removes only commands containing "lodestone hook",
  // backs up to settings.json.bak first, and leaves other tools' hooks alone.
  try {
    uninstallHooks(configDir);
    console.log(`${label}: hooks removed`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${label}: hooks: ${msg}`);
  }

  // Statusline: only when the registered command is exactly ours. A user's
  // custom statusline is not ours to take down.
  try {
    const settingsPath = join(configDir, "settings.json");
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
      const statusLine = settings.statusLine as Record<string, unknown> | undefined;
      if (statusLine && statusLine.command === "lodestone statusline") {
        copyFileSync(settingsPath, `${settingsPath}.bak`);
        delete settings.statusLine;
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
        console.log(`${label}: statusline removed`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${label}: statusline: ${msg}`);
  }

  // The /handoff skill: remove the file, and its directory if that leaves it
  // empty. skills/ itself may hold the user's other skills — untouched.
  try {
    const skillPath = join(configDir, "skills", "handoff", "SKILL.md");
    if (existsSync(skillPath)) {
      unlinkSync(skillPath);
      try {
        rmdirSync(dirname(skillPath));
      } catch {
        // not empty; someone put something else there — leave it
      }
      console.log(`${label}: /handoff skill removed`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${label}: skill: ${msg}`);
  }
}
