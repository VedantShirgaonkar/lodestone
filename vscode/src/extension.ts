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
  StatusModel,
} from "./model.js";
import { locateCli, runJson, clearCache } from "./cli.js";

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
    runJson("status");
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
    const auditJson = runJson("audit");
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
 * Handle the main menu QuickPick.
 */
async function handleMenu() {
  const actions = [
    { label: "Handoff & Switch Account…", value: "handoff" },
    { label: "Refresh In Place…", value: "refresh-in-place" },
    { label: "Trail Mode: toggle", value: "trail-toggle" },
    { label: "Keep Current Account Warm…", value: "keepWarm" },
    { label: "Open Dashboard (terminal)", value: "dash" },
    { label: "Refresh Status", value: "refresh" },
    { label: "Enable real usage data", value: "realUsage" },
  ];

  const picked = await vscode.window.showQuickPick(actions, {
    placeHolder: "lodestone actions",
  });

  if (!picked) return;

  switch (picked.value) {
    case "handoff":
      return handleHandoffSwitch();
    case "refresh-in-place":
      return runInTerminal("lodestone refresh");
    case "trail-toggle":
      return handleTrailToggle();
    case "keepWarm":
      return handleKeepWarm();
    case "dash":
      return handleOpenDash();
    case "refresh":
      return updateStatus();
    case "realUsage":
      return runInTerminal("lodestone config set realUsage on");
  }
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
 * Handle trail mode toggle: check current state and toggle.
 */
async function handleTrailToggle() {
  try {
    const statusJson = runJson("trail", ["status"]);
    if (!statusJson) {
      vscode.window.showErrorMessage("Failed to check trail status");
      return;
    }

    const status = JSON.parse(statusJson);
    const installed = status.installed ?? false;

    const command = installed ? "lodestone trail off" : "lodestone trail on";
    runInTerminal(command);
  } catch {
    vscode.window.showErrorMessage("Failed to toggle trail mode");
  }
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
