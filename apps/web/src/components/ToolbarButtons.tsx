import { Dialog, DialogContent, DialogHeader, DialogTitle, DropdownMenuItem } from "@band-app/ui";
import { Globe, ListTodo, Timer } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { useTunnel } from "@/hooks/use-tunnel";
import { CronjobsPageContent } from "./CronjobsPageContent";
import { PrereqDialog } from "./PrereqDialog";
import { TasksPageContent } from "./TasksPageContent";
import { TunnelDialog } from "./TunnelDialog";

interface ToolbarOverflowContextValue {
  openTasks: () => void;
  openCronjobs: () => void;
  openTunnel: () => void;
  /** Tunnel state hint for the menu item (so we can show running/error coloring). */
  tunnelStatus: "idle" | "running" | "error";
  /** True when any toolbar dialog (Tasks, Cronjobs, Tunnel, Prereq) is open.
   *  SharedDockviewLayout merges this with its own dialog state to hide
   *  Electron BrowserView webviews that would otherwise render on top. */
  anyDialogOpen: boolean;
}

const ToolbarOverflowContext = createContext<ToolbarOverflowContextValue | null>(null);

/** Read whether any toolbar overflow dialog is open. Returns false when no
 *  provider is mounted (mobile/web fallback). */
export function useAnyToolbarDialogOpen(): boolean {
  return useContext(ToolbarOverflowContext)?.anyDialogOpen ?? false;
}

/**
 * Owns the dialog state for the toolbar overflow menu (Tasks, Cronjobs, Mobile access).
 *
 * The dialogs are rendered as siblings to `children`, so they remain mounted even when
 * the parent overflow dropdown closes. Menu items live inside the dropdown via
 * <ToolbarOverflowMenuItems /> and call the context handlers to open the dialogs.
 */
export function ToolbarOverflowProvider({ children }: { children: ReactNode }) {
  const [showTasksDialog, setShowTasksDialog] = useState(false);
  const [showCronjobsDialog, setShowCronjobsDialog] = useState(false);

  const {
    webServerRunning,
    tunnelUrl,
    tunnelError,
    setTunnelUrl,
    showPrereq,
    setShowPrereq,
    onPrereqReady,
    showDialog: showTunnelDialog,
    setShowDialog: setShowTunnelDialog,
    openDialog: openTunnelDialog,
    handleStopped: handleTunnelStopped,
  } = useTunnel();

  const openTasks = useCallback(() => setShowTasksDialog(true), []);
  const openCronjobs = useCallback(() => setShowCronjobsDialog(true), []);
  const openTunnel = useCallback(() => openTunnelDialog(), [openTunnelDialog]);

  const tunnelStatus: ToolbarOverflowContextValue["tunnelStatus"] = tunnelError
    ? "error"
    : webServerRunning
      ? "running"
      : "idle";

  const anyDialogOpen = showTasksDialog || showCronjobsDialog || showTunnelDialog || showPrereq;

  const value = useMemo(
    () => ({ openTasks, openCronjobs, openTunnel, tunnelStatus, anyDialogOpen }),
    [openTasks, openCronjobs, openTunnel, tunnelStatus, anyDialogOpen],
  );

  return (
    <ToolbarOverflowContext.Provider value={value}>
      {children}

      {/* Always-mounted dialogs — siblings of `children` so the dropdown closing
          doesn't tear them down. */}
      <Dialog open={showTasksDialog} onOpenChange={setShowTasksDialog}>
        <DialogContent className="sm:max-w-6xl h-[80vh] flex flex-col p-0 gap-0">
          <DialogHeader className="px-6 pt-6 pb-4 border-b border-border/50 shrink-0">
            <DialogTitle>Tasks</DialogTitle>
          </DialogHeader>
          <TasksPageContent />
        </DialogContent>
      </Dialog>

      <Dialog open={showCronjobsDialog} onOpenChange={setShowCronjobsDialog}>
        <DialogContent className="sm:max-w-6xl h-[80vh] flex flex-col p-0 gap-0">
          <DialogHeader className="px-6 pt-6 pb-4 border-b border-border/50 shrink-0">
            <DialogTitle>Cronjobs</DialogTitle>
          </DialogHeader>
          <CronjobsPageContent />
        </DialogContent>
      </Dialog>

      <PrereqDialog open={showPrereq} onOpenChange={setShowPrereq} onReady={onPrereqReady} />
      <TunnelDialog
        open={showTunnelDialog}
        onOpenChange={setShowTunnelDialog}
        onStopped={handleTunnelStopped}
        initialUrl={tunnelUrl}
        onTunnelUrl={setTunnelUrl}
      />
    </ToolbarOverflowContext.Provider>
  );
}

/**
 * Menu items for the dashboard's overflow ("3 dots") dropdown.
 *
 * Must be rendered inside a <ToolbarOverflowProvider>. Returns a fragment of
 * DropdownMenuItem so it can be embedded directly in a DropdownMenuContent.
 */
export function ToolbarOverflowMenuItems() {
  const ctx = useContext(ToolbarOverflowContext);
  if (!ctx) {
    throw new Error("ToolbarOverflowMenuItems must be used inside ToolbarOverflowProvider");
  }

  return (
    <>
      <DropdownMenuItem onClick={ctx.openTasks}>
        <ListTodo className="size-4" />
        Tasks
      </DropdownMenuItem>
      <DropdownMenuItem onClick={ctx.openCronjobs}>
        <Timer className="size-4" />
        Cronjobs
      </DropdownMenuItem>
      <DropdownMenuItem onClick={ctx.openTunnel}>
        <Globe
          className={
            ctx.tunnelStatus === "error"
              ? "size-4 text-red-500"
              : ctx.tunnelStatus === "running"
                ? "size-4 text-green-500"
                : "size-4"
          }
        />
        {ctx.tunnelStatus === "running" ? "Mobile access" : "Start tunnel"}
      </DropdownMenuItem>
    </>
  );
}
