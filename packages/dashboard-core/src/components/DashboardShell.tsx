import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ScrollArea,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  VerticalLabel,
} from "@band-app/ui";
import {
  Check,
  FolderPlus,
  Folders,
  Menu,
  PanelLeft,
  Pencil,
  Plus,
  Settings,
  Tag,
  X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useCliSetup } from "../hooks/use-cli-setup";
import { useHooksSetup } from "../hooks/use-hooks-setup";
import { useProjects } from "../hooks/use-projects";
import { useSettingsQuery } from "../hooks/use-settings-query";
import {
  useBranchStatusWatcher,
  useSetupStatusWatcher,
  useStatusWatcher,
} from "../hooks/use-status";
import { useDashboardStore } from "../stores/index";
import { AddProjectDialog } from "./AddProjectDialog";
import { ProjectList } from "./ProjectList";
import { SettingsPage } from "./SettingsPage";

interface DashboardShellProps {
  /** Extra menu items rendered inside the toolbar's overflow ("3 dots") dropdown,
   *  appended after the built-in Edit/Settings entries. */
  toolbarMenuItems?: ReactNode;
  /** Hide the desktop title bar (e.g. when the parent renders a full-width one). */
  hideTitleBar?: boolean;
  /** Toggle the sidebar collapsed state. When provided, a PanelLeft button is
   *  shown in the sidebar header (expanded) and at the top of the collapsed strip. */
  onToggleSidebar?: () => void;
  /** When true, render a 40px collapsed strip instead of the full shell. */
  sidebarCollapsed?: boolean;
}

// Desktop-shell detection. The Electron preload
// (`apps/desktop/src/preload/index.cts`) exposes `window.__BAND_DESKTOP__`.
const isElectron = typeof window !== "undefined" && "__BAND_DESKTOP__" in window;
const isDesktop = isElectron;

interface ElectronBridge {
  invoke(channel: string, args?: unknown): Promise<unknown>;
}

function electronBridge(): ElectronBridge | null {
  if (!isElectron) return null;
  const bridge = (window as unknown as { __BAND_DESKTOP__?: ElectronBridge }).__BAND_DESKTOP__;
  return bridge ?? null;
}

async function desktopInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const bridge = electronBridge();
  if (bridge) return (await bridge.invoke(cmd, args)) as T;
  throw new Error(`desktopInvoke('${cmd}') called outside the desktop shell`);
}

