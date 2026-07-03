import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@band-app/ui";
import { Activity, BarChart3, Globe, ListTodo, MoreHorizontal, Timer } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { useTunnel } from "@/hooks/use-tunnel";
import { CronjobsPageContent } from "./CronjobsPageContent";
import { PrereqDialog } from "./PrereqDialog";
import { ReportsPageContent } from "./ReportsPageContent";
import { ResourcesPage } from "./ResourcesPage";
import { TasksPageContent } from "./TasksPageContent";
import { TunnelDialog } from "./TunnelDialog";

interface ToolbarOverflowContextValue {
  openTasks: () => void;
  openCronjobs: () => void;
  openReports: () => void;
  openTunnel: () => void;
  openResources: () => void;
  /** Tunnel state hint for the menu item (so we can show running/error coloring). */
  tunnelStatus: "idle" | "running" | "error";
  /** True when any toolbar dialog (Tasks, Cronjobs, Reports, Tunnel,
   *  Prereq, Resources) is open. SharedDockviewLayout merges this with
   *  its own dialog state to hide Electron BrowserView webviews that
   *  would otherwise render on top. */
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
  const [showReportsDialog, setShowReportsDialog] = useState(false);
  const [showResourcesDialog, setShowResourcesDialog] = useState(false);

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
  const openReports = useCallback(() => setShowReportsDialog(true), []);
  const openTunnel = useCallback(() => openTunnelDialog(), [openTunnelDialog]);
  const openResources = useCallback(() => setShowResourcesDialog(true), []);

  const tunnelStatus: ToolbarOverflowContextValue["tunnelStatus"] = tunnelError
    ? "error"
    : webServerRunning
      ? "running"
      : "idle";

  const anyDialogOpen =
    showTasksDialog ||
    showCronjobsDialog ||
    showReportsDialog ||
    showTunnelDialog ||
    showPrereq ||
    showResourcesDialog;

  const value = useMemo(
    () => ({
      openTasks,
      openCronjobs,
      openReports,
      openTunnel,
      openResources,
      tunnelStatus,
      anyDialogOpen,
    }),
    [openTasks, openCronjobs, openReports, openTunnel, openResources, tunnelStatus, anyDialogOpen],
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

      <Dialog open={showReportsDialog} onOpenChange={setShowReportsDialog}>
        <DialogContent
          className="sm:max-w-6xl h-[80vh] flex flex-col p-0 gap-0"
          data-testid="reports-dialog"
        >
          <DialogHeader className="px-6 pt-6 pb-4 border-b border-border/50 shrink-0">
            <DialogTitle>Usage</DialogTitle>
          </DialogHeader>
          <ReportsPageContent />
        </DialogContent>
      </Dialog>

      <Dialog open={showResourcesDialog} onOpenChange={setShowResourcesDialog}>
        <DialogContent
          className="sm:max-w-6xl h-[80vh] flex flex-col p-0 gap-0"
          data-testid="resources-dialog"
        >
          <DialogHeader className="px-6 pt-6 pb-4 border-b border-border/50 shrink-0">
            <DialogTitle>Resources</DialogTitle>
          </DialogHeader>
          <div className="flex-1 min-h-0">
            <ResourcesPage />
          </div>
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
      <DropdownMenuItem onClick={ctx.openReports} data-testid="menu__reports">
        <BarChart3 className="size-4" />
        Usage
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
      <DropdownMenuItem onClick={ctx.openResources} data-testid="menu__resources">
        <Activity className="size-4" />
        Resources
      </DropdownMenuItem>
    </>
  );
}

/**
 * Bottom action row cluster for the project list (right-hand side).
 *
 * Surfaces Resources and Usage as standalone icon buttons and tucks the
 * remaining actions (Tasks, Cronjobs, tunnel) behind a 3-dot overflow menu.
 * Rendered inside `DashboardShell`'s persistent footer; passed in as a
 * `ReactNode` prop because the `dashboard/` module must not import from
 * `components/`. Must be mounted inside a <ToolbarOverflowProvider>.
 */
export function ToolbarActionBar() {
  const ctx = useContext(ToolbarOverflowContext);
  if (!ctx) {
    throw new Error("ToolbarActionBar must be used inside ToolbarOverflowProvider");
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon-sm"
            variant="ghost"
            className="text-muted-foreground"
            aria-label="Resources"
            data-testid="project-list__resources-button"
            onClick={ctx.openResources}
          >
            <Activity className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Resources</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon-sm"
            variant="ghost"
            className="text-muted-foreground"
            aria-label="Usage"
            data-testid="project-list__usage-button"
            onClick={ctx.openReports}
          >
            <BarChart3 className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Usage</TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                className="text-muted-foreground"
                aria-label="More actions"
                data-testid="project-list__overflow-trigger"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">More</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
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
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
