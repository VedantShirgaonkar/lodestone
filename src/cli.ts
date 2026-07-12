import { stderr } from "node:process";
import { pathToFileURL } from "node:url";
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

const VERSION = "0.1.0";

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
      console.log(`cchandoff ${VERSION}`);
      return 0;
    }

    // Handle global --help
    if (globalOpts.help && !command) {
      printGlobalHelp();
      return 0;
    }

    // No command given
    if (!command) {
      printGlobalHelp();
      return 2;
    }

    // Shared flags (--json, --profile <name>) may appear after the command too:
    // strip them for cchandoff's own workflow commands. launch/login/bare-launch
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
        // Check if it's a bare-launch profile name (not a command)
        if (!COMMAND_NAMES.has(command)) {
          return await launch([command, ...commandArgs], cmdOpts);
        }

        printError(`Unknown command: ${command}`);
        return 2;
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);
    printError(message);
    if (process.env.CCHANDOFF_DEBUG) {
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
  console.log(`cchandoff — switch Claude Code accounts with measured context handoffs

Usage: cchandoff [--version] [--help] [--json] [--profile <name>] <command> [options]

Global options:
  --version            Show version
  --help               Show this help
  --json               Machine output
  --profile <name>     Override current profile

Commands:
  profile              Manage profiles
  launch               Launch Claude on a profile
  login                Authenticate a profile
  snapshot             Snapshot current session to handoff file
  handoff              Snapshot + optional distillation
  switch               Switch to a profile with handoff
  status               Show profile burn and session status
  doctor               Diagnose setup issues
  dash                 Live TUI dashboard
  keepalive            Keep session warm with TTL refresh pings
  audit                Analyze handoff and switch events
  init                 Initialize hooks and config

Internal:
  hook                 (internal: session lifecycle hooks)
  statusline           (internal: status line renderer)

help                   Show command help`);
}

function printCommandHelp(command: string): void {
  const helps: Record<string, string> = {
    profile: `cchandoff profile — manage profiles

Usage: cchandoff profile <subcommand>

Subcommands:
  add <name>           Create profile
  list                 List profiles (★ = current)
  remove <name>        Unregister profile (does not delete dir)
  rename <old> <new>   Rename profile`,

    launch: `cchandoff launch — launch Claude on a profile

Usage: cchandoff launch <profile> [-- [claude args]]`,

    login: `cchandoff login — authenticate a profile

Usage: cchandoff login <profile>`,

    snapshot: `cchandoff snapshot — capture current session as handoff file

Usage: cchandoff snapshot [--session <id>] [--out <path>] [--quiet]`,

    handoff: `cchandoff handoff — snapshot + optional distillation

Usage: cchandoff handoff [--distill] [--force] [--session <id>]`,

    switch: `cchandoff switch — switch to a profile with handoff

Usage: cchandoff switch <profile> [--distill] [--stay]`,

    status: `cchandoff status — show profile burn and session status

Usage: cchandoff status [--json]`,

    doctor: `cchandoff doctor — diagnose setup issues

Usage: cchandoff doctor`,

    dash: `cchandoff dash — live TUI dashboard

Usage: cchandoff dash [--once]

Options:
  --once               Render one frame and exit (for testing)`,

    keepalive: `cchandoff keepalive — keep session warm with TTL refresh pings

Usage: cchandoff keepalive <profile> [--for <duration>] [--max-pings <n>]
       cchandoff keepalive --stop [<profile>]
       cchandoff keepalive --status

Options:
  --for <duration>     Duration (e.g. 90m, 2h) — default 90m
  --max-pings <n>      Max pings to send — default 3
  --stop [<profile>]   Stop keepalive (all if no profile)
  --status             Show active keepalive schedulers`,

    audit: `cchandoff audit — analyze handoff and switch events

Usage: cchandoff audit [--since <duration>] [--json]

Options:
  --since <duration>   Look back (e.g. 7d, 24h) — default 7d
  --json               Machine output`,
  };

  console.log(helps[command] || `Unknown command: ${command}`);
}

function printError(message: string): void {
  stderr.write(`cchandoff: ${message}\n`);
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
