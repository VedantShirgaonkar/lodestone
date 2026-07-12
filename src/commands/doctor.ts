import { parseArgs } from "node:util";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../core/config.js";
import { claudePath, versionOf } from "../core/claudeCli.js";
import { expandTilde, handoffDirFor, findProjectRoot } from "../core/paths.js";
import { parseSession, latestSession } from "../core/transcript.js";
import { adoptDefault } from "../core/profiles.js";

interface CommandOptions {
  json: boolean;
  profile?: string | undefined;
}

interface DoctorCheck {
  name: string;
  status: "ok" | "FAIL";
  message: string;
}

export async function doctor(
  args: string[],
  _opts: CommandOptions
): Promise<number> {
  try {
    const { values: _parsedOpts } = parseArgs({
      args,
      options: {},
      allowPositionals: false,
      strict: true,
    });

    const checks: DoctorCheck[] = [];
    let hasFailure = false;

    // 1. Check claude binary
    const claudeBin: string = claudePath();
    const version = versionOf(claudeBin);
    if (!version) {
      checks.push({
        name: "claude binary",
        status: "FAIL",
        message: `claude not found at ${claudeBin}`,
      });
      hasFailure = true;
    } else {
      // Check version >= 2.0.0
      const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
      if (match && match[1]) {
        const major = parseInt(match[1], 10);
        if (major < 2) {
          checks.push({
            name: "claude version",
            status: "FAIL",
            message: `claude version ${version} is < 2.0.0`,
          });
          hasFailure = true;
        } else {
          checks.push({
            name: "claude binary",
            status: "ok",
            message: `${claudeBin} version ${version}`,
          });
        }
      } else {
        checks.push({
          name: "claude binary",
          status: "ok",
          message: `${claudeBin} (version: ${version})`,
        });
      }
    }

    // 2. Check config
    try {
      const config = loadConfig();
      adoptDefault();

      if (Object.keys(config.profiles).length === 0) {
        checks.push({
          name: "warmswap config",
          status: "FAIL",
          message: "no profiles registered",
        });
        hasFailure = true;
      } else {
        checks.push({
          name: "warmswap config",
          status: "ok",
          message: `${Object.keys(config.profiles).length} profile(s)`,
        });

        // 3. Check each profile
        for (const [name, profileCfg] of Object.entries(config.profiles)) {
          const configDir = expandTilde(profileCfg.configDir);

          if (!existsSync(configDir)) {
            checks.push({
              name: `profile dir (${name})`,
              status: "FAIL",
              message: `${configDir} does not exist`,
            });
            hasFailure = true;
          } else {
            checks.push({
              name: `profile dir (${name})`,
              status: "ok",
              message: configDir,
            });

            // Check login hint
            const { loggedInHint } = await import("../core/profiles.js");
            const profileInfo = {
              name,
              configDir,
              label: profileCfg.label,
            };
            const hint = loggedInHint(profileInfo);

            if (hint === "not logged in") {
              checks.push({
                name: `login (${name})`,
                status: "FAIL",
                message: `run: warmswap login ${name}`,
              });
              hasFailure = true;
            } else {
              checks.push({
                name: `login (${name})`,
                status: "ok",
                message: hint,
              });
            }
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      checks.push({
        name: "warmswap config",
        status: "FAIL",
        message: `parse error: ${msg}`,
      });
      hasFailure = true;
    }

    // 4. Check handoff dir writability (if in a project)
    try {
      const projectRoot = findProjectRoot(process.cwd());
      const handoffDir = handoffDirFor(projectRoot);
      const testFile = join(handoffDir, ".warmswap-test");

      try {
        // Create directory if needed
        const { mkdirSync } = await import("node:fs");
        mkdirSync(handoffDir, { recursive: true });

        // Try to write a test file
        writeFileSync(testFile, "test", "utf8");
        unlinkSync(testFile);

        checks.push({
          name: "handoff dir writability",
          status: "ok",
          message: handoffDir,
        });
      } catch {
        checks.push({
          name: "handoff dir writability",
          status: "FAIL",
          message: `cannot write to ${handoffDir}`,
        });
        hasFailure = true;
      }
    } catch {
      // Not in a project, skip this check
    }

    // 5. Check newest session parses (if any)
    try {
      const config = loadConfig();
      const profiles = Object.entries(config.profiles);

      for (const [name, profileCfg] of profiles) {
        const configDir = expandTilde(profileCfg.configDir);
        const sessionPath = latestSession(configDir, process.cwd());

        if (sessionPath) {
          try {
            const parsed = await parseSession(sessionPath);
            const errorPct =
              parsed.parseErrors.length === 0 || parsed.lineCount === 0
                ? 0
                : (parsed.parseErrors.length / parsed.lineCount) * 100;

            if (parsed.parseErrors.length > 0 && errorPct > 5) {
              checks.push({
                name: `session parse (${name})`,
                status: "FAIL",
                message: `${parsed.parseErrors.length} parse errors (>${errorPct}%)`,
              });
              hasFailure = true;
            } else if (parsed.parseErrors.length > 0) {
              checks.push({
                name: `session parse (${name})`,
                status: "ok",
                message: `${parsed.parseErrors.length} minor parse errors (tolerated)`,
              });
            } else {
              checks.push({
                name: `session parse (${name})`,
                status: "ok",
                message: "no errors",
              });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            checks.push({
              name: `session parse (${name})`,
              status: "FAIL",
              message: msg,
            });
            hasFailure = true;
          }
        }
      }
    } catch {
      // Skip session checks on error
    }

    // 6. Hooks status (Phase 3 feature)
    checks.push({
      name: "hooks",
      status: "ok",
      message: "not installed (Phase 3 feature)",
    });

    // Output
    for (const check of checks) {
      const statusStr =
        check.status === "ok"
          ? `ok`
          : `FAIL`;
      console.log(`${statusStr}: ${check.name} — ${check.message}`);
    }

    return hasFailure ? 1 : 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`warmswap doctor: ${msg}`);
    return 1;
  }
}
