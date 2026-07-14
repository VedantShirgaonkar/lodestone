import { parseArgs } from "node:util";
import { loadConfig, saveConfig } from "../core/config.js";
import { lodestoneConfigPath } from "../core/paths.js";

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
      console.error("lodestone config: usage: config get|set <key> [value]");
      console.error(
        "  keys: realUsage, autoSnapshot, maxAgeDays, advisor.fiveHourPct, advisor.weeklyPct,\n" +
          "        advisor.criticalPct, advisor.trailStaleMinutes, keepalive.maxWindowPct, plan"
      );
      return 2;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`lodestone config: ${msg}`);
    return 1;
  }
}

function configGet(key: string | undefined, opts: CommandOptions): number {
  if (!key) {
    console.error("lodestone config get: missing key");
    return 2;
  }

  const config = loadConfig();
  let value: unknown;

  if (key === "realUsage") {
    value = config.settings.realUsage ?? false;
  } else if (key === "autoSnapshot") {
    value = config.settings.autoSnapshot ?? true;
  } else if (key === "maxAgeDays") {
    value = config.settings.maxAgeDays ?? 7;
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
    console.error(`lodestone config: unknown key: ${key}`);
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
    console.error("lodestone config set: missing key or value");
    return 2;
  }

  const config = loadConfig();

  try {
    if (key === "realUsage") {
      // "on" is what the docs, the extension button and every human types.
      // Accepting only "true" meant this switch silently stayed off.
      const v = value.trim().toLowerCase();
      const truthy = ["on", "true", "yes", "1", "enable", "enabled"];
      const falsy = ["off", "false", "no", "0", "disable", "disabled"];
      if (!truthy.includes(v) && !falsy.includes(v)) {
        console.error(
          `lodestone config: realUsage must be on or off (got "${value}")`
        );
        return 1;
      }
      config.settings.realUsage = truthy.includes(v);
    } else if (key === "autoSnapshot") {
      // The hooks honor this setting; until now nothing could set it short of
      // hand-editing the JSON.
      const v = value.trim().toLowerCase();
      const truthy = ["on", "true", "yes", "1", "enable", "enabled"];
      const falsy = ["off", "false", "no", "0", "disable", "disabled"];
      if (!truthy.includes(v) && !falsy.includes(v)) {
        console.error(
          `lodestone config: autoSnapshot must be on or off (got "${value}")`
        );
        return 1;
      }
      config.settings.autoSnapshot = truthy.includes(v);
    } else if (key === "maxAgeDays") {
      const numValue = parseInt(value, 10);
      if (isNaN(numValue) || numValue < 1) {
        console.error("lodestone config: maxAgeDays must be ≥1");
        return 1;
      }
      config.settings.maxAgeDays = numValue;
    } else if (key === "advisor.fiveHourPct") {
      const numValue = parseInt(value, 10);
      if (isNaN(numValue) || numValue < 0 || numValue > 100) {
        console.error("lodestone config: fiveHourPct must be 0-100");
        return 1;
      }
      if (!config.settings.advisor) {
        config.settings.advisor = {};
      }
      config.settings.advisor.fiveHourPct = numValue;
    } else if (key === "advisor.weeklyPct") {
      const numValue = parseInt(value, 10);
      if (isNaN(numValue) || numValue < 0 || numValue > 100) {
        console.error("lodestone config: weeklyPct must be 0-100");
        return 1;
      }
      if (!config.settings.advisor) {
        config.settings.advisor = {};
      }
      config.settings.advisor.weeklyPct = numValue;
    } else if (key === "advisor.criticalPct") {
      const numValue = parseInt(value, 10);
      if (isNaN(numValue) || numValue < 1 || numValue > 100) {
        console.error("lodestone config: criticalPct must be 1-100");
        return 1;
      }
      if (!config.settings.advisor) {
        config.settings.advisor = {};
      }
      config.settings.advisor.criticalPct = numValue;
    } else if (key === "advisor.trailStaleMinutes") {
      const numValue = parseInt(value, 10);
      if (isNaN(numValue) || numValue < 1) {
        console.error("lodestone config: trailStaleMinutes must be ≥1");
        return 1;
      }
      if (!config.settings.advisor) {
        config.settings.advisor = {};
      }
      config.settings.advisor.trailStaleMinutes = numValue;
    } else if (key === "keepalive.maxWindowPct") {
      const numValue = parseInt(value, 10);
      if (isNaN(numValue) || numValue < 1 || numValue > 99) {
        console.error("lodestone config: maxWindowPct must be 1-99");
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
          `lodestone config: plan must be one of: ${validPlans.join(", ")}`
        );
        return 1;
      }
      config.settings.plan = value;
    } else {
      console.error(`lodestone config: unknown key: ${key}`);
      return 1;
    }

    saveConfig(config);

    const configPath = lodestoneConfigPath();
    if (opts.json) {
      console.log(JSON.stringify({ key, value, configPath }));
    } else {
      console.log(`${key} = ${value}`);
      console.log(`config: ${configPath}`);
    }

    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`lodestone config: ${msg}`);
    return 1;
  }
}
