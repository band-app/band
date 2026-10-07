import { setProjectTerminalRenderer } from "@/dashboard/lib/project-terminal-slot";
import { TerminalPanel } from "./TerminalPanel";

// The project page opens a terminal in the project folder. It draws the same terminal view the
// worktree panes use, through the slot the dashboard module exposes.
setProjectTerminalRenderer(({ worktreeId, terminalId }) => (
  <div className="h-full" data-testid="projects__terminal-pane">
    <TerminalPanel worktreeId={worktreeId} terminalId={terminalId} visible autoFocus />
  </div>
));
