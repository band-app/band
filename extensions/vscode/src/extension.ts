import * as vscode from "vscode";
import { getBandWorktreeIdentity, loadConfig, loadEffectiveConfig } from "./config";
import { setupWorkspace } from "./workspace-setup";

let log: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel("Band");
  log.appendLine("Band extension activating...");

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("band.setupWorkspace", async () => {
      await runSetup();
    }),
  );

  // Auto-setup if config exists or workspace is a Band worktree
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders && workspaceFolders.length > 0) {
    const workspacePath = workspaceFolders[0].uri.fsPath;
    const hasProjectConfig = (await loadConfig(workspacePath)) !== null;
    const identity = await getBandWorktreeIdentity(workspacePath);

    if (hasProjectConfig || identity) {
      const effective = await loadEffectiveConfig(workspacePath);
      if (effective) {
        log.appendLine("Effective config loaded, setting up workspace...");
        await setupWorkspace(effective);
        vscode.window.showInformationMessage("Band workspace setup complete");
      } else {
        log.appendLine("No effective config resolved");
      }

      if (identity) {
        log.appendLine(`Band worktree identified: ${identity.workspaceId}`);
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
      const effective = await loadEffectiveConfig(folder.uri.fsPath);
      if (effective) {
        await setupWorkspace(effective);
        vscode.window.showInformationMessage("Band workspace setup complete");
      }
      return;
    }
  }

  // No project config found — try user defaults if it's a Band worktree
  const workspacePath = workspaceFolders[0].uri.fsPath;
  const identity = await getBandWorktreeIdentity(workspacePath);
  if (identity) {
    const effective = await loadEffectiveConfig(workspacePath);
    if (effective) {
      await setupWorkspace(effective);
      vscode.window.showInformationMessage("Band workspace setup complete");
      return;
    }
  }

  vscode.window.showErrorMessage(
    `No .band/config.json found. Checked: ${workspacePath}/.band/config.json`,
  );
}

export function deactivate() {}
