import { stderr } from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { profile } from "./commands/profile.js";
import { launch } from "./commands/launch.js";
import { login } from "./commands/login.js";
import { snapshot } from "./commands/snapshot.js";
import { handoff } from "./commands/handoff.js";
import { switchCmd } from "./commands/switch.js";
import { status } from "./commands/status.js";
import { doctor } from "./commands/doctor.js";
import { hook } from "./commands/hook.js";
import { statusline } from "./commands/statusline.js";
import { init } from "./commands/init.js";
import { config } from "./commands/config.js";
import { dash } from "./commands/dash.js";
import { keepalive } from "./commands/keepalive.js";
import { audit } from "./commands/audit.js";
import { trail } from "./commands/trail.js";
import { refresh } from "./commands/refresh.js";
import { setup } from "./commands/setup.js";

/**
 * Read the version from package.json rather than repeating it here. The
 * hardcoded constant silently drifted: 0.2.0 shipped announcing itself as
 * 0.1.0. Walk up from the compiled file so this works from dist/ and from the
 * test build alike.
 */
const VERSION = ((): string => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === "lodestone-cli" && pkg.version) return pkg.version;
      } catch {
        // keep walking
      }
    }
    dir = dirname(dir);
  }
  return "unknown";
})();

const COMMAND_NAMES = new Set([
  "profile",
  "launch",
  "login",
  "snapshot",
  "handoff",
  "switch",
  "status",
  "doctor",
  "hook",
  "statusline",
  "init",
  "config",
  "dash",
  "keepalive",
  "audit",
  "trail",
  "refresh",
  "setup",
  "help",
]);

interface GlobalOptions {
  json?: boolean | undefined;
  profile?: string | undefined;
  version?: boolean | undefined;
  help?: boolean | undefined;
}

export async function main(argv: string[]): Promise<number> {
  try {
    // Parse global options strictly: only consume flags before the first non-flag token (command).
    // This allows subcommands to receive their own flags unmolested.
    const { globalOpts, command, commandArgs } = parseGlobalArgs(argv);

    // Handle global --version
    if (globalOpts.version) {
      console.log(`lodestone ${VERSION}`);
      return 0;
    }

    // Handle global --help
    if (globalOpts.help && !command) {
      printGlobalHelp();
      return 0;
    }

    // No command given
    if (!command) {
      // Check if config file exists; if not, suggest setup
      const { existsSync } = await import("node:fs");
      const { lodestoneConfigPath } = await import("./core/paths.js");
      if (!existsSync(lodestoneConfigPath())) {
        console.log("Getting started? Run: lodestone setup\n");
      }
      printGlobalHelp();
      return 2;
    }

    // Shared flags (--json, --profile <name>) may appear after the command too:
    // strip them for lodestone's own workflow commands. launch/login/bare-launch
    // are exempt — everything after the profile name belongs to claude verbatim.
    const isPassthrough =
      command === "launch" || command === "login" || !COMMAND_NAMES.has(command);
    let json = globalOpts.json ?? false;
    let profileFlag = globalOpts.profile;
    let effectiveArgs = commandArgs;
    if (!isPassthrough) {
      const kept: string[] = [];
      for (let i = 0; i < commandArgs.length; i++) {
        const tok = commandArgs[i];
        if (tok === "--json") {
          json = true;
        } else if (tok === "--profile" && commandArgs[i + 1] !== undefined) {
          profileFlag = commandArgs[i + 1];
          i++;
        } else if (tok !== undefined) {
          kept.push(tok);
        }
      }
      effectiveArgs = kept;
    }

    // Route to command handler
    const cmdOpts: { json: boolean; profile?: string } = {
      json,
    };
    if (profileFlag !== undefined) {
      cmdOpts.profile = profileFlag;
    }
    const commandArgs2 = effectiveArgs;

    switch (command) {
      case "profile":
        return await profile(commandArgs2, cmdOpts);

      case "launch":
        return await launch(commandArgs, cmdOpts);

      case "login":
        return await login(commandArgs, cmdOpts);

      case "snapshot":
        return await snapshot(commandArgs2, cmdOpts);

      case "handoff":
        return await handoff(commandArgs2, cmdOpts);

      case "switch":
        return await switchCmd(commandArgs2, cmdOpts);

      case "status":
        return await status(commandArgs2, cmdOpts);

      case "doctor":
        return await doctor(commandArgs2, cmdOpts);

      case "hook":
        return await hook(commandArgs2);

      case "statusline":
        return await statusline();

      case "init":
        return await init(commandArgs2, cmdOpts);

      case "config":
        return await config(commandArgs2, cmdOpts);

      case "dash":
        return await dash(commandArgs2, cmdOpts);

      case "keepalive":
        return await keepalive(commandArgs2, cmdOpts);

      case "audit":
        return await audit(commandArgs2, cmdOpts);

      case "trail":
        return await trail(commandArgs2, cmdOpts);

      case "refresh":
        return await refresh(commandArgs2, cmdOpts);

      case "setup":
        return await setup(commandArgs2, cmdOpts);

      case "help": {
        const helpCmd = commandArgs2[0];
        if (helpCmd) {
          printCommandHelp(helpCmd);
        } else {
          printGlobalHelp();
        }
        return 0;
      }

      default:
        // A bare token can be a profile name (`lodestone work` launches
        // Claude on the work profile) — but only check that AFTER ruling out
        // a typo'd command, or `lodestone stauts` answers with the launcher's
        // baffling "profile not found: stauts".
        if (!COMMAND_NAMES.has(command)) {
          const { loadConfig } = await import("./core/config.js");
          try {
            const cfg = loadConfig();
            if (cfg.profiles[command]) {
              return await launch([command, ...commandArgs], cmdOpts);
            }
          } catch {
            // fall through to the error below
          }
          printError(
            `unknown command or profile: ${command}\n` +
              `  commands:  lodestone --help\n` +
              `  profiles:  lodestone profile list`
          );
          return 2;
        }

        printError(`Unknown command: ${command}`);
        return 2;
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);
    printError(message);
    if (process.env.LODESTONE_DEBUG) {
      console.error(err);
    }
    return 1;
  }
}

