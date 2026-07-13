import { isatty } from "node:tty";
import { stdout } from "node:process";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig, saveConfig } from "../core/config.js";
import { claudePath, versionOf } from "../core/claudeCli.js";
import { adoptDefault, loggedInHint, addProfile } from "../core/profiles.js";
import { installHooks } from "../core/settingsEdit.js";
import { getQuota } from "../core/realUsage.js";
import { expandTilde, findProjectRoot } from "../core/paths.js";
import { trail } from "./trail.js";
import { init } from "./init.js";
import { banner, step, panel, ask, askStep, spinner, dimText, silently } from "../util/tui.js";

interface CommandOptions {
  json: boolean;
  profile?: string | undefined;
}

/**
 * The first thing a new user should run. It replaces eight commands, none of
 * which were discoverable, and it verifies each step instead of assuming it
 * worked: a step that cannot prove itself says so.
 */
export async function setup(
  _args: string[],
  opts: CommandOptions
): Promise<number> {
  console.log(banner());
  console.log();
  console.log(`  ${dimText("Claude Code usage without the cache tax")}`);
  console.log();

  if (!isatty(stdout.fd)) {
    console.log("  Not a terminal, so there is nothing to guide. Run these:");
    console.log();
    console.log("    lodestone init");
    console.log("    lodestone init --statusline");
    console.log("    lodestone config set realUsage on");
    console.log("    lodestone doctor");
    console.log();
    return 0;
  }

  // ── What we found ────────────────────────────────────────────────────────
  const claudeBin = claudePath();
  const rawVersion = versionOf(claudeBin);
  if (!rawVersion) {
    console.log(step("fail", "Claude Code", "not found on your PATH"));
    console.log();
    console.log("  Lodestone works alongside Claude Code, so install that first:");
    console.log(`  ${dimText("https://claude.com/claude-code")}`);
    console.log();
    return 1;
  }
  const version = (rawVersion.match(/\d+\.\d+\.\d+/) ?? [rawVersion])[0] as string;
  console.log(step("done", "Claude Code", version));

  adoptDefault();
  const config = loadConfig();
  const profiles = Object.entries(config.profiles);
  const first = profiles[0];
  if (!first) {
    console.log(step("fail", "Your account", "no Claude config directory found"));
    return 1;
  }
  const [profileName, profileCfg] = first;
  const configDir = expandTilde(profileCfg.configDir);
  const hint = loggedInHint({ name: profileName, configDir });
  const accountEmail = hint === "not logged in" ? "" : (hint.split(" (")[0] ?? hint);
  console.log(
    accountEmail
      ? step("done", "Your account", accountEmail)
      : step("warn", "Your account", "not logged in, run: claude /login")
  );

  // ── What we can set up ───────────────────────────────────────────────────
  let hooksInstalled = false;
  let statuslineInstalled = false;
  let realUsageDetail = "";
  let secondAccount = "";
  let trailInstalled = false;

  if (
    await askStep(
      "Hooks",
      "They load your handoff into a fresh session, bank a free snapshot when one ends,\n  and warn you before a limit lands. Written to your Claude settings, backed up first.",
      "Install them?",
      true
    )
  ) {
    await silently(() => init([], opts));
    // Trust nothing: read the settings back and confirm our hooks are in them.
    hooksInstalled = profiles.every(([, cfg]) => {
      const settings = join(expandTilde(cfg.configDir), "settings.json");
      try {
        return existsSync(settings) && readFileSync(settings, "utf8").includes("lodestone hook");
      } catch {
        return false;
      }
    });
    console.log(
      hooksInstalled
        ? step("done", "Hooks", "installed")
        : step("fail", "Hooks", "could not write to settings.json")
    );
  } else {
    console.log(step("todo", "Hooks", "skipped"));
  }

  if (
    await askStep(
      "Status line",
      "Live usage, the cache countdown, and what a switch would cost right now,\n  inside every Claude Code session.",
      "Add it?",
      true
    )
  ) {
    await silently(() => init(["--statusline"], opts));
    statuslineInstalled = profiles.every(([, cfg]) => {
      const settings = join(expandTilde(cfg.configDir), "settings.json");
      try {
        return existsSync(settings) && readFileSync(settings, "utf8").includes("statusLine");
      } catch {
        return false;
      }
    });
    console.log(
      statuslineInstalled
        ? step("done", "Status line", "installed")
        : step("fail", "Status line", "could not write to settings.json")
    );
  } else {
    console.log(step("todo", "Status line", "skipped"));
  }

  if (
    await askStep(
      "Real usage",
      "Reads your own token locally to fetch your true quota. Nothing is stored, and\n  nothing is sent anywhere except Anthropic. Without it, numbers are estimates.",
      "Enable it?",
      true
    )
  ) {
    const cfg = loadConfig();
    cfg.settings.realUsage = true;
    saveConfig(cfg);

    // Prove it works, right now, rather than claiming it does.
    const spin = spinner("  Fetching your quota");
    const quota = await getQuota(configDir, version, true);
    if (quota.source !== "estimate" && quota.fiveHourUtilization !== undefined) {
      realUsageDetail = `5h ${Math.round(quota.fiveHourUtilization)}%, weekly ${Math.round(quota.sevenDayUtilization ?? 0)}%`;
      spin.stop("done", "");
      console.log(step("done", "Real usage", realUsageDetail));
    } else {
      spin.stop("warn", "");
      console.log(step("warn", "Real usage", "on, but the live fetch failed. Estimates will be used"));
    }
  } else {
    console.log(step("todo", "Real usage", "skipped"));
  }

  if (
    await askStep(
      "Second account",
      "A separate Claude login with its own history and its own limits.\n  This is how you keep working when one account runs dry.",
      "Add one now?",
      false
    )
  ) {
    const name = (await ask("  Name it", "work")).trim() || "work";
    try {
      addProfile(name, {});
      secondAccount = name;
      console.log(step("done", "Second account", name));
    } catch (err) {
      console.log(
        step("fail", "Second account", err instanceof Error ? err.message : "could not create")
      );
    }
  } else {
    console.log(step("todo", "Second account", "skipped"));
  }

  if (
    await askStep(
      "Trail mode",
      "Claude keeps a running notes file, so a limit landing mid-task never catches you\n  empty handed. It costs 10 to 40k weighted tokens per session, so it is off by default.",
      "Turn it on for this project?",
      false
    )
  ) {
    await silently(() => trail(["on"], { json: false }));
    trailInstalled = existsSync(
      join(findProjectRoot(process.cwd()), ".claude", "rules", "lodestone-trail.md")
    );
    console.log(
      trailInstalled
        ? step("done", "Trail mode", "on for this project")
        : step("fail", "Trail mode", "could not write the rules file")
    );
  } else {
    console.log(step("todo", "Trail mode", "skipped"));
  }

  // ── The one thing we cannot do for them ──────────────────────────────────
  console.log();
  console.log(
    panel("One thing left", [
      "Restart your Claude Code session.",
      "The status line and hooks load when a session starts.",
    ])
  );
  console.log();
  console.log(`  ${dimText("lodestone status")}    where you stand right now`);
  console.log(`  ${dimText("/handoff")}            inside a session, before you switch`);
  console.log(`  ${dimText("lodestone doctor")}    if anything looks wrong`);
  if (secondAccount) {
    console.log();
    console.log(`  Log in to it:  ${dimText(`lodestone login ${secondAccount}`)}`);
  }
  console.log();

  return 0;
}
