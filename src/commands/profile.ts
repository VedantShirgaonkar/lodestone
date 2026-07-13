import { mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { addProfile, removeProfile, currentProfile, loggedInHint } from "../core/profiles.js";
import { loadConfig, saveConfig } from "../core/config.js";
import { expandTilde } from "../core/paths.js";

interface CommandOptions {
  json: boolean;
  profile?: string | undefined;
}

export async function profile(
  args: string[],
  _opts: CommandOptions
): Promise<number> {
  if (args.length === 0) {
    console.error("lodestone profile: missing subcommand (add|list|remove|rename)");
    return 2;
  }

  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case "add":
      return await profileAdd(subArgs);
    case "list":
      return await profileList();
    case "remove":
      return await profileRemove(subArgs);
    case "rename":
      return await profileRename(subArgs);
    default:
      console.error(`lodestone profile: unknown subcommand: ${subcommand}`);
      return 2;
  }
}

async function profileAdd(args: string[]): Promise<number> {
  if (args.length === 0 || !args[0]) {
    console.error("lodestone profile add: missing name");
    return 2;
  }

  const name = args[0];

  try {
    if (name.includes("/") || name.includes("\\") || name.includes(":")) {
      console.error(`lodestone profile add: invalid name: ${name}`);
      return 1;
    }

    const profileDir = resolve(homedir(), `.claude-profiles/${name}`);
    await mkdir(profileDir, { recursive: true });
    addProfile(name, { configDir: profileDir });

    console.log(`profile added: ${name}`);
    console.log(`to authenticate: lodestone ${name} /login`);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`lodestone profile add: ${msg}`);
    return 1;
  }
}

async function profileList(): Promise<number> {
  try {
    const config = loadConfig();
    const currentProf = await currentProfile();
    const currentName = currentProf?.name;

    if (Object.keys(config.profiles).length === 0) {
      console.log("(no profiles registered)");
      return 0;
    }

    for (const [name, profileInfo] of Object.entries(config.profiles)) {
      const marker = (name === currentName) ? "★" : " ";
      const configDir = expandTilde(profileInfo.configDir);

      try {
        const projectsPath = resolve(configDir, "projects");
        const projects = await readdir(projectsPath, { withFileTypes: true });
        let sessionCount = 0;

        for (const project of projects) {
          if (project.isDirectory()) {
            try {
              const sessions = await readdir(resolve(projectsPath, project.name));
              sessionCount += sessions.filter((s) =>
                s.endsWith(".jsonl")
              ).length;
            } catch {
              // Ignore
            }
          }
        }

        // Use the shared resolver: the default ~/.claude profile keeps
        // .claude.json as a SIBLING, not inside the config dir. Re-implementing
        // this check here is what made `profile list` claim "not logged in"
        // while `doctor` reported the account correctly.
        const loginStatus = loggedInHint({ name, configDir });

        console.log(
          `${marker} ${name.padEnd(15)} ${configDir.padEnd(40)} ${loginStatus.padEnd(15)} ${sessionCount} sessions`
        );
      } catch (err) {
        console.log(
          `${marker} ${name.padEnd(15)} ${configDir.padEnd(40)} (error reading)`
        );
      }
    }

    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`lodestone profile list: ${msg}`);
    return 1;
  }
}

async function profileRemove(args: string[]): Promise<number> {
  if (args.length === 0 || !args[0]) {
    console.error("lodestone profile remove: missing name");
    return 2;
  }

  const name = args[0];

  try {
    const config = loadConfig();

    if (!config.profiles[name]) {
      console.error(`lodestone profile remove: profile not found: ${name}`);
      return 1;
    }

    await removeProfile(name);

    console.log(`profile removed: ${name}`);
    console.log("(profile directory was not deleted)");
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`lodestone profile remove: ${msg}`);
    return 1;
  }
}

async function profileRename(args: string[]): Promise<number> {
  if (args.length < 2 || !args[0] || !args[1]) {
    console.error("lodestone profile rename: missing old or new name");
    return 2;
  }

  const oldName = args[0];
  const newName = args[1];

  try {
    const config = loadConfig();

    if (!config.profiles[oldName]) {
      console.error(`lodestone profile rename: profile not found: ${oldName}`);
      return 1;
    }

    if (newName.includes("/") || newName.includes("\\") || newName.includes(":")) {
      console.error(`lodestone profile rename: invalid name: ${newName}`);
      return 1;
    }

    config.profiles[newName] = config.profiles[oldName];
    delete config.profiles[oldName];

    saveConfig(config);

    console.log(`profile renamed: ${oldName} → ${newName}`);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`lodestone profile rename: ${msg}`);
    return 1;
  }
}