/**
 * Parse only global flags that appear before the first non-flag token.
 * Everything after the command is passed to the subcommand verbatim.
 * Flags after the command name are not parsed as global flags.
 */
function parseGlobalArgs(argv: string[]): {
  globalOpts: GlobalOptions;
  command: string | undefined;
  commandArgs: string[];
} {
  let i = 0;
  const globalOpts: GlobalOptions = {};
  let command: string | undefined;
  const commandArgs: string[] = [];

  // Parse global flags until we hit the first non-flag or known command
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;

    // Check if it's a flag
    if (arg.startsWith("-")) {
      if (arg === "--json") {
        globalOpts.json = true;
      } else if (arg === "--version") {
        globalOpts.version = true;
      } else if (arg === "--help") {
        globalOpts.help = true;
      } else if (arg === "--profile" && i + 1 < argv.length) {
        globalOpts.profile = argv[++i];
      } else {
        // Unknown flag after we've found a command context or this might be a subcommand flag
        // Stop parsing globals here and treat everything from this point as subcommand args
        break;
      }
    } else {
      // Non-flag token: this is the command
      command = arg;
      i++;
      break;
    }
  }

  // Everything after the command is subcommand args
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg) {
      commandArgs.push(arg);
    }
  }

  return { globalOpts, command, commandArgs };
}

function printGlobalHelp(): void {
  console.log(`lodestone - Claude Code usage without the cache tax

Usage: lodestone [--version] [--help] [--json] [--profile <name>] <command> [options]

Global options:
  --version            Show version
  --help               Show this help
  --json               Machine output
  --profile <name>     Override current profile

Commands:
  setup                Guided first-run setup
  profile              Manage profiles
  launch               Launch Claude on a profile
  login                Authenticate a profile
  snapshot             Snapshot current session to handoff file
  handoff              Snapshot + optional distillation
  switch               Switch to a profile with handoff
  refresh              Save a handoff, then /clear to reload it in place
  trail                Keep a running notes file per project (on|off|status)
  status               Show profile burn and session status
  doctor               Diagnose setup issues
  dash                 Live TUI dashboard
  keepalive            Keep session warm with TTL refresh pings
  audit                Analyze handoff and switch events
  init                 Initialize hooks, statusline, and the /handoff skill
  config               Get or set lodestone settings

Internal:
  hook                 (internal: session lifecycle hooks)
  statusline           (internal: status line renderer)

help                   Show command help`);
}

