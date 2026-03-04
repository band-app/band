import * as vscode from "vscode";
import { loadConfig } from "./config";
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
    const config = await loadConfig(workspaceFolders[0].uri.fsPath);
    if (config) {
      log.appendLine(`Config loaded for workspace: ${config.workspaceId}`);
      await setupWorkspace(config);
      vscode.window.showInformationMessage("Band workspace setup complete");
    } else {
      log.appendLine("No config found");
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

  const checkedPath = workspaceFolders[0].uri.fsPath;
  vscode.window.showErrorMessage(
    `No .band/config.yaml found. Checked: ${checkedPath}/.band/config.yaml`
  );
}

export function deactivate() {}
