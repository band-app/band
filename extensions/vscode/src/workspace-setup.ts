import * as vscode from "vscode";
import { BandConfig, LayoutConfig, TerminalConfig, BrowserConfig } from "./config";

export async function setupWorkspace(
  config: BandConfig
): Promise<vscode.Terminal[]> {
  const terminals: vscode.Terminal[] = [];

  // Set editor layout if config has layout
  if (config.layout) {
    await setupEditorLayout(config.layout);
  }

  // Create terminals
  if (config.terminals) {
    for (const termConfig of config.terminals) {
      const terminal = createTerminal(termConfig, config);
      terminals.push(terminal);
    }
  }

  return terminals;
}

async function setupEditorLayout(layout: LayoutConfig) {
  // Use vscode.commands.executeCommand('vscode.setEditorLayout', ...)
  // Convert layout config to VS Code editor layout format
  const groups = layout.groups.map((g) => ({ size: g.size }));

  if (layout.orientation === "horizontal") {
    await vscode.commands.executeCommand("vscode.setEditorLayout", {
      orientation: 0, // horizontal
      groups,
    });
  } else {
    await vscode.commands.executeCommand("vscode.setEditorLayout", {
      orientation: 1, // vertical
      groups,
    });
  }

  // Open browser in the group that has browser config
  for (let i = 0; i < layout.groups.length; i++) {
    const group = layout.groups[i];
    if (group.browser) {
      await openBrowser(group.browser.url, i + 1, group.browser.pinned);
    }
  }
}

function createTerminal(
  config: TerminalConfig,
  bandConfig: BandConfig
): vscode.Terminal {
  const terminal = vscode.window.createTerminal({
    name: config.name,
    cwd: bandConfig.project ? undefined : undefined,
  });
  terminal.show(true); // preserve focus = true
  terminal.sendText(config.command);
  return terminal;
}

async function openBrowser(
  url: string,
  viewColumn: number,
  pinned?: boolean
) {
  await vscode.commands.executeCommand(
    "simpleBrowser.api.open",
    vscode.Uri.parse(url),
    { viewColumn: viewColumn }
  );
  if (pinned) {
    await vscode.commands.executeCommand("workbench.action.pinEditor");
  }
}
