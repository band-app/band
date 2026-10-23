import { toWorktreeId } from "@band-app/shared/worktree-id";
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@band-app/ui";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  FolderPlus,
  ListFilter,
  Plus,
  Settings,
  X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToastObstruction } from "../../lib/toast-obstructions";
import { trpc } from "../../lib/trpc-client";
import { useCapabilities } from "../context";
import { useCliSetup } from "../hooks/use-cli-setup";
import {
  GROUPS_COLLAPSE_KEY,
  PINNED_COLLAPSE_KEY,
  PINNED_SECTION_ID,
  REPOS_COLLAPSE_KEY,
  useCollapseState,
} from "../hooks/use-collapse-state";
import { useGroupFilter } from "../hooks/use-group-filter";
import { useGroupLastWorktree } from "../hooks/use-group-last-worktree";
import { useGroupMutations, useGroupsQuery } from "../hooks/use-groups";
import { useHooksSetup } from "../hooks/use-hooks-setup";
import { useRepos } from "../hooks/use-repos";
import {
  useBranchStatusWatcher,
  useOriginChangeWatcher,
  useSetupStatusWatcher,
  useStatusWatcher,
} from "../hooks/use-status";
import { collapsibleKeys, ORIGIN_COLLAPSE_KEY } from "../lib/sidebar-grouping";
import { useDashboardStore } from "../stores/index";
import { AddRepoDialog } from "./AddRepoDialog";
import { DesktopViewerDialog } from "./DesktopViewerDialog";
import { GroupNameDialog } from "./GroupDialogs";
import { RepoList } from "./RepoList";
import { ReposPanel } from "./ReposPanel";
import { SettingsPage } from "./SettingsPage";
import { UpdateAvailableBadge } from "./UpdateAvailableBadge";

