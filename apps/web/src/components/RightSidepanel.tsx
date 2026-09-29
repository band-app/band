import { ClientPluginHostProvider } from "@band-app/plugin-api/client";
import { useRouterState } from "@tanstack/react-router";
import {
  ChevronsDownUp,
  FilePlus,
  FolderOpen,
  FolderPlus,
  GitCompare,
  RefreshCw,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ChangeEntry,
  type ChangeSection,
  FileBrowser,
  type FileBrowserHandle,
  useDiffTarget,
  useWorkspacePath,
} from "@/dashboard";
import { countChangedPaths, useWorkspaceChanges } from "../hooks/useWorkspaceChanges";
import { clientStorage } from "../lib/client-state";
import { parseWorkspaceFromPath } from "../lib/parse-workspace";
import { clientPluginHost } from "../plugins/client-plugin-host";
import { PluginErrorBoundary } from "../plugins/PluginErrorBoundary";
import { useWorkspaceSideTabs } from "../plugins/use-plugin-slot";
import { ChangesSections } from "./ChangesSections";
import { CommitsPanel } from "./CommitsPanel";
import { DRAG_STYLE, NO_DRAG_STYLE } from "./DesktopTitleBar";
import { DiffTargetHeader } from "./DiffTargetHeader";
import { usePerWorkspaceState } from "./per-workspace-state-store";
import { getWorkspaceLeafActions } from "./WorkspaceCenterDockview";

// ---------------------------------------------------------------------------
// Active-tab persistence (Explorer | Changes | plugin tabs, one at a time)
// ---------------------------------------------------------------------------

/** A plugin tab is `plugin:<pluginId>.<tabId>` (see `useWorkspaceSideTabs`). */
type RightTab = "explorer" | "changes" | `plugin:${string}`;
const TAB_KEY = "band:right-sidepanel-tab";

function isRightTab(value: unknown): value is RightTab {
  return (
    value === "explorer" ||
    value === "changes" ||
    (typeof value === "string" && value.startsWith("plugin:"))
  );
}

function loadActiveTab(): RightTab {
  try {
    const stored = localStorage.getItem(TAB_KEY);
    return isRightTab(stored) ? stored : "explorer";
  } catch {
    return "explorer";
  }
}

function saveActiveTab(tab: RightTab): void {
  try {
    clientStorage.setItem(TAB_KEY, tab);
  } catch {}
}

// ---------------------------------------------------------------------------
// Tab button (label + optional count badge)
// ---------------------------------------------------------------------------

