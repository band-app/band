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
} from "@band-app/ui";
import { Check, ChevronsDownUp, FolderPlus, Menu, Plus, Settings, Tag, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCapabilities } from "../context";
import { useAppUpdate } from "../hooks/use-app-update";
import { useCliSetup } from "../hooks/use-cli-setup";
import {
  LABELS_COLLAPSE_KEY,
  PINNED_COLLAPSE_KEY,
  PINNED_SECTION_ID,
  PROJECTS_COLLAPSE_KEY,
  UNLABELED_KEY,
  useCollapseState,
} from "../hooks/use-collapse-state";
import { useHooksSetup } from "../hooks/use-hooks-setup";
import { useLabelFilter } from "../hooks/use-label-filter";
import { useLabelLastWorkspace } from "../hooks/use-label-last-workspace";
import { useProjects } from "../hooks/use-projects";
import { useSettingsQuery } from "../hooks/use-settings-query";
import {
  useBranchStatusWatcher,
  useSetupStatusWatcher,
  useStatusWatcher,
} from "../hooks/use-status";
import { toWorkspaceId } from "../lib/workspace-id";
import { useDashboardStore } from "../stores/index";
import type { ProjectInfo } from "../types";
import { AddProjectDialog } from "./AddProjectDialog";
import { ProjectList } from "./ProjectList";
import { SettingsPage } from "./SettingsPage";

interface DashboardShellProps {
  /** Extra menu items rendered inside the toolbar's overflow dropdown,
   *  appended after the built-in Settings entry. */
  toolbarMenuItems?: ReactNode;
  /** Hide the desktop title bar (e.g. when the parent renders a full-width one). */
  hideTitleBar?: boolean;
  /** Suppress the in-shell hamburger overflow menu. Used when this shell is
   *  embedded under a global title bar that already exposes the same items
   *  (Tasks / Cronjobs / Settings / …). */
  hideMenu?: boolean;
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

export function DashboardShell({ toolbarMenuItems, hideTitleBar, hideMenu }: DashboardShellProps) {
  const { projects, isLoading: loading } = useProjects();
  const { settings } = useSettingsQuery();
  const labels = settings.labels ?? [];
  const error = useDashboardStore((s) => s.error);
  const clearError = useDashboardStore((s) => s.clearError);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showErrorDialog, setShowErrorDialog] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const [labelFilter, persistLabelFilter] = useLabelFilter();
  const { getLastWorkspace, setLastWorkspace } = useLabelLastWorkspace();
  const capabilities = useCapabilities();
  const activeWorkspaceId = useDashboardStore((s) => s.activeWorkspaceId);
  const { state: hooksState, install: installHooks } = useHooksSetup();
  const { state: cliState, install: installCli } = useCliSetup();
  const { state: updateState, install: installUpdate } = useAppUpdate();

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

  // Collapse-all toolbar action: write every project name into the
  // collapsed-projects set and every label id (plus the unlabeled sentinel)
  // into the collapsed-labels set. The custom event dispatched by `setAll`
  // pings every useCollapseState consumer so the list re-renders instantly.
  // The Pinned section header lives outside the labels/projects tree, so
  // we also fold it into the collapsed state explicitly — "Collapse all"
  // is meant to collapse everything visible, including the pinned group.
  const projectCollapse = useCollapseState(PROJECTS_COLLAPSE_KEY);
  const labelCollapse = useCollapseState(LABELS_COLLAPSE_KEY);
  const pinnedCollapse = useCollapseState(PINNED_COLLAPSE_KEY);
  const collapseAll = useCallback(() => {
    projectCollapse.setAll(projects.map((p) => p.name));
    labelCollapse.setAll([...labels.map((l) => l.id), UNLABELED_KEY]);
    pinnedCollapse.setAll([PINNED_SECTION_ID]);
  }, [projectCollapse, labelCollapse, pinnedCollapse, projects, labels]);

  const activeLabel = useMemo(
    () => (labelFilter ? labels.find((l) => l.id === labelFilter) : null),
    [labelFilter, labels],
  );

