import * as vscode from "vscode";
import type { BandConfig, TerminalConfig } from "./config";

export interface SetupResult {
  terminals: vscode.Terminal[];
}

export async function setupWorkspace(config: BandConfig): Promise<SetupResult> {
  const terminals: vscode.Terminal[] = [];

  // Extract terminal config from the VS Code app entry in the apps array
  const terminalConfigs = getVsCodeTerminals(config);

  // Create terminals (skip if they already exist from a previous session)
  if (terminalConfigs.length > 0) {
    const existingTerminals = vscode.window.terminals;

    for (const termConfig of terminalConfigs) {
      const existing = existingTerminals.find((t) => t.name === termConfig.name);
      if (existing) {
        terminals.push(existing);
        continue;
      }

      const previousTerminal = terminals.length > 0 ? terminals[terminals.length - 1] : undefined;
      const options: vscode.TerminalOptions = {
        name: termConfig.name,
      };
      if (termConfig.split && previousTerminal) {
        options.location = { parentTerminal: previousTerminal };
      }
      const terminal = vscode.window.createTerminal(options);
      if (termConfig.command) {
        terminal.sendText(termConfig.command);
      }
      terminal.show(false);
      terminals.push(terminal);
    }
  }

  return { terminals };
}

function getVsCodeTerminals(config: BandConfig): TerminalConfig[] {
  if (!config.apps) {
    return [];
  }

  const vscodeApp = config.apps.find((app) => app.type === "vscode");
  if (!vscodeApp || vscodeApp.type !== "vscode") {
    return [];
  }

  return vscodeApp.terminals ?? [];
}