export function DashboardShell({
  toolbarMenuItems,
  hideTitleBar,
  onToggleSidebar,
  sidebarCollapsed,
}: DashboardShellProps) {
  const { projects, isLoading: loading } = useProjects();
  const { settings } = useSettingsQuery();
  const labels = settings.labels ?? [];
  const error = useDashboardStore((s) => s.error);
  const clearError = useDashboardStore((s) => s.clearError);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showErrorDialog, setShowErrorDialog] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const { state: hooksState, install: installHooks } = useHooksSetup();
  const { state: cliState, install: installCli } = useCliSetup();

  const [appTitle, setAppTitle] = useState("Band");

  useEffect(() => {
    if (!isDesktop) return;
    desktopInvoke<string>("get_app_title")
      .then(setAppTitle)
      .catch(() => {});
  }, []);

  useStatusWatcher();
  useBranchStatusWatcher();
  useSetupStatusWatcher();

  const handleSettingsClick = useCallback(() => setShowSettingsDialog(true), []);

  const activeLabel = useMemo(
    () => (labelFilter ? labels.find((l) => l.id === labelFilter) : null),
    [labelFilter, labels],
  );

  // The desktop shell's native menu (Cmd+,) calls `window.__bandOpenSettings()`
  // via webview.eval / executeJavaScript — same pattern as the zoom menu.
  // Register the global so the menu can pop the in-app dialog instead of
  // spawning a separate window.
  useEffect(() => {
    if (!isDesktop) return;
    const globalKey = "__bandOpenSettings";
    (window as unknown as Record<string, unknown>)[globalKey] = () => setShowSettingsDialog(true);
    return () => {
      delete (window as unknown as Record<string, unknown>)[globalKey];
    };
  }, []);

  // Keyboard shortcuts: Cmd+0 → all projects, Cmd+1..9 → nth label.
  // Skips when focus is in an editable element so it doesn't hijack typing.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key < "0" || e.key > "9") return;

      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
          return;
        }
      }

      const digit = Number(e.key);
      if (digit === 0) {
        e.preventDefault();
        setLabelFilter(null);
        return;
      }
      const lbl = labels[digit - 1];
      if (lbl) {
        e.preventDefault();
        setLabelFilter(lbl.id);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [labels]);

  return (
    <div
      className={cn(
        "w-full overflow-hidden flex flex-col bg-background text-foreground p-0",
        sidebarCollapsed || hideTitleBar ? "h-full" : "h-dvh",
        !sidebarCollapsed && !isDesktop && "pt-[env(safe-area-inset-top)]",
        sidebarCollapsed && "select-none",
      )}
    >
      {isDesktop && !hideTitleBar && (
        <div
          className="h-[38px] shrink-0 flex items-center justify-center border-b border-border"
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        >
          <span className="text-xs font-medium text-muted-foreground select-none pointer-events-none">
            {appTitle}
          </span>
        </div>
      )}

      <div
        className={cn(
          "flex h-10 shrink-0 items-center border-b border-border",
          sidebarCollapsed ? "justify-center" : "justify-between",
        )}
      >
        <div className="flex min-w-0 items-center">
          {onToggleSidebar && (
            <div className="w-10 flex items-center justify-center shrink-0">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={onToggleSidebar}
                    aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
                  >
                    <PanelLeft className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side={sidebarCollapsed ? "right" : "bottom"}>
                  {sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
                </TooltipContent>
              </Tooltip>
            </div>
          )}
          {!sidebarCollapsed && (
            <div className={`flex items-center gap-1 ${onToggleSidebar ? "" : "pl-2"}`}>
              {!onToggleSidebar && (
                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="text-muted-foreground"
                          aria-label="Menu"
                        >
                          <Menu className="size-5" />
                        </Button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">More</TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onClick={() => setEditMode((v) => !v)}>
                      <Pencil className="size-4" />
                      {editMode ? "Done editing" : "Edit list"}
                    </DropdownMenuItem>
                    {toolbarMenuItems}
                    <DropdownMenuItem onClick={handleSettingsClick}>
                      <Settings className="size-4" />
                      Settings
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {onToggleSidebar && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className={`text-muted-foreground ${editMode ? "bg-accent text-accent-foreground" : ""}`}
                      onClick={() => setEditMode((v) => !v)}
                      aria-label={editMode ? "Done editing" : "Edit list"}
                    >
                      <Pencil className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {editMode ? "Done editing" : "Edit list"}
                  </TooltipContent>
                </Tooltip>
              )}
              {labels.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="sm"
                      variant="ghost"
                      className={`min-w-0 text-sm h-8 px-2 gap-1.5 ${labelFilter ? "bg-accent text-accent-foreground" : "text-muted-foreground"}`}
                    >
                      {activeLabel ? (
                        <>
                          <span
                            className="size-2.5 rounded-full shrink-0"
                            style={{ backgroundColor: activeLabel.color }}
                          />
                          <span className="truncate">{activeLabel.name}</span>
                        </>
                      ) : (
                        <>
                          <Tag className="size-5 shrink-0" />
                          <span className="truncate">All</span>
                        </>
                      )}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onClick={() => setLabelFilter(null)}>
                      <Tag className="size-3.5 shrink-0 mr-2 text-muted-foreground" />
                      <span className="truncate">All</span>
                      {!labelFilter && <Check className="size-3 ml-2 shrink-0" />}
                      <span className="ml-auto pl-3 text-xs text-muted-foreground tracking-widest">
                        ⌘0
                      </span>
                    </DropdownMenuItem>
                    {labels.map((lbl, idx) => (
                      <DropdownMenuItem key={lbl.id} onClick={() => setLabelFilter(lbl.id)}>
                        <span
                          className="size-2.5 rounded-full shrink-0 mr-2"
                          style={{ backgroundColor: lbl.color }}
                        />
                        <span className="truncate">{lbl.name}</span>
                        {labelFilter === lbl.id && <Check className="size-3 ml-2 shrink-0" />}
                        {idx < 9 && (
                          <span className="ml-auto pl-3 text-xs text-muted-foreground tracking-widest">
                            ⌘{idx + 1}
                          </span>
                        )}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )}
        </div>
        {!sidebarCollapsed && (
          <div className="flex items-center gap-1 pr-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => setShowAddDialog(true)}
                >
                  <Plus className="size-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Add project</TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>

      {sidebarCollapsed ? (
        <div className="flex-1 flex flex-col items-center pt-3">
          <VerticalLabel
            icon={<Folders className="size-4 text-muted-foreground" />}
            indicatorColor={activeLabel?.color}
            indicatorAriaLabel={activeLabel ? `Filter: ${activeLabel.name}` : undefined}
          >
            {activeLabel?.name ?? "Projects"}
          </VerticalLabel>
        </div>
      ) : (
        <ScrollArea
          className="flex-1 overflow-hidden"
          onClick={(e: React.MouseEvent<HTMLDivElement>) => {
            const target = e.target as HTMLElement;
            if (target.closest("button, a, input, select, textarea, [tabindex]")) return;
            const list = (e.currentTarget as HTMLElement).querySelector<HTMLElement>(
              '[tabindex="-1"]',
            );
            list?.focus({ preventScroll: true });
          }}
        >
          <main className="overflow-hidden">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Spinner className="size-5 text-muted-foreground" />
              </div>
            ) : projects.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
                <FolderPlus className="size-8 text-muted-foreground/50" />
                <div>
                  <p className="text-sm font-medium text-muted-foreground">No projects yet</p>
                  <p className="text-xs text-muted-foreground/70 mt-1">
                    Add a project to get started
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setShowAddDialog(true)}>
                  <Plus className="size-3 mr-1" />
                  Add project
                </Button>
              </div>
            ) : (
              <ProjectList labelFilter={labelFilter} editMode={editMode} />
            )}
          </main>
        </ScrollArea>
      )}

      {!sidebarCollapsed && (
        <>
          {(cliState.status === "manual" || cliState.status === "conflict") && (
            <div className="mx-4 mb-2 px-4 py-2 bg-blue-500/10 border border-blue-500/30 rounded-lg text-sm flex items-center justify-between gap-2">
              <span className="text-blue-700 dark:text-blue-200">
                {cliState.status === "conflict"
                  ? "A different `band` binary exists — replace it to use the bundled CLI"
                  : `Install band CLI${cliState.status === "manual" && cliState.reason ? ` — ${cliState.reason}` : ""}`}
              </span>
              <Button variant="outline" size="sm" className="shrink-0 text-xs" onClick={installCli}>
                Install
              </Button>
            </div>
          )}

          {hooksState.status === "needs_install" && (
            <div className="mx-4 mb-2 px-4 py-2 bg-blue-500/10 border border-blue-500/30 rounded-lg text-sm flex items-center justify-between gap-2">
              <span className="text-blue-700 dark:text-blue-200">
                Install Claude Code hooks for agent status detection
              </span>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 text-xs"
                onClick={installHooks}
              >
                Install
              </Button>
            </div>
          )}

          {error && (
            <div className="mx-4 mb-2 px-4 py-2 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive flex items-center justify-between gap-2">
              <button
                type="button"
                className="truncate text-left cursor-pointer hover:underline"
                onClick={() => setShowErrorDialog(true)}
              >
                {error}
              </button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-destructive shrink-0"
                onClick={clearError}
              >
                <X />
              </Button>
            </div>
          )}
        </>
      )}

      <Dialog open={showErrorDialog} onOpenChange={setShowErrorDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive">Error</DialogTitle>
            <DialogDescription>Click the error text to select it.</DialogDescription>
          </DialogHeader>
          <pre className="whitespace-pre-wrap break-words text-sm bg-muted/50 rounded-md p-3 max-h-64 overflow-auto select-all cursor-text">
            {error}
          </pre>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (error) navigator.clipboard.writeText(error);
              }}
            >
              Copy
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                setShowErrorDialog(false);
                clearError();
              }}
            >
              Dismiss
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AddProjectDialog
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
        defaultLabel={labelFilter}
      />

      <SettingsPage open={showSettingsDialog} onOpenChange={setShowSettingsDialog} />
    </div>
  );
}
