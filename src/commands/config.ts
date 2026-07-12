import { parseArgs } from "node:util";
import { loadConfig, saveConfig } from "../core/config.js";
import { warmswapConfigPath } from "../core/paths.js";

interface CommandOptions {
  json: boolean;
  profile?: string;
}

export async function config(args: string[], opts: CommandOptions): Promise<number> {
  try {
    const { positionals } = parseArgs({
      args,
      allowPositionals: true,
      strict: false,
    });

    const subcommand = positionals[0];
    const key = positionals[1];
    const value = positionals[2];

    if (subcommand === "get") {
      return configGet(key, opts);
    } else if (subcommand === "set") {
      return configSet(key, value, opts);
    } else {
      console.error("warmswap config: usage: config get|set <key> [value]");
      console.error(
        "  keys: realUsage, advisor.fiveHourPct, advisor.weeklyPct, plan"
      );
      return 2;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`warmswap config: ${msg}`);
    return 1;
  }
}

function configGet(key: string | undefined, opts: CommandOptions): number {
  if (!key) {
    console.error("warmswap config get: missing key");
    return 2;
  }

  const config = loadConfig();
  let value: unknown;

  if (key === "realUsage") {
    value = config.settings.realUsage ?? false;
  } else if (key === "advisor.fiveHourPct") {
    value = config.settings.advisor?.fiveHourPct ?? 85;
  } else if (key === "advisor.weeklyPct") {
    value = config.settings.advisor?.weeklyPct ?? 90;
  } else if (key === "advisor.criticalPct") {
    value = config.settings.advisor?.criticalPct ?? 95;
  } else if (key === "advisor.trailStaleMinutes") {
    value = config.settings.advisor?.trailStaleMinutes ?? 20;
  } else if (key === "keepalive.maxWindowPct") {
    value = config.settings.keepalive?.maxWindowPct ?? 80;
  } else if (key === "plan") {
    value = config.settings.plan ?? "pro";
  } else {
    console.error(`warmswap config: unknown key: ${key}`);
    return 1;
  }

  if (opts.json) {
    console.log(JSON.stringify({ key, value }));
  } else {
    console.log(`${key}: ${value}`);
  }

  return 0;
}

function configSet(key: string | undefined, value: string | undefined, opts: CommandOptions): number {
  if (!key || !value) {
    console.error("warmswap config set: missing key or value");
    return 2;
  }

  const config = loadConfig();

  try {
    if (key === "realUsage") {
      const boolValue = value.toLowerCase() === "true" || value === "1";
      config.settings.realUsage = boolValue;
    } else if (key === "advisor.fiveHourPct") {
      const numValue = parseInt(value, 10);
      if (isNaN(numValue) || numValue < 0 || numValue > 100) {
        console.error("warmswap config: fiveHourPct must be 0-100");
        return 1;
      }
      if (!config.settings.advisor) {
        config.settings.advisor = {};
      }
      config.settings.advisor.fiveHourPct = numValue;
    } else if (key === "advisor.weeklyPct") {
      const numValue = parseInt(value, 10);
      if (isNaN(numValue) || numValue < 0 || numValue > 100) {
        console.error("warmswap config: weeklyPct must be 0-100");
        return 1;
      }
      if (!config.settings.advisor) {
        config.settings.advisor = {};
      }
      config.settings.advisor.weeklyPct = numValue;
    } else if (key === "advisor.criticalPct") {
      const numValue = parseInt(value, 10);
      if (isNaN(numValue) || numValue < 1 || numValue > 100) {
        console.error("warmswap config: criticalPct must be 1-100");
        return 1;
      }
      if (!config.settings.advisor) {
        config.settings.advisor = {};
      }
      config.settings.advisor.criticalPct = numValue;
    } else if (key === "advisor.trailStaleMinutes") {
      const numValue = parseInt(value, 10);
      if (isNaN(numValue) || numValue < 1) {
        console.error("warmswap config: trailStaleMinutes must be ≥1");
        return 1;
      }
      if (!config.settings.advisor) {
        config.settings.advisor = {};
      }
      config.settings.advisor.trailStaleMinutes = numValue;
    } else if (key === "keepalive.maxWindowPct") {
      const numValue = parseInt(value, 10);
      if (isNaN(numValue) || numValue < 1 || numValue > 99) {
        console.error("warmswap config: maxWindowPct must be 1-99");
        return 1;
      }
      if (!config.settings.keepalive) {
        config.settings.keepalive = {};
      }
      config.settings.keepalive.maxWindowPct = numValue;
    } else if (key === "plan") {
      const validPlans = ["pro", "max5", "max20", "team"];
      if (!validPlans.includes(value)) {
        console.error(
          `warmswap config: plan must be one of: ${validPlans.join(", ")}`
        );
        return 1;
      }
      config.settings.plan = value;
    } else {
      console.error(`warmswap config: unknown key: ${key}`);
      return 1;
    }

    saveConfig(config);

    const configPath = warmswapConfigPath();
    if (opts.json) {
      console.log(JSON.stringify({ key, value, configPath }));
    } else {
      console.log(`${key} = ${value}`);
      console.log(`config: ${configPath}`);
    }

    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`warmswap config: ${msg}`);
    return 1;
  }
}
