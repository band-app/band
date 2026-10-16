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
import { Activity, BarChart3, Coffee, Globe, MoreVertical, Timer } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { useKeepAwake } from "@/hooks/use-keep-awake";
import { useTunnel } from "@/hooks/use-tunnel";
import { AccountUsagePopover } from "./AccountUsagePopover";
import { CronjobsPageContent } from "./CronjobsPageContent";
import { PrereqDialog } from "./PrereqDialog";
import { ReportsPageContent } from "./ReportsPageContent";
import { ResourcesPage } from "./ResourcesPage";
import { TunnelDialog } from "./TunnelDialog";

interface ToolbarOverflowContextValue {
  openCronjobs: () => void;
  openReports: () => void;
  openTunnel: () => void;
  openResources: () => void;
  /** Tunnel state hint for the menu item (so we can show running/error coloring). */
  tunnelStatus: "idle" | "running" | "error";
}

const ToolbarOverflowContext = createContext<ToolbarOverflowContextValue | null>(null);

/**
 * Owns the dialog state for the toolbar overflow menu (Cronjobs, Usage, Resources, Mobile access).
 *
 * The dialogs are rendered as siblings to `children`, so they remain mounted even when
 * the parent overflow dropdown closes. The action buttons live in the repo-list
 * bottom action bar via <ToolbarActionBar /> and call the context handlers to open
 * the dialogs.
 */
export function ToolbarOverflowProvider({ children }: { children: ReactNode }) {
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

  const openCronjobs = useCallback(() => setShowCronjobsDialog(true), []);
  const openReports = useCallback(() => setShowReportsDialog(true), []);
  const openTunnel = useCallback(() => openTunnelDialog(), [openTunnelDialog]);
  const openResources = useCallback(() => setShowResourcesDialog(true), []);

  const tunnelStatus: ToolbarOverflowContextValue["tunnelStatus"] = tunnelError
    ? "error"
    : webServerRunning
      ? "running"
      : "idle";

  const value = useMemo(
    () => ({
      openCronjobs,
      openReports,
      openTunnel,
      openResources,
      tunnelStatus,
    }),
    [openCronjobs, openReports, openTunnel, openResources, tunnelStatus],
  );

  return (
    <ToolbarOverflowContext.Provider value={value}>
      {children}

      {/* Always-mounted dialogs — siblings of `children` so the dropdown closing
          doesn't tear them down. */}
      <Dialog open={showCronjobsDialog} onOpenChange={setShowCronjobsDialog}>
        <DialogContent className="sm:max-w-6xl h-[calc(80vh/var(--app-zoom,1))] flex flex-col p-0 gap-0">
          <DialogHeader className="px-6 pt-6 pb-4 border-b border-border/50 shrink-0">
            <DialogTitle>Cronjobs</DialogTitle>
          </DialogHeader>
          <CronjobsPageContent />
        </DialogContent>
      </Dialog>

      <Dialog open={showReportsDialog} onOpenChange={setShowReportsDialog}>
        <DialogContent
          className="sm:max-w-6xl h-[calc(80vh/var(--app-zoom,1))] flex flex-col p-0 gap-0"
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
          className="sm:max-w-6xl h-[calc(80vh/var(--app-zoom,1))] flex flex-col p-0 gap-0"
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
 * Bottom action row cluster for the repo list (right-hand side).
 *
 * Surfaces Resources and the keep-awake switch (desktop app only) as standalone
 * icon buttons and tucks the remaining actions (Cronjobs, Usage, tunnel) behind
 * a 3-dot overflow menu.
 * Rendered inside `DashboardShell`'s persistent footer; passed in as a
 * `ReactNode` prop because the `dashboard/` module must not import from
 * `components/`. Must be mounted inside a <ToolbarOverflowProvider>.
 */
export function ToolbarActionBar() {
  const ctx = useContext(ToolbarOverflowContext);
  if (!ctx) {
    throw new Error("ToolbarActionBar must be used inside ToolbarOverflowProvider");
  }

  const keepAwake = useKeepAwake();

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                className="text-muted-foreground"
                aria-label="More actions"
                data-testid="repo-list__overflow-trigger"
              >
                <MoreVertical className="size-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">More</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={ctx.openCronjobs}>
            <Timer className="size-4" />
            Cronjobs
          </DropdownMenuItem>
          <DropdownMenuItem onClick={ctx.openReports} data-testid="repo-list__usage-item">
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
        </DropdownMenuContent>
      </DropdownMenu>
      <AccountUsagePopover />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon-sm"
            variant="ghost"
            className="text-muted-foreground"
            aria-label="Resources"
            data-testid="repo-list__resources-button"
            onClick={ctx.openResources}
          >
            <Activity className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Resources</TooltipContent>
      </Tooltip>
      {keepAwake.available && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              className={keepAwake.enabled ? "text-amber-500" : "text-muted-foreground"}
              aria-label="Keep this Mac awake"
              aria-pressed={keepAwake.enabled}
              data-testid="repo-list__keep-awake-button"
              onClick={keepAwake.toggle}
            >
              <Coffee className="size-4" fill={keepAwake.enabled ? "currentColor" : "none"} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {keepAwake.enabled
              ? "Keeping this Mac awake (until Band quits)"
              : "Keep this Mac awake while Band runs"}
          </TooltipContent>
        </Tooltip>
      )}
    </>
  );
}