function TabButton({
  label,
  icon: Icon,
  active,
  onClick,
  badge,
  testid,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  onClick: () => void;
  badge?: number;
  testid: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      title={label}
      data-testid={testid}
      style={NO_DRAG_STYLE}
      // Same pill as the center tab strip (`.dockview-center-tabs` in
      // dockview-theme.css): grey when selected, lighter on hover.
      className={`flex h-7 min-w-0 max-w-[120px] flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors ${
        active
          ? "bg-accent text-foreground shadow-[inset_0_0_0_1px_var(--border)]"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground hover:shadow-[inset_0_0_0_1px_var(--border)]"
      }`}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
      {badge != null && badge > 0 && (
        <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-blue-500/20 px-1 text-[10px] font-medium text-blue-600 dark:text-blue-400">
          {badge}
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Explorer header (folder name + New File / New Folder / Refresh / Collapse)
// ---------------------------------------------------------------------------

function ExplorerHeaderButton({
  label,
  icon: Icon,
  onClick,
  testid,
}: {
  label: string;
  icon: React.FC<{ className?: string }>;
  onClick: () => void;
  testid: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      data-testid={testid}
      className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <Icon className="size-3.5" />
    </button>
  );
}

function ExplorerHeader({
  folderName,
  browserRef,
}: {
  folderName: string;
  browserRef: React.RefObject<FileBrowserHandle | null>;
}) {
  return (
    // The actions appear on hover or keyboard focus, as in VS Code; devices
    // without hover always show them.
    <div className="group flex h-7 shrink-0 items-center gap-1 pr-2 pl-3">
      <span className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {folderName}
      </span>
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
        <ExplorerHeaderButton
          label="New File"
          icon={FilePlus}
          onClick={() => browserRef.current?.startNewFile()}
          testid="explorer-header__new-file"
        />
        <ExplorerHeaderButton
          label="New Folder"
          icon={FolderPlus}
          onClick={() => browserRef.current?.startNewFolder()}
          testid="explorer-header__new-folder"
        />
        <ExplorerHeaderButton
          label="Refresh Explorer"
          icon={RefreshCw}
          onClick={() => void browserRef.current?.refresh()}
          testid="explorer-header__refresh"
        />
        <ExplorerHeaderButton
          label="Collapse Folders in Explorer"
          icon={ChevronsDownUp}
          onClick={() => browserRef.current?.collapseAll()}
          testid="explorer-header__collapse-all"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header row (tabs + actions). Sits in the title-bar row, level with the
// workspace title bar, so it is a window drag surface in the desktop app.
// ---------------------------------------------------------------------------

function SidepanelHeader({
  children,
  actions,
}: {
  children?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div
      className="flex h-[38px] shrink-0 items-stretch gap-1 border-b border-border pr-2"
      style={DRAG_STYLE}
      data-testid="right-sidepanel__header"
    >
      {children ? (
        <div role="tablist" className="flex min-w-0 flex-1 items-center gap-0.5 pl-1.5">
          {children}
        </div>
      ) : (
        <div className="flex-1" />
      )}
      {actions}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right sidepanel root
// ---------------------------------------------------------------------------

export function RightSidepanel({
  visible = true,
  headerActions,
}: {
  visible?: boolean;
  /** Controls at the right edge of the header row (open in editor, collapse). */
  headerActions?: React.ReactNode;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const workspaceId = parseWorkspaceFromPath(pathname);

  // Save a tab picked through `band:right-sidepanel-set-tab` here as well as
  // in the inner panel: the sidebar's PR badge picks the Checks tab and then
  // navigates, and the next workspace's panel (or the first one, when none
  // is shown yet) mounts with the saved tab.
  useEffect(() => {
    const handler = (e: Event) => {
      const tab = (e as CustomEvent<{ tab?: RightTab }>).detail?.tab;
      if (isRightTab(tab)) saveActiveTab(tab);
    };
    window.addEventListener("band:right-sidepanel-set-tab", handler);
    return () => window.removeEventListener("band:right-sidepanel-set-tab", handler);
  }, []);

  if (!workspaceId) {
    return (
      <div className="flex h-full flex-col" data-testid="right-sidepanel">
        <SidepanelHeader actions={headerActions} />
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
          <div className="flex flex-col items-center gap-2">
            <FolderOpen className="size-6 text-muted-foreground/30" />
            <p className="text-xs text-muted-foreground">No workspace selected</p>
          </div>
        </div>
      </div>
    );
  }

  // Keyed by workspaceId so the panel's per-workspace tree state resets cleanly
  // on a workspace switch instead of leaking across workspaces.
  return (
    <RightSidepanelInner
      key={workspaceId}
      workspaceId={workspaceId}
      visible={visible}
      headerActions={headerActions}
    />
  );
}

function RightSidepanelInner({
  workspaceId,
  visible,
  headerActions,
}: {
  workspaceId: string;
  visible: boolean;
  headerActions?: React.ReactNode;
}) {
  const [activeTab, setActiveTab] = useState<RightTab>(() => loadActiveTab());
  const pluginTabs = useWorkspaceSideTabs();
  const activePluginTab = pluginTabs.find((t) => `plugin:${t.key}` === activeTab);
  // A saved plugin tab whose plugin is disabled, or not listed yet, shows Explorer.
  const shownTab = activeTab.startsWith("plugin:") && !activePluginTab ? "explorer" : activeTab;
  useEffect(() => {
    saveActiveTab(activeTab);
  }, [activeTab]);

  // ⇧⌘E / ⇧⌘G (and the title-bar switcher) select a specific tab. The shell
  // dispatches `band:right-sidepanel-set-tab` alongside `band:show-right-panel`.
  useEffect(() => {
    const handler = (e: Event) => {
      const tab = (e as CustomEvent<{ tab?: RightTab }>).detail?.tab;
      if (isRightTab(tab)) setActiveTab(tab);
    };
    window.addEventListener("band:right-sidepanel-set-tab", handler);
    return () => window.removeEventListener("band:right-sidepanel-set-tab", handler);
  }, []);

  const workspacePath = useWorkspacePath(workspaceId);
  const fileBrowserRef = useRef<FileBrowserHandle>(null);
  // The worktree folder's name, as VS Code titles its Explorer.
  const folderName =
    workspacePath
      ?.replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() || "Explorer";
  const { compareBranch, setCompareBranch } = useDiffTarget(workspaceId);

  // The active file/diff leaf publishes its path here (see
  // WorkspaceCenterDockview's `useActiveFileTracking`); use it to highlight the
  // open file in the Explorer tree and the open diff in the Changes tree.
  const { currentFile } = usePerWorkspaceState(workspaceId);

  // Fetch the Changes sections for both the Changes tab badge and the lists.
  // Poll only while the panel is visible — react-resizable-panels keeps this
  // subtree mounted when collapsed, and each poll shells out to `git`.
  const changesQuery = useWorkspaceChanges(workspaceId, {
    enabled: visible,
    refetchInterval: visible ? 15_000 : false,
  });

  // The header's branch names outlive the result for one target: a new pick
  // changes the query key, and without this the current branch
  // would blank out until the new summary arrives.
  const [knownBranches, setKnownBranches] = useState<{
    workspaceId: string;
    headBranch: string;
    defaultBranch: string;
  } | null>(null);
  useEffect(() => {
    const data = changesQuery.data;
    if (data) {
      setKnownBranches({
        workspaceId,
        headBranch: data.headBranch,
        defaultBranch: data.defaultBranch,
      });
    }
  }, [changesQuery.data, workspaceId]);
  const branchInfo =
    changesQuery.data ?? (knownBranches?.workspaceId === workspaceId ? knownBranches : undefined);

  const changeCount = countChangedPaths(changesQuery.data);

  // Single-click opens a preview (italic, reused) leaf; double-click pins it.
  const openFile = useCallback(
    (path: string, pinned: boolean) =>
      getWorkspaceLeafActions(workspaceId)?.openFile(path, { preview: !pinned }),
    [workspaceId],
  );
  const openDiff = useCallback(
    (section: ChangeSection, entry: ChangeEntry, pinned: boolean) =>
      getWorkspaceLeafActions(workspaceId)?.openDiff(entry.path, {
        preview: !pinned,
        section,
        oldPath: entry.oldPath,
      }),
    [workspaceId],
  );
  const openSectionDiffs = useCallback(
    (section: ChangeSection) => getWorkspaceLeafActions(workspaceId)?.openSectionDiffs(section),
    [workspaceId],
  );

  // A file under an expanded commit in the Commits panel opens that file's
  // diff for the commit.
  const openCommitDiff = useCallback(
    (sha: string, path: string, pinned: boolean) =>
      getWorkspaceLeafActions(workspaceId)?.openCommitDiff(sha, path, { preview: !pinned }),
    [workspaceId],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="right-sidepanel">
      <SidepanelHeader actions={headerActions}>
        <TabButton
          label="Explorer"
          icon={FolderOpen}
          active={shownTab === "explorer"}
          onClick={() => setActiveTab("explorer")}
          testid="right-sidepanel__tab--explorer"
        />
        <TabButton
          label="Changes"
          icon={GitCompare}
          badge={changeCount}
          active={activeTab === "changes"}
          onClick={() => setActiveTab("changes")}
          testid="right-sidepanel__tab--changes"
        />
        {pluginTabs.map(({ key, slug, tab }) => (
          <TabButton
            key={key}
            label={tab.label}
            icon={tab.icon}
            active={activeTab === `plugin:${key}`}
            onClick={() => setActiveTab(`plugin:${key}`)}
            testid={`right-sidepanel__tab--${slug}`}
          />
        ))}
      </SidepanelHeader>

      <div className="min-h-0 flex-1 overflow-auto">
        {activePluginTab ? (
          <div
            className="flex h-full flex-col overflow-hidden"
            data-testid={`right-sidepanel__plugin--${activePluginTab.slug}`}
          >
            <PluginErrorBoundary pluginId={activePluginTab.pluginId}>
              <ClientPluginHostProvider value={clientPluginHost}>
                <activePluginTab.tab.component workspaceId={workspaceId} visible={visible} />
              </ClientPluginHostProvider>
            </PluginErrorBoundary>
          </div>
        ) : shownTab === "explorer" ? (
          <div className="flex h-full flex-col" data-testid="right-sidepanel__explorer">
            <ExplorerHeader folderName={folderName} browserRef={fileBrowserRef} />
            <div className="min-h-0 flex-1">
              <FileBrowser
                ref={fileBrowserRef}
                workspaceId={workspaceId}
                workspacePath={workspacePath}
                onOpenFile={(p) => openFile(p, false)}
                onOpenFilePinned={(p) => openFile(p, true)}
                selectedFile={currentFile}
                // Keep open editor tabs pointed at renamed / moved paths, and
                // close the tabs of deleted ones.
                onPathRenamed={(oldPath, newPath) =>
                  getWorkspaceLeafActions(workspaceId)?.onPathMoved(oldPath, newPath)
                }
                onPathDeleted={(path) => getWorkspaceLeafActions(workspaceId)?.onPathRemoved(path)}
                // Match the ChangesFileTree row size (text-[13px] / h-28) so the
                // Explorer and Changes trees read identically in the sidepanel.
                compact
              />
            </div>
          </div>
        ) : (
          <div
            className="flex h-full flex-col overflow-hidden"
            data-testid="right-sidepanel__changes"
          >
            {/* Current branch and compare branch. Picking a branch updates the
                shared diff target; the changes query above is keyed on
                compareBranch, so it refetches automatically. */}
            <DiffTargetHeader
              workspaceId={workspaceId}
              headBranch={branchInfo?.headBranch}
              defaultBranch={branchInfo?.defaultBranch}
              compareBranch={compareBranch}
              onSelectBranch={setCompareBranch}
            />
            <div className="min-h-0 flex-1 overflow-auto">
              <ChangesSections
                workspaceId={workspaceId}
                changes={changesQuery.data}
                onOpen={openDiff}
                onViewAll={openSectionDiffs}
                editable
                workspacePath={workspacePath}
                activeFile={currentFile}
              />
            </div>
            <CommitsPanel workspaceId={workspaceId} visible={visible} onOpenFile={openCommitDiff} />
          </div>
        )}
      </div>
    </div>
  );
}
