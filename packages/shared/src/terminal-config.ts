// ---------------------------------------------------------------------------
// Worktree terminal configuration (recursive split-tree layout)
// ---------------------------------------------------------------------------

export interface TerminalPaneConfig {
  name?: string;
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  focus?: boolean;
}

export type TerminalLayoutNode =
  | { pane: TerminalPaneConfig }
  | {
      direction: "horizontal" | "vertical";
      split?: number;
      children: [TerminalLayoutNode, TerminalLayoutNode];
    };

export interface WorktreeTerminalConfig {
  layout: TerminalLayoutNode;
}
