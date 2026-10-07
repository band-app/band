import type { ReactNode } from "react";

/**
 * Draws a terminal in the project page. The terminal view lives in `components/`, which the
 * `dashboard/` module must not import, so the app registers it once at start.
 */
export type ProjectTerminalRenderer = (terminal: {
  worktreeId: string;
  terminalId: string;
}) => ReactNode;

let renderer: ProjectTerminalRenderer | null = null;

export function setProjectTerminalRenderer(next: ProjectTerminalRenderer | null): void {
  renderer = next;
}

export function getProjectTerminalRenderer(): ProjectTerminalRenderer | null {
  return renderer;
}
