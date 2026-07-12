import { launchInteractive } from "../core/claudeCli.js";
import { loadConfig } from "../core/config.js";

interface CommandOptions {
  json: boolean;
  profile?: string | undefined;
}

export async function login(
  args: string[],
  _opts: CommandOptions
): Promise<number> {
  if (args.length === 0 || !args[0]) {
    console.error("warmswap login: missing profile name");
    return 2;
  }

  const profileName = args[0];

  try {
    const config = loadConfig();
    const profileCfg = config.profiles[profileName];
    if (!profileCfg) {
      console.error(`warmswap login: profile not found: ${profileName}`);
      return 1;
    }

    const profile = { name: profileName, ...profileCfg };
    return launchInteractive(profile, ["/login"]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`warmswap login: ${msg}`);
    return 1;
  }
}
