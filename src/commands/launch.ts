import { launchInteractive } from "../core/claudeCli.js";
import { loadConfig } from "../core/config.js";

interface CommandOptions {
  json: boolean;
  profile?: string | undefined;
}

export async function launch(
  args: string[],
  opts: CommandOptions
): Promise<number> {
  if (args.length === 0 || !args[0]) {
    console.error("lodestone launch: missing profile name");
    return 2;
  }

  const profileName = args[0];
  const claudeArgs = args.slice(1);
  if (claudeArgs[0] === "--") {
    claudeArgs.shift();
  }

  try {
    const config = loadConfig();
    const profileCfg = config.profiles[profileName];
    if (!profileCfg) {
      console.error(`lodestone launch: profile not found: ${profileName}`);
      return 1;
    }

    // Build ProfileInfo object
    const profile = { name: profileName, ...profileCfg };
    return launchInteractive(profile, claudeArgs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`lodestone launch: ${msg}`);
    return 1;
  }
}