  // Find the project that owns `workspaceId` in the current project list, or
  // `undefined` when the workspace no longer exists (deleted / renamed). Kept
  // as a helper rather than a Map<workspaceId, ProjectInfo> because the
  // project list churns rarely and the per-call O(projects × worktrees) walk
  // is dominated by render cost anyway.
  const findProjectForWorkspace = useCallback(
    (workspaceId: string): ProjectInfo | undefined =>
      projects.find((p) =>
        p.worktrees.some((wt) => toWorkspaceId(p.name, wt.branch) === workspaceId),
      ),
    [projects],
  );

  // Per-label "last workspace" tracking for issue #505. Two write sites
  // cooperate so the user's selection is captured whether they click a
  // workspace card (effect below) or switch label without clicking
  // anything (`setLabelFilter` further down):
  //
  //   - The effect records each fresh `activeWorkspaceId` under the
  //     currently-active label. The `lastSeenActiveRef` guard skips
  //     reruns triggered by `labelFilter` changing without
  //     `activeWorkspaceId` changing — i.e. immediately after a label
  //     switch, before the restore-driven navigation has propagated. If
  //     we didn't skip, the effect would briefly stamp the *incoming*
  //     label with the *outgoing* label's workspace and undo the
  //     restoration we just initiated.
  //
  //   - `setLabelFilter` does an imperative save of the outgoing label
  //     so the user's most recent selection is captured even when they
  //     never explicitly clicked the workspace card after navigating to
  //     it (e.g. direct URL / Cmd+R picker / page reload).
  const lastSeenActiveRef = useRef<string | null>(activeWorkspaceId);
  useEffect(() => {
    if (!activeWorkspaceId) {
      lastSeenActiveRef.current = null;
      return;
    }
    if (!labelFilter) {
      // ALL has no per-label memory, but we still update the ref so a
      // subsequent label switch correctly recognises the workspace as
      // unchanged (and skips the cross-label stamp).
      lastSeenActiveRef.current = activeWorkspaceId;
      return;
    }
    if (lastSeenActiveRef.current === activeWorkspaceId) return;
    lastSeenActiveRef.current = activeWorkspaceId;
    // Only save when the active workspace's project is actually labelled
    // with the current filter — see the comment block on the
    // `setLabelFilter` invariants below for the rationale.
    const project = findProjectForWorkspace(activeWorkspaceId);
    if (!project || project.label !== labelFilter) return;
    setLastWorkspace(labelFilter, activeWorkspaceId);
  }, [labelFilter, activeWorkspaceId, setLastWorkspace, findProjectForWorkspace]);

  // Per-label "last workspace" plumbing for issue #505. The orchestration
  // lives in `setLabelFilter` below; the helper here keeps the bookkeeping
  // out of the keyboard / dropdown handlers.
  //
  // Invariants enforced by the caller:
  //   1. Saves only happen when the outgoing label is non-null (ALL has no
  //      per-label memory) AND the active workspace's project is actually
  //      labelled with the outgoing label. If the user navigated to a
  //      workspace under a different label via the Cmd+R picker, we don't
  //      want to record that workspace as Personal's "last" just because
  //      the filter happened to be Personal at the time.
  //   2. Restores only happen when the saved workspace still exists AND its
  //      project is still labelled with the target label (labels can be
  //      reassigned at any time). If validation fails we fall through to
  //      the "no history" branch — current behaviour, i.e. keep the
  //      previous active workspace, leaving the user to pick one.
  const setLabelFilter = useCallback(
    (newLabel: string | null) => {
      if (newLabel === labelFilter) return;

      // Save the outgoing label's active workspace before mutating state.
      // Doing this synchronously (rather than via an effect on
      // labelFilter/activeWorkspaceId) avoids a race where the effect would
      // fire after the label changed but before the restore-driven
      // navigation propagated activeWorkspaceId, briefly re-stamping the
      // incoming label with the outgoing label's workspace.
      if (labelFilter && activeWorkspaceId) {
        const project = findProjectForWorkspace(activeWorkspaceId);
        if (project && project.label === labelFilter) {
          setLastWorkspace(labelFilter, activeWorkspaceId);
        }
      }

      persistLabelFilter(newLabel);

      // ALL is the explicit no-op case (per the issue): keep the user on
      // whatever workspace they were last viewing. Restoration only applies
      // when switching to a *specific* label.
      if (!newLabel) return;

      const target = getLastWorkspace(newLabel);
      if (!target || target === activeWorkspaceId) return;
      const targetProject = findProjectForWorkspace(target);
      if (!targetProject || targetProject.label !== newLabel) return;

      const href = capabilities.getWorkspaceHref?.(target);
      if (href && capabilities.navigate) {
        capabilities.navigate(href);
      }
    },
    [
      labelFilter,
      activeWorkspaceId,
      persistLabelFilter,
      setLastWorkspace,
      getLastWorkspace,
      findProjectForWorkspace,
      capabilities,
    ],
  );

