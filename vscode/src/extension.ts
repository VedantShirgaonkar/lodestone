import * as vscode from "vscode";
import { watch } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  loadRegistry,
  loadProfileQuota,
  cacheWarmth,
  buildStatusText,
  buildTooltipMarkdown,
  parseAuditTotals,
  expiryToastDecisions,
  listRunningKeepalives,
  StatusModel,
} from "./model.js";
import { locateCli, runJson, clearCache } from "./cli.js";

/** The workspace the user is looking at; per-project CLI calls run here. */
function workspaceCwd(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function configHome(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

let statusBarItem: vscode.StatusBarItem;
let refreshInterval: NodeJS.Timeout | null = null;
// node:fs watchers expose close(), not vscode's dispose()
const watchers: Array<{ close(): void }> = [];
// Track which cache expiry toasts we've already shown (to avoid duplicate per warm-period)
const toastedKeys: Set<string> = new Set();

/**
 * Extension activation: create statusbar, set up watchers, register commands.
 */
export async function activate(context: vscode.ExtensionContext) {
  // Create status bar item (right side, priority 100)
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.name = "lodestone";
  statusBarItem.command = "lodestone.menu";
  context.subscriptions.push(statusBarItem);

  // Initial refresh
  await updateStatus();

  // Set up fs.watch on each profile's usage-cache.json
  const registry = loadRegistry();
  for (const profile of registry.profiles) {
    const cacheFile = join(profile.configDir, "lodestone", "usage-cache.json");
    try {
      const watcher = watch(cacheFile, () => {
        // fs.watch fires multiple times; debounce with a small delay
        clearTimeout((globalThis as any).lodestoneWatchDebounce);
        (globalThis as any).lodestoneWatchDebounce = setTimeout(
          () => updateStatus(),
          100
        );
      });
      watchers.push(watcher);
    } catch {
      // Tolerate missing dirs
    }
  }

  // Set up 30s interval fallback refresh
  refreshInterval = setInterval(() => {
    updateStatus();
  }, 30 * 1000);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("lodestone.menu", () => handleMenu())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("lodestone.handoffSwitch", () =>
      handleHandoffSwitch()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("lodestone.keepWarm", () =>
      handleKeepWarm()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("lodestone.openDash", () =>
      handleOpenDash()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("lodestone.refresh", () => updateStatus())
  );
}

/**
 * Extension deactivation: clean up watchers and timers.
 */
export function deactivate() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
  for (const watcher of watchers) {
    try {
      watcher.close();
    } catch {
      // already closed
    }
  }
}

/**
 * Update the status bar and tooltip.
 */
async function updateStatus() {
  try {
    const model = await buildStatusModel();
    const statusText = buildStatusText(model);
    const tooltipMd = buildTooltipMarkdown(model);

    statusBarItem.text = statusText;
    statusBarItem.tooltip = new vscode.MarkdownString(tooltipMd, true);
    statusBarItem.tooltip.isTrusted = true;
    statusBarItem.tooltip.supportThemeIcons = true;

    // Set warning background if any profile crosses thresholds
    const advisorThresholds = model.advisorThresholds;
    let isWarning = false;
    for (const quota of model.profiles.values()) {
      if (quota.source === "none") continue;
      if (
        quota.fiveHourPct !== undefined &&
        quota.fiveHourPct >= advisorThresholds.fiveHourPct
      ) {
        isWarning = true;
        break;
      }
      if (
        quota.sevenDayPct !== undefined &&
        quota.sevenDayPct >= advisorThresholds.weeklyPct
      ) {
        isWarning = true;
        break;
      }
    }

    if (isWarning) {
      statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
    } else {
      statusBarItem.backgroundColor = undefined;
    }

    statusBarItem.show();

    // Check for expiry toasts
    const expiryToastMinutes =
      vscode.workspace
        .getConfiguration("lodestone")
        .get<number>("expiryToastMinutes") ?? 0;
    if (expiryToastMinutes > 0) {
      const toastDecisions = expiryToastDecisions(
        model.cacheWarmth,
        expiryToastMinutes,
        toastedKeys
      );
      for (const decision of toastDecisions) {
        showExpiryToast(decision.folder, decision.minutesRemaining);
      }
    }
  } catch (err) {
    // Graceful degradation
    statusBarItem.text = "$(error) lodestone error";
    statusBarItem.show();
  }
}

/**
 * Build the status model from current state.
 */
async function buildStatusModel(): Promise<StatusModel> {
  const registry = loadRegistry();
  const configHome =
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config");

  const profiles = new Map();
  const profileLabels = new Map();
  const advisorThresholds = {
    fiveHourPct: registry.settings?.advisor?.fiveHourPct ?? 85,
    weeklyPct: registry.settings?.advisor?.weeklyPct ?? 90,
  };

  // Refresh the usage bridge by calling status --json
  // This forces the CLI to fetch live data when it is stale and realUsage is on
  try {
    runJson("status", [], { cwd: workspaceCwd() ?? undefined });
  } catch {
    // Silent fail
  }

  // Load quota for each profile
  for (const profile of registry.profiles) {
    const quota = loadProfileQuota(profile.configDir);
    profiles.set(profile.name, quota);
    profileLabels.set(profile.name, profile.label);
  }

  // Load cache warmth for workspace folders. Transcripts live under each
  // PROFILE's config dir (<configDir>/projects/...), not under ~/.config —
  // check every profile and keep the warmest hit per folder.
  const cacheWarmthMap = new Map();
  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  for (const folder of workspaceFolders) {
    let best: ReturnType<typeof cacheWarmth> = null;
    for (const profile of registry.profiles) {
      const warmth = cacheWarmth(profile.configDir, folder.uri.fsPath);
      if (!warmth) continue;
      const minutes =
        typeof warmth.minutesRemaining === "number"
          ? warmth.minutesRemaining
          : -1;
      const bestMinutes =
        best && typeof best.minutesRemaining === "number"
          ? best.minutesRemaining
          : -1;
      if (minutes > bestMinutes || best === null) {
        best = warmth;
      }
    }
    if (best) {
      cacheWarmthMap.set(folder.uri.fsPath, best);
    }
  }

  // Load audit totals
  let auditTotals: { totalEvents: number; totalEstimatedSaved: number } | undefined =
    undefined;
  try {
    const auditJson = runJson("audit", [], { cwd: workspaceCwd() ?? undefined });
    if (auditJson) {
      auditTotals = parseAuditTotals(auditJson);
    }
  } catch {
    // Silent fail
  }

  return {
    profiles,
    profileLabels,
    cacheWarmth: cacheWarmthMap,
    auditTotals,
    advisorThresholds,
  };
}

/**
 * Handle the main menu QuickPick. Labels state the action that will actually
 * happen: "turn off" when a thing is on, "stop" when a scheduler runs.
 */
async function handleMenu() {
  const registry = loadRegistry();
  const trailInstalled = readTrailInstalled();
  const running = listRunningKeepalives(configHome());
  const realUsageOn = registry.settings?.realUsage === true;

  const actions: Array<{ label: string; value: string }> = [
    { label: "Handoff & Switch Account…", value: "handoff" },
    { label: "Refresh In Place…", value: "refresh-in-place" },
    {
      label:
        trailInstalled === undefined
          ? "Trail Mode: toggle"
          : trailInstalled
            ? "Trail Mode: turn off"
            : "Trail Mode: turn on",
      value: "trail-toggle",
    },
    { label: "Keep Current Account Warm…", value: "keepWarm" },
  ];
  for (const ka of running) {
    actions.push({
      label: `Keep Warm: stop (${ka.profile}, ${ka.pings}/${ka.cap} pings sent)`,
      value: `keepWarm-stop:${ka.profile}`,
    });
  }
  actions.push(
    { label: "Open Dashboard (terminal)", value: "dash" },
    { label: "Refresh Status", value: "refresh" },
    {
      label: realUsageOn ? "Disable real usage data" : "Enable real usage data",
      value: "realUsage",
    }
  );

  const picked = await vscode.window.showQuickPick(actions, {
    placeHolder: "lodestone actions",
  });

  if (!picked) return;

  if (picked.value.startsWith("keepWarm-stop:")) {
    return handleKeepWarmStop(picked.value.slice("keepWarm-stop:".length));
  }

  switch (picked.value) {
    case "handoff":
      return handleHandoffSwitch();
    case "refresh-in-place":
      return handleRefreshInPlace();
    case "trail-toggle":
      return handleTrailToggle();
    case "keepWarm":
      return handleKeepWarm();
    case "dash":
      return handleOpenDash();
    case "refresh":
      return updateStatus();
    case "realUsage":
      return handleRealUsageToggle(realUsageOn);
  }
}

/** Trail state for the current workspace; undefined when it cannot be read. */
function readTrailInstalled(): boolean | undefined {
  try {
    const cwd = workspaceCwd();
    if (!cwd) return undefined;
    const statusJson = runJson("trail", ["status"], { cwd, fresh: true });
    if (!statusJson) return undefined;
    return (JSON.parse(statusJson) as { installed?: boolean }).installed ?? false;
  } catch {
    return undefined;
  }
}

/**
 * Refresh in place, inside the editor: save the handoff in the background,
 * then start a new conversation in the Claude Code panel, whose session-start
 * hook loads the handoff on its own. Falls back to the terminal when the
 * Claude Code extension is not installed to receive the command.
 */
async function handleRefreshInPlace() {
  const cwd = workspaceCwd();
  if (!cwd) {
    vscode.window.showErrorMessage("lodestone: open a folder first");
    return;
  }

  const out = runJson("refresh", [], { cwd, fresh: true });
  if (!out) {
    vscode.window.showErrorMessage(
      "lodestone: refresh failed — is there a Claude session for this project?"
    );
    return;
  }

  try {
    await vscode.commands.executeCommand("claude-vscode.newConversation");
    vscode.window.showInformationMessage(
      "lodestone: handoff saved — new conversation started, it loads automatically"
    );
  } catch {
    vscode.window.showInformationMessage(
      "lodestone: handoff saved — type /clear in Claude Code and it loads automatically"
    );
  }
  updateStatus();
}

async function handleKeepWarmStop(profile: string) {
  if (!isSafeToken(profile)) return;
  const out = runJson("keepalive", ["--stop", profile], { fresh: true });
  vscode.window.showInformationMessage(
    out !== undefined
      ? `lodestone: keepalive stopped for ${profile}`
      : `lodestone: could not stop keepalive for ${profile}`
  );
  updateStatus();
}

async function handleRealUsageToggle(currentlyOn: boolean) {
  const target = currentlyOn ? "off" : "on";
  const out = runJson("config", ["set", "realUsage", target], { fresh: true });
  vscode.window.showInformationMessage(
    out !== undefined
      ? `lodestone: real usage data ${target}`
      : "lodestone: could not update realUsage"
  );
  clearCache();
  updateStatus();
}

/**
 * Handle handoff & switch: pick target profile, run switch command.
 */
async function handleHandoffSwitch() {
  const registry = loadRegistry();
  if (registry.profiles.length === 0) {
    vscode.window.showErrorMessage("No lodestone profiles configured");
    return;
  }

  const targets = registry.profiles.map((p) => ({
    label: p.label ? `${p.name} (${p.label})` : p.name,
    value: p.name,
  }));

  const target = await vscode.window.showQuickPick(targets, {
    placeHolder: "Select target profile",
  });

  if (!target) return;

  if (!isSafeToken(target.value)) return;
  runInTerminal(`lodestone switch ${target.value}`);
}

/**
 * Handle trail mode toggle: check current state IN THE WORKSPACE and flip it.
 * The status check used to run without a cwd, so it was answered for the
 * extension host's own directory — never the workspace — and always said
 * "not installed", which made this toggle a one-way switch to on.
 */
async function handleTrailToggle() {
  const cwd = workspaceCwd();
  if (!cwd) {
    vscode.window.showErrorMessage("lodestone: open a folder first");
    return;
  }

  const installed = readTrailInstalled();
  if (installed === undefined) {
    vscode.window.showErrorMessage("lodestone: failed to check trail status");
    return;
  }

  const out = runJson("trail", [installed ? "off" : "on"], { cwd, fresh: true });
  if (out === undefined) {
    vscode.window.showErrorMessage("lodestone: failed to toggle trail mode");
    return;
  }
  vscode.window.showInformationMessage(
    installed
      ? "lodestone: trail mode off"
      : "lodestone: trail mode on for this project (costs tokens while Claude keeps notes)"
  );
}

/**
 * Handle keep warm: ask for duration, run keepalive command.
 */
async function handleKeepWarm() {
  const registry = loadRegistry();
  if (registry.profiles.length === 0) {
    vscode.window.showErrorMessage("No lodestone profiles configured");
    return;
  }

  const choices = registry.profiles.map((p) => ({
    label: p.label ? `${p.name} (${p.label})` : p.name,
    value: p.name,
  }));
  const picked = await vscode.window.showQuickPick(choices, {
    placeHolder: "Which profile's cache should stay warm?",
  });
  if (!picked) return;

  const duration = await vscode.window.showInputBox({
    prompt: "Keep warm for how long? (e.g., 90m, 2h)",
    value: "90m",
    validateInput: (v) =>
      DURATION_RE.test(v.trim()) ? undefined : "Use a duration like 90m or 2h",
  });

  if (!duration || !DURATION_RE.test(duration.trim())) return;
  if (!isSafeToken(picked.value)) return;

  runInTerminal(`lodestone keepalive ${picked.value} --for ${duration.trim()}`);
}

/**
 * Handle open dashboard.
 */
async function handleOpenDash() {
  runInTerminal("lodestone dash");
}

/**
 * Show an expiry toast for a project's cache approaching expiration.
 */
async function showExpiryToast(
  folderName: string,
  minutesRemaining: number
) {
  const message = `lodestone: cache for ${folderName} expires in ~${minutesRemaining}m`;
  const choice = await vscode.window.showWarningMessage(
    message,
    "Keep warm",
    "Dismiss"
  );

  if (choice === "Keep warm") {
    // Show the keep warm handler
    await handleKeepWarm();
  }
  // "Dismiss" does nothing; the toast is gone
}

/**
 * Anything interpolated into a terminal command must match these first:
 * a profile name or a duration, nothing that a shell could reinterpret.
 * Without this, a duration typed as `90m; rm -rf ~` would be executed.
 */
const DURATION_RE = /^\d{1,4}[mh]$/;
const TOKEN_RE = /^[A-Za-z0-9._-]{1,64}$/;

function isSafeToken(value: string): boolean {
  return TOKEN_RE.test(value);
}

/**
 * Run a command in the integrated terminal (visible to user).
 */
function runInTerminal(command: string) {
  const terminal =
    vscode.window.terminals.find((t) => t.name === "lodestone") ||
    vscode.window.createTerminal("lodestone");

  terminal.show();
  terminal.sendText(command);
}
