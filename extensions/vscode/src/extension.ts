import * as vscode from "vscode";
import { loadConfig, loadUserDefaults, isBandWorktree } from "./config";
import { setupWorkspace } from "./workspace-setup";

let log: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel("Band");
  log.appendLine("Band extension activating...");

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("band.setupWorkspace", async () => {
      await runSetup();
    })
  );

  // Auto-setup if config exists
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders && workspaceFolders.length > 0) {
    const workspacePath = workspaceFolders[0].uri.fsPath;
    const config = await loadConfig(workspacePath);
    if (config) {
      log.appendLine("Project config loaded, setting up workspace...");
      await setupWorkspace(config);
      vscode.window.showInformationMessage("Band workspace setup complete");
    } else if (await isBandWorktree(workspacePath)) {
      log.appendLine(
        "No project config, but workspace is a Band worktree. Checking user defaults..."
      );
      const defaults = await loadUserDefaults();
      if (defaults) {
        log.appendLine("User defaults loaded, setting up workspace...");
        await setupWorkspace(defaults);
        vscode.window.showInformationMessage(
          "Band workspace setup complete (using defaults)"
        );
      } else {
        log.appendLine("No user defaults found");
      }
    } else {
      log.appendLine("No config found and not a Band worktree");
    }
  } else {
    log.appendLine("No workspace folders");
  }
}

async function runSetup() {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage("No workspace folder open");
    return;
  }

  for (const folder of workspaceFolders) {
    const config = await loadConfig(folder.uri.fsPath);
    if (config) {
      await setupWorkspace(config);
      vscode.window.showInformationMessage("Band workspace setup complete");
      return;
    }
  }

  // No project config found — try user defaults if it's a Band worktree
  const workspacePath = workspaceFolders[0].uri.fsPath;
  if (await isBandWorktree(workspacePath)) {
    const defaults = await loadUserDefaults();
    if (defaults) {
      await setupWorkspace(defaults);
      vscode.window.showInformationMessage(
        "Band workspace setup complete (using defaults)"
      );
      return;
    }
  }

  vscode.window.showErrorMessage(
    `No .band/config.json found. Checked: ${workspacePath}/.band/config.json`
  );
}

export function deactivate() {}