  // The desktop shell's native menu (Cmd+,) and the in-app DesktopTitleBar
  // hamburger both call `window.__bandOpenSettings()` to pop this dialog.
  // The native-menu path goes via webview.eval / executeJavaScript — same
  // pattern as the zoom menu. Register the global unconditionally so the
  // hamburger works in the browser too (E2E + web shell).
  //
  // Multiple `DashboardShell` instances can be alive concurrently —
  // DockviewInstanceManager keeps one per cached workspace. They all
  // race to own the same window global: each mount overwrites the
  // previous registration. The cleanup must only delete the key if
  // we still own it; otherwise a stale unmount (LRU eviction or
  // workspace switch) wipes a newer instance's registration and
  // leaves the macOS Settings… menu silently broken until full reload.
  useEffect(() => {
    const globalKey = "__bandOpenSettings";
    const win = window as unknown as Record<string, unknown>;
    const handler = () => setShowSettingsDialog(true);
    win[globalKey] = handler;
    return () => {
      if (win[globalKey] === handler) {
        delete win[globalKey];
      }
    };
  }, []);

  // Listen for ⌃0 (Focus Side Bar) — the keyboard handler in the workspace
  // layout expands the left edge group and dispatches this event; we move
  // keyboard focus into the project list so arrow keys can navigate it.
  // Multi-workspace note: every DashboardShell instance receives the
  // event, but each focuses only its own subtree via rootRef. Inactive
  // workspaces are display:none-hidden upstream, so focus() on their
  // internal element is a no-op — only the visible instance wins.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = () => {
      const list = rootRef.current?.querySelector<HTMLElement>('[tabindex="-1"]');
      list?.focus({ preventScroll: true });
    };
    window.addEventListener("band:focus-projects", handler);
    return () => window.removeEventListener("band:focus-projects", handler);
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
  }, [labels, setLabelFilter]);

  return (
    <div
      ref={rootRef}
      className={cn(
        "w-full overflow-hidden flex flex-col bg-background text-foreground p-0",
        hideTitleBar && "h-full",
        !isDesktop && "pt-[env(safe-area-inset-top)]",
      )}
      // CSS `zoom` does not scale viewport units (vh, dvh, svh, lvh) per
      // spec, so `height: 100dvh` under `<html style="zoom: 0.5">` resolves
      // to the viewport in CSS px and is then rendered at 50% — leaving the
      // dashboard half the visible height with a gap at the bottom. Divide
      // by the live app zoom factor (`--app-zoom`, set by applyZoomLevel in
      // apps/web/src/lib/zoom.ts) so the rendered height always matches the
      // actual viewport. The `hideTitleBar` branch is sized by its parent
      // (a dockview panel with explicit pixel height) so it doesn't need
      // the compensation. See band-app/band#463.
      //
      // NOTE: `--app-zoom` is hardcoded here because the `dashboard` module
      // is an internal seam — code under `apps/web/src/dashboard/` must not
      // reach out into `apps/web/src/lib/` (or anywhere else in apps/web)
      // except through the `DashboardAdapter`. That boundary survived the
      // fold from `packages/dashboard-core` so the seam can be re-enforced
      // as a separate package again if we ever ship a second renderer.
      // Keep this string in sync with the `ZOOM_CSS_VAR` constant exported
      // from `apps/web/src/lib/zoom.ts` — grep for `ZOOM_CSS_VAR` there if
      // renaming.
      style={
        hideTitleBar
          ? undefined
          : {
              // sync-with: ZOOM_CSS_VAR in apps/web/src/lib/zoom.ts
              height: "calc(100dvh / var(--app-zoom, 1))",
            }
      }
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

      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border">
        <div className="flex min-w-0 items-center">
          <div className="flex items-center gap-1 pl-2">
            {!hideMenu && (
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="text-muted-foreground"
                        aria-label="Menu"
                        data-testid="dashboard__menu-trigger"
                      >
                        <Menu className="size-5" />
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">More</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="start">
                  {toolbarMenuItems}
                  <DropdownMenuItem onClick={handleSettingsClick}>
                    <Settings className="size-4" />
                    Settings
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {labels.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="dashboard__label-filter-trigger"
                    className={`min-w-0 text-sm h-7 px-2 gap-1.5 ${labelFilter ? "bg-accent text-accent-foreground" : "text-muted-foreground"}`}
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
                        <Tag className="size-3.5 shrink-0" />
                        <span className="truncate">All</span>
                      </>
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem
                    data-testid="dashboard__label-filter-item--all"
                    onClick={() => setLabelFilter(null)}
                  >
                    <Tag className="size-3.5 shrink-0 mr-2 text-muted-foreground" />
                    <span className="truncate">All</span>
                    {!labelFilter && <Check className="size-3 ml-2 shrink-0" />}
                    <span className="ml-auto pl-3 text-xs text-muted-foreground tracking-widest">
                      ⌘0
                    </span>
                  </DropdownMenuItem>
                  {labels.map((lbl, idx) => (
                    <DropdownMenuItem
                      key={lbl.id}
                      data-testid={`dashboard__label-filter-item--${lbl.id}`}
                      onClick={() => setLabelFilter(lbl.id)}
                    >
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
        </div>
        <div className="flex items-center gap-1 pr-2">
          {projects.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="text-muted-foreground"
                  aria-label="Collapse all"
                  onClick={collapseAll}
                >
                  <ChevronsDownUp className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Collapse all</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => setShowAddDialog(true)}
              >
                <Plus className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Add project</TooltipContent>
          </Tooltip>
        </div>
      </div>

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
        {/* No overflow-hidden here: when the project list grows past the
            viewport, clipping main makes Radix's ScrollArea miss the
            overflowing content and stop scroll-max early. The list still
            keeps horizontal text truncation via min-w-0 + truncate on its
            children. pb-3 gives the last row breathing room. */}
        <main className="pb-3">
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
            <ProjectList labelFilter={labelFilter} />
          )}
        </main>
      </ScrollArea>

      {updateState.status === "available" && (
        <div className="mx-4 mb-2 px-4 py-2 bg-blue-500/10 border border-blue-500/30 rounded-lg text-sm flex items-center justify-between gap-2">
          <span className="text-blue-700 dark:text-blue-200">
            {`Band v${updateState.version} is available`}
          </span>
          <Button variant="outline" size="sm" className="shrink-0 text-xs" onClick={installUpdate}>
            Install
          </Button>
        </div>
      )}

      {updateState.status === "installing" && (
        <div className="mx-4 mb-2 px-4 py-2 bg-blue-500/10 border border-blue-500/30 rounded-lg text-sm flex items-center justify-between gap-2">
          <span className="text-blue-700 dark:text-blue-200">Installing update…</span>
          <Button variant="outline" size="sm" className="shrink-0 text-xs" disabled>
            Install
          </Button>
        </div>
      )}

      {updateState.status === "error" && (
        <div className="mx-4 mb-2 px-4 py-2 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive flex items-center justify-between gap-2">
          <span className="truncate">{`Update failed: ${updateState.message}`}</span>
          <Button variant="outline" size="sm" className="shrink-0 text-xs" onClick={installUpdate}>
            Retry
          </Button>
        </div>
      )}

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
          <Button variant="outline" size="sm" className="shrink-0 text-xs" onClick={installHooks}>
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