function printCommandHelp(command: string): void {
  const helps: Record<string, string> = {
    setup: `lodestone setup — guided first-run setup

Usage: lodestone setup

Interactively configures Claude Code with:
  • Profile detection and login guidance
  • Hook installation
  • Status line configuration
  • Real usage monitoring
  • Second account setup (optional)
  • Trail mode configuration (optional)`,

    profile: `lodestone profile — manage profiles

Usage: lodestone profile <subcommand>

Subcommands:
  add <name>           Create profile
  list                 List profiles (★ = current)
  remove <name>        Unregister profile (does not delete dir)
  rename <old> <new>   Rename profile`,

    launch: `lodestone launch — launch Claude on a profile

Usage: lodestone launch <profile> [-- [claude args]]`,

    login: `lodestone login — authenticate a profile

Usage: lodestone login <profile>`,

    snapshot: `lodestone snapshot — capture current session as handoff file

Usage: lodestone snapshot [--session <id>] [--out <path>] [--quiet]`,

    handoff: `lodestone handoff — snapshot + optional distillation

Usage: lodestone handoff [--distill] [--force] [--session <id>]`,

    switch: `lodestone switch — switch to a profile with handoff

Usage: lodestone switch <profile> [--distill] [--stay] [--keep-warm <duration>]

Options:
  --distill            Distill the handoff via the model (spends tokens; prints cost first)
  --stay               Write the handoff and print costs, but do not launch Claude
  --keep-warm <dur>    Schedule cache pings on the account you are leaving (e.g. 90m)`,

    refresh: `lodestone refresh — save a handoff for a same-account context refresh

Usage: lodestone refresh [--distill]

Writes a handoff from the current session, then you type /clear in Claude Code
and the fresh session reloads it automatically.

Options:
  --distill            Distill the handoff via the model (spends tokens; prints cost first)`,

    trail: `lodestone trail — a running notes file Claude keeps current

Usage: lodestone trail on|off|status

Costs real tokens while on (Claude rewrites the notes as it works), so it is
off by default and enabled per project.`,

    init: `lodestone init — install hooks, statusline, and the /handoff skill

Usage: lodestone init [--statusline] [--project] [--force]

Options:
  --statusline         Also configure the live status line
  --project            Install into this project's .claude/ instead of profiles
  --force              Overwrite an existing statusline command`,

    config: `lodestone config — get or set lodestone settings

Usage: lodestone config get <key>
       lodestone config set <key> <value>

Keys:
  realUsage            on|off — fetch your true quota from Anthropic (opt-in)
  autoSnapshot         on|off — free snapshot at session end and pre-compact
  maxAgeDays           How old a handoff can be and still auto-load (default 7)
  advisor.fiveHourPct  Warn threshold for the 5h window (default 85)
  advisor.weeklyPct    Warn threshold for the weekly window (default 90)
  advisor.criticalPct  Bank a recovery snapshot at this 5h % (default 95)
  advisor.trailStaleMinutes  Trail staleness reminder (default 20)
  keepalive.maxWindowPct     Keepalive guardrail (default 80)
  plan                 pro|max5|max20|team`,

    status: `lodestone status — show profile burn and session status

Usage: lodestone status [--json]`,

    doctor: `lodestone doctor — diagnose setup issues

Usage: lodestone doctor`,

    dash: `lodestone dash — live TUI dashboard

Usage: lodestone dash [--once]

Options:
  --once               Render one frame and exit (for testing)`,

    keepalive: `lodestone keepalive — keep session warm with TTL refresh pings

Usage: lodestone keepalive <profile> [--for <duration>] [--max-pings <n>]
       lodestone keepalive --stop [<profile>]
       lodestone keepalive --status

Options:
  --for <duration>     Duration (e.g. 90m, 2h) — default 90m
  --max-pings <n>      Max pings to send — default 3
  --stop [<profile>]   Stop keepalive (all if no profile)
  --status             Show active keepalive schedulers`,

    audit: `lodestone audit — analyze handoff and switch events

Usage: lodestone audit [--since <duration>] [--json]

Options:
  --since <duration>   Look back (e.g. 7d, 24h) — default 7d
  --json               Machine output`,
  };

  console.log(helps[command] || `Unknown command: ${command}`);
}

function printError(message: string): void {
  stderr.write(`lodestone: ${message}\n`);
}

// Self-execute when run directly (`node dist/cli.js …`), not just via bin shim.
// Without this, direct invocation is a silent no-op — a footgun that has
// already produced misleading "it exited 0" test results twice.
const directPath = process.argv[1];
if (directPath && import.meta.url === pathToFileURL(directPath).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 0),
    (err) => {
      printError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  );
}