interface DashboardShellProps {
  /** Action cluster rendered on the right of the persistent bottom action
   *  bar (Resources / Usage icons + a 3-dot overflow). Passed in as a node
   *  because the `dashboard/` module must not import from `components/`;
   *  callers supply `<ToolbarActionBar />`. */
  bottomActions?: ReactNode;
  /** Hide the desktop title bar (e.g. when the parent renders a full-width one). */
  hideTitleBar?: boolean;
  /** Pad the home-indicator inset below the action bar even with
   *  `hideTitleBar`. Set by the mobile repo-list fly-out, which reaches the
   *  bottom screen edge with no AppShell below it to pad the inset. */
  padBottomInset?: boolean;
  /** Make the Repos header (group filter, collapse all, add repo) as tall as
   *  the mobile worktree header, so the two line up. Set by the mobile
   *  repo-list fly-out. */
  matchMobileHeader?: boolean;
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
  bottomActions,
  hideTitleBar,
  padBottomInset,
  matchMobileHeader,
}: DashboardShellProps) {
  const { repos, isLoading: loading } = useRepos();
  const { groups, loaded: groupsLoaded } = useGroupsQuery();
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const [settingsHosts, setSettingsHosts] = useState(false);
  const [addingRepo, setAddingRepo] = useState(false);
  // Adding a repo needs an admin token.
  const admin = useQuery({
    queryKey: ["tokens.current"],
    queryFn: () => trpc.tokens.current.query(),
    retry: false,
  });
  const actionBarObstructionRef = useToastObstruction();
  const [groupFilter, persistGroupFilter] = useGroupFilter();
  const [namingGroup, setNamingGroup] = useState(false);
  const { create: createGroup } = useGroupMutations();
  const { getLastWorktree, setLastWorktree } = useGroupLastWorktree();
  // A filter on a group that was deleted (here or on another device) goes back to All.
  useEffect(() => {
    if (groupsLoaded && groupFilter && !groups.some((g) => g.id === groupFilter)) {
      persistGroupFilter(null);
    }
  }, [groupsLoaded, groups, groupFilter, persistGroupFilter]);
  const capabilities = useCapabilities();
  const activeWorktreeId = useDashboardStore((s) => s.activeWorktreeId);
  const hooksSetup = useHooksSetup();
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
  useOriginChangeWatcher();

  const handleSettingsClick = useCallback(() => {
    setSettingsHosts(false);
    setShowSettingsDialog(true);
  }, []);

  const repoCollapse = useCollapseState(REPOS_COLLAPSE_KEY);
  const groupCollapse = useCollapseState(GROUPS_COLLAPSE_KEY);
  const pinnedCollapse = useCollapseState(PINNED_COLLAPSE_KEY);
  const originCollapse = useCollapseState(ORIGIN_COLLAPSE_KEY);
  // The button folds every header and every parent the list shows for the current filter, and
  // unfolds the same ones. A group the filter hides keeps its state. It offers "Expand all" once
  // everything it folds is folded.
  const collapsible = useMemo(
    () => collapsibleKeys(repos, groups, groupFilter),
    [repos, groups, groupFilter],
  );
  const allCollapsed =
    (!collapsible.pinned || pinnedCollapse.isCollapsed(PINNED_SECTION_ID)) &&
    collapsible.groups.every(groupCollapse.isCollapsed) &&
    collapsible.origins.every(originCollapse.isCollapsed) &&
    collapsible.repos.every(repoCollapse.isCollapsed);
  const hasCollapsible =
    collapsible.pinned ||
    collapsible.groups.length + collapsible.origins.length + collapsible.repos.length > 0;
  const toggleAll = useCallback(() => {
    const apply = allCollapsed ? "removeAll" : "addAll";
    if (collapsible.pinned) pinnedCollapse[apply]([PINNED_SECTION_ID]);
    groupCollapse[apply](collapsible.groups);
    originCollapse[apply](collapsible.origins);
    repoCollapse[apply](collapsible.repos);
  }, [allCollapsed, collapsible, pinnedCollapse, groupCollapse, originCollapse, repoCollapse]);

  const activeGroup = useMemo(
    () => (groupFilter ? groups.find((g) => g.id === groupFilter) : null),
    [groupFilter, groups],
  );

  // The group of the worktree `worktreeId` in the current repo list, or `undefined` when the
  // worktree no longer exists (deleted / renamed) and null when it has no group. Kept as a helper
  // rather than a Map because the repo list churns rarely and the per-call O(repos × worktrees)
  // walk is dominated by render cost anyway.
  const groupOfWorktree = useCallback(
    (worktreeId: string): string | null | undefined => {
      for (const p of repos) {
        for (const wt of p.worktrees) {
          if (toWorktreeId(p.name, wt.name, wt.hostId) === worktreeId) return wt.groupId ?? null;
        }
      }
      return undefined;
    },
    [repos],
  );

  // Per-group "last worktree" for issue #505. Two write sites cooperate:
  // `useRecordGroupLastWorktree`, run by the app shell, records each
  // worktree opened under a group (the app shell also sees a pick on the
  // phone's full-screen dashboard, which unmounts this shell), and
  // `setGroupFilter` below saves the outgoing group's worktree on a group
  // switch, so a worktree reached by direct URL, the ⌘K picker or a reload
  // is captured too. `setGroupFilter` also restores the incoming group's
  // worktree.
  //
  // Invariants enforced by the caller:
  //   1. Saves only happen when the outgoing group is non-null (ALL has no
  //      per-group memory) AND the active worktree is actually in the
  //      outgoing group. If the user navigated to a worktree in a
  //      different group via the ⌘K picker, we don't want to record that
  //      worktree as the filtered group's "last" just because the filter
  //      happened to be on it at the time.
  //   2. Restores only happen when the saved worktree still exists AND is
  //      still in the target group (worktrees can be moved at any time). If
  //      validation fails we fall through to the "no history" branch,
  //      i.e. keep the previous active worktree, leaving the user to pick
  //      one.
  const setGroupFilter = useCallback(
    (newGroup: string | null) => {
      if (newGroup === groupFilter) return;

      // Save the outgoing group's active worktree before mutating state.
      // Doing this synchronously (rather than via an effect on
      // groupFilter/activeWorktreeId) avoids a race where the effect would
      // fire after the group changed but before the restore-driven
      // navigation propagated activeWorktreeId, briefly re-stamping the
      // incoming group with the outgoing group's worktree.
      if (groupFilter && activeWorktreeId) {
        if (groupOfWorktree(activeWorktreeId) === groupFilter) {
          setLastWorktree(groupFilter, activeWorktreeId);
        }
      }

      persistGroupFilter(newGroup);

      // ALL is the explicit no-op case (per the issue): keep the user on
      // whatever worktree they were last viewing. Restoration only applies
      // when switching to a *specific* group.
      if (!newGroup) return;

      const target = getLastWorktree(newGroup);
      if (!target || target === activeWorktreeId) return;
      if (groupOfWorktree(target) !== newGroup) return;

      const href = capabilities.getWorktreeHref?.(target);
      if (href && capabilities.navigate) {
        capabilities.navigate(href);
      }
    },
    [
      groupFilter,
      activeWorktreeId,
      persistGroupFilter,
      setLastWorktree,
      getLastWorktree,
      groupOfWorktree,
      capabilities,
    ],
  );

  // The desktop shell's native menu (Cmd+,) calls `window.__bandOpenSettings()`
  // to pop this dialog. The native-menu path goes via webview.eval /
  // executeJavaScript — same pattern as the zoom menu. Register the global
  // unconditionally so the handler exists in the browser too (E2E + web shell),
  // even though only the desktop menu invokes it today.
  //
  // Multiple `DashboardShell` instances can be alive concurrently —
  // `MultiWorktreePanelHost` keeps every visited worktree mounted. They all
  // race to own the same window global: each mount overwrites the
  // previous registration. The cleanup must only delete the key if
  // we still own it; otherwise a stale unmount (worktree deletion or
  // worktree switch) wipes a newer instance's registration and
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

  // Listen for ⌃0 (Focus Side Bar) — the keyboard handler in the worktree
  // layout reveals the repo sidebar and dispatches this event; we move
  // keyboard focus into the repo list so arrow keys can navigate it.
  // Multi-worktree note: every DashboardShell instance receives the
  // event, but each focuses only its own subtree via rootRef. Inactive
  // worktrees are display:none-hidden upstream, so focus() on their
  // internal element is a no-op — only the visible instance wins.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = () => {
      const list = rootRef.current?.querySelector<HTMLElement>('[tabindex="-1"]');
      list?.focus({ preventScroll: true });
    };
    window.addEventListener("band:focus-repos", handler);
    return () => window.removeEventListener("band:focus-repos", handler);
  }, []);

  // Keyboard shortcuts: Cmd+0 → all repos, Cmd+1..9 → nth group.
  // ⌘ works from anywhere, like ⌘K: a worktree switch moves focus into the
  // terminal or editor (lib/leaf-focus.ts), and ⌘+digit types nothing there.
  // Ctrl skips editable elements, since a terminal sends Ctrl+3..8 to the
  // shell as control characters.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key < "0" || e.key > "9") return;

      const target = e.target as HTMLElement | null;
      if (target && !e.metaKey) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
          return;
        }
      }

      const digit = Number(e.key);
      if (digit === 0) {
        e.preventDefault();
        setGroupFilter(null);
        return;
      }
      const grp = groups[digit - 1];
      if (grp) {
        e.preventDefault();
        setGroupFilter(grp.id);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [groups, setGroupFilter]);

  // The command palette's "Show All Repos" (the ⌘0 entry above).
  useEffect(() => {
    const handler = () => setGroupFilter(null);
    window.addEventListener("band:show-all-repos", handler);
    return () => window.removeEventListener("band:show-all-repos", handler);
  }, [setGroupFilter]);

  return (
    <div
      ref={rootRef}
      className={cn(
        // `overflow-clip`, not `overflow-hidden`: a clipped box is no scroll container, so a
        // worktree card's `scrollIntoView` scrolls the repos panel and never shifts the column.
        "w-full overflow-clip flex flex-col text-foreground p-0",
        // Embedded as the repo-list sidebar (hideTitleBar): paint the
        // `--sidebar` surface so the list reads as a panel distinct from the
        // worktree layout. Under the translucent sidebar (macOS desktop) the
        // AppShell column already paints the tint, so stay transparent rather
        // than stack a second layer. Standalone (mobile / narrow web): plain
        // background.
        hideTitleBar ? "h-full bg-sidebar translucent-sidebar:bg-transparent" : "bg-background",
        !isDesktop && "pt-[env(safe-area-inset-top)]",
        // Full screen the action bar keeps a 16px gap above the bottom edge,
        // widened to the home-indicator inset when there is one. In the
        // wide-layout sidebar the AppShell column pads the inset instead.
        !isDesktop && !hideTitleBar && "pb-[max(1rem,env(safe-area-inset-bottom))]",
        !isDesktop && hideTitleBar && padBottomInset && "pb-[env(safe-area-inset-bottom)]",
      )}
      // CSS `zoom` does not scale viewport units (vh, dvh, svh, lvh) per
      // spec, so `height: 100dvh` under `<html style="zoom: 0.5">` resolves
      // to the viewport in CSS px and is then rendered at 50% — leaving the
      // dashboard half the visible height with a gap at the bottom. Divide
      // by the live app zoom factor (`--app-zoom`, set by applyZoomLevel in
      // apps/web/src/lib/zoom.ts) so the rendered height always matches the
      // actual viewport. The `hideTitleBar` branch is sized by its parent
      // (a layout panel with explicit pixel height) so it doesn't need
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

      <ReposPanel
        tall={matchMobileHeader}
        count={loading ? null : repos.length}
        actions={
          <div className="flex min-w-0 items-center gap-0.5">
            {admin.data?.admin ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="w-6 text-muted-foreground"
                    aria-label="Add repo"
                    data-testid="repos-panel__add-repo"
                    onClick={() => setAddingRepo(true)}
                  >
                    <Plus className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Add repo</TooltipContent>
              </Tooltip>
            ) : null}
            {repos.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="dashboard__group-filter-trigger"
                    className={`min-w-6 shrink max-w-[5rem] text-[11px] h-5 px-1.5 gap-1 ${groupFilter ? "bg-accent text-accent-foreground" : "text-foreground/75"}`}
                  >
                    {activeGroup ? (
                      <>
                        <span
                          className="size-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: activeGroup.color }}
                        />
                        <span className="truncate">{activeGroup.name}</span>
                      </>
                    ) : (
                      <>
                        <ListFilter className="size-3.5 shrink-0" />
                        <span className="truncate">All</span>
                      </>
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  collisionPadding={8}
                  data-testid="dashboard__group-filter-menu"
                >
                  <DropdownMenuItem
                    data-testid="dashboard__group-filter-item--all"
                    onClick={() => setGroupFilter(null)}
                  >
                    <ListFilter />
                    <span className="truncate">All</span>
                    {!groupFilter && <Check className="size-3 shrink-0" />}
                    <span className="ml-auto pl-3 text-xs text-muted-foreground tracking-widest">
                      ⌘0
                    </span>
                  </DropdownMenuItem>
                  {groups.map((grp, idx) => (
                    <DropdownMenuItem
                      key={grp.id}
                      data-testid={`dashboard__group-filter-item--${grp.id}`}
                      onClick={() => setGroupFilter(grp.id)}
                    >
                      <span
                        className="size-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: grp.color }}
                      />
                      <span className="truncate">{grp.name}</span>
                      {groupFilter === grp.id && <Check className="size-3 shrink-0" />}
                      {idx < 9 && (
                        <span className="ml-auto pl-3 text-xs text-muted-foreground tracking-widest">
                          ⌘{idx + 1}
                        </span>
                      )}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    data-testid="dashboard__group-filter-new-group"
                    onClick={() => setNamingGroup(true)}
                  >
                    <Plus />
                    <span>New group…</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {repos.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="w-6 text-muted-foreground"
                    aria-label={allCollapsed ? "Expand all" : "Collapse all"}
                    data-testid="repos-panel__toggle-all"
                    data-next-action={allCollapsed ? "expand" : "collapse"}
                    disabled={!hasCollapsible}
                    onClick={toggleAll}
                  >
                    {allCollapsed ? (
                      <ChevronsUpDown className="size-4" />
                    ) : (
                      <ChevronsDownUp className="size-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {allCollapsed ? "Expand all" : "Collapse all"}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        }
        onListClick={(e) => {
          const target = e.target as HTMLElement;
          if (target.closest("button, a, input, select, textarea, [tabindex]")) return;
          e.currentTarget
            .querySelector<HTMLElement>('[tabindex="-1"]')
            ?.focus({ preventScroll: true });
        }}
      >
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        ) : repos.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <FolderPlus className="size-8 text-muted-foreground/50" />
            <div>
              <p className="text-sm font-medium text-muted-foreground">No repos yet</p>
              <p className="text-xs text-muted-foreground/70 mt-1">
                Add a folder from a worker or a repo by its remote URL.
              </p>
            </div>
            {admin.data?.admin ? (
              <Button
                variant="outline"
                size="sm"
                data-testid="repo-list__add-repo"
                onClick={() => setAddingRepo(true)}
              >
                Add repo
              </Button>
            ) : null}
          </div>
        ) : (
          <RepoList groupFilter={groupFilter} />
        )}
      </ReposPanel>
      <GroupNameDialog
        open={namingGroup}
        onOpenChange={setNamingGroup}
        title="New group"
        submitLabel="Create"
        onSubmit={(name) => createGroup.mutate({ name })}
      />
      <AddRepoDialog
        open={addingRepo}
        onOpenChange={setAddingRepo}
        onOpenHosts={() => {
          setAddingRepo(false);
          setSettingsHosts(true);
          setShowSettingsDialog(true);
        }}
      />

      {(cliState.status === "manual" || cliState.status === "conflict") && (
        <div className="mx-4 mb-2 px-4 py-2 bg-info-bg border border-info/30 rounded-lg text-sm flex items-center justify-between gap-2">
          <span className="text-info">
            {cliState.status === "conflict"
              ? "A different `band` binary exists — replace it to use the bundled CLI"
              : `Install band CLI${cliState.status === "manual" && cliState.reason ? ` — ${cliState.reason}` : ""}`}
          </span>
          <Button variant="outline" size="sm" className="shrink-0 text-xs" onClick={installCli}>
            Install
          </Button>
        </div>
      )}

      {hooksSetup.visible && (
        <div
          role="status"
          data-testid="hooks-banner"
          className="mx-4 mb-2 px-4 py-2 bg-info-bg border border-info/30 rounded-lg text-sm flex items-center justify-between gap-2"
        >
          <span className="text-info">
            To get notifications from agents running in a terminal, Claude Code hooks need to be
            installed.
            {hooksSetup.error ? ` ${hooksSetup.error}` : ""}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              disabled={hooksSetup.installing}
              data-testid="hooks-banner__install"
              onClick={hooksSetup.install}
            >
              Install
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Dismiss"
              data-testid="hooks-banner__dismiss"
              onClick={hooksSetup.dismiss}
            >
              <X className="size-4" />
            </Button>
          </span>
        </div>
      )}

      {/* Persistent bottom action bar. Left: a single Settings button (gear
          icon, tooltip "Settings") that opens the Settings dialog. Right: the
          Resources/Usage icons + 3-dot overflow supplied by the caller
          (`bottomActions` — a <ToolbarActionBar />), kept outside the
          `dashboard/` seam. */}
      <div
        ref={actionBarObstructionRef}
        className="shrink-0 flex h-9 items-center justify-between gap-1 border-t border-border px-2"
        data-testid="repo-list__action-bar"
      >
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                className="text-muted-foreground"
                aria-label="Settings"
                data-testid="repo-list__settings-button"
                onClick={handleSettingsClick}
              >
                <Settings className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Settings</TooltipContent>
          </Tooltip>
          <UpdateAvailableBadge />
        </div>
        <div className="flex items-center gap-0.5">{bottomActions}</div>
      </div>

      <DesktopViewerDialog />
      <SettingsPage
        open={showSettingsDialog}
        onOpenChange={setShowSettingsDialog}
        initialSection={settingsHosts ? "hosts" : undefined}
      />
    </div>
  );
}
