import { ClientPluginHostProvider } from "@band-app/plugin-api/client";
import { projectIdOfScope } from "@band-app/shared/scope-id";
import { useRouterState } from "@tanstack/react-router";
import {
  ChevronsDownUp,
  FilePlus,
  FolderOpen,
  FolderPlus,
  GitCompare,
  History,
  Package,
  RefreshCw,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ChangeEntry,
  type ChangeSection,
  FileBrowser,
  type FileBrowserHandle,
  PROJECT_SIDE_TABS,
  ProjectRepoTree,
  ProjectSideTab,
  type ProjectSideTabId,
  useDiffTarget,
  useWorktreePath,
} from "@/dashboard";
import { countChangedPaths, useWorktreeChanges } from "../hooks/useWorktreeChanges";
import { clientStorage } from "../lib/client-state";
import { useWorktreeFromPath } from "../lib/parse-worktree";
import { clientPluginHost } from "../plugins/client-plugin-host";
import { PluginErrorBoundary } from "../plugins/PluginErrorBoundary";
import { useWorktreeSideTabs } from "../plugins/use-plugin-slot";
import { ChangesSections } from "./ChangesSections";
import { CommitsPanel } from "./CommitsPanel";
import { DRAG_STYLE, NO_DRAG_STYLE } from "./DesktopTitleBar";
import { DiffTargetHeader } from "./DiffTargetHeader";
import { usePerWorktreeState } from "./per-worktree-state-store";
import { getWorktreeLeafActions } from "./WorktreeCenterDockview";

// ---------------------------------------------------------------------------
// Active-tab persistence (Explorer | Changes | plugin tabs, one at a time)
// ---------------------------------------------------------------------------

/**
 * A plugin tab is `plugin:<pluginId>.<tabId>` (see `useWorktreeSideTabs`). A project's folder view
 * has `project:<tab>` tabs instead of Changes and the plugin tabs, because the folder is no git
 * checkout of its own.
 */
type RightTab = "explorer" | "changes" | `plugin:${string}` | `project:${ProjectSideTabId}`;
const TAB_KEY = "band:right-sidepanel-tab";

function isRightTab(value: unknown): value is RightTab {
  return (
    value === "explorer" ||
    value === "changes" ||
    (typeof value === "string" && (value.startsWith("plugin:") || value.startsWith("project:")))
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

const PROJECT_LOCAL_DIRS = ["repos", "tasks"] as const;

const PROJECT_TAB_ICONS: Record<ProjectSideTabId, React.ComponentType<{ className?: string }>> = {
  repos: Package,
  activity: History,
};

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
  tooltip,
}: {
  label: string;
  /** A longer name for the hover hint, when the label is short. */
  tooltip?: string;
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
      title={tooltip ?? label}
      aria-label={tooltip ?? label}
      data-testid={testid}
      style={NO_DRAG_STYLE}
      // Same pill as the center tab strip (`.dockview-center-tabs` in
      // dockview-theme.css): grey when selected, lighter on hover.
      className={`flex h-7 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-xs font-medium transition-colors ${
        active
          ? "bg-accent text-foreground shadow-[inset_0_0_0_1px_var(--border)]"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground hover:shadow-[inset_0_0_0_1px_var(--border)]"
      }`}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="whitespace-nowrap">{label}</span>
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
// worktree title bar, so it is a window drag surface in the desktop app.
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
        // Tabs keep their labels; when they don't all fit, the strip scrolls sideways.
        <div
          role="tablist"
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto pl-1.5 [scrollbar-width:none]"
        >
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
  const worktreeId = useWorktreeFromPath(pathname);

  // Save a tab picked through `band:right-sidepanel-set-tab` here as well as
  // in the inner panel: the sidebar's PR badge picks the Checks tab and then
  // navigates, and the next worktree's panel (or the first one, when none
  // is shown yet) mounts with the saved tab.
  useEffect(() => {
    const handler = (e: Event) => {
      const tab = (e as CustomEvent<{ tab?: RightTab }>).detail?.tab;
      if (isRightTab(tab)) saveActiveTab(tab);
    };
    window.addEventListener("band:right-sidepanel-set-tab", handler);
    return () => window.removeEventListener("band:right-sidepanel-set-tab", handler);
  }, []);

  if (!worktreeId) {
    return (
      <div className="flex h-full flex-col" data-testid="right-sidepanel">
        <SidepanelHeader actions={headerActions} />
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
          <div className="flex flex-col items-center gap-2">
            <FolderOpen className="size-6 text-muted-foreground/30" />
            <p className="text-xs text-muted-foreground">No worktree selected</p>
          </div>
        </div>
      </div>
    );
  }

  // Keyed by worktreeId so the panel's per-worktree tree state resets cleanly
  // on a worktree switch instead of leaking across worktrees.
  return (
    <RightSidepanelInner
      key={worktreeId}
      worktreeId={worktreeId}
      visible={visible}
      headerActions={headerActions}
    />
  );
}

function RightSidepanelInner({
  worktreeId,
  visible,
  headerActions,
}: {
  worktreeId: string;
  visible: boolean;
  headerActions?: React.ReactNode;
}) {
  const [activeTab, setActiveTab] = useState<RightTab>(() => loadActiveTab());
  const projectId = projectIdOfScope(worktreeId);
  const allPluginTabs = useWorktreeSideTabs();
  // A project's folder is no git checkout, so it has no Changes and no plugin tabs (Checks).
  const pluginTabs = projectId ? [] : allPluginTabs;
  const activePluginTab = pluginTabs.find((t) => `plugin:${t.key}` === activeTab);
  const projectTab = projectId
    ? PROJECT_SIDE_TABS.find((t) => `project:${t.id}` === activeTab)
    : undefined;
  // A saved tab this view does not have (a disabled plugin's, Changes or a project tab in the
  // wrong kind of view) shows Explorer.
  const shownTab =
    (activeTab.startsWith("plugin:") && !activePluginTab) ||
    (activeTab.startsWith("project:") && !projectTab) ||
    (activeTab === "changes" && projectId)
      ? "explorer"
      : activeTab;
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

  const worktreePath = useWorktreePath(worktreeId);
  const fileBrowserRef = useRef<FileBrowserHandle>(null);
  // The worktree folder's name, as VS Code titles its Explorer.
  const folderName =
    worktreePath
      ?.replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() || "Explorer";
  const { compareBranch, setCompareBranch } = useDiffTarget(worktreeId);

  // The active file/diff leaf publishes its path here (see
  // WorktreeCenterDockview's `useActiveFileTracking`); use it to highlight the
  // open file in the Explorer tree and the open diff in the Changes tree.
  const { currentFile } = usePerWorktreeState(worktreeId);

  // Fetch the Changes sections for both the Changes tab badge and the lists.
  // Poll only while the panel is visible — react-resizable-panels keeps this
  // subtree mounted when collapsed, and each poll shells out to `git`.
  const changesQuery = useWorktreeChanges(worktreeId, {
    enabled: visible && !projectId,
    refetchInterval: visible ? 15_000 : false,
  });

  // The header's branch names outlive the result for one target: a new pick
  // changes the query key, and without this the current branch
  // would blank out until the new summary arrives.
  const [knownBranches, setKnownBranches] = useState<{
    worktreeId: string;
    headBranch: string;
    defaultBranch: string;
  } | null>(null);
  useEffect(() => {
    const data = changesQuery.data;
    if (data) {
      setKnownBranches({
        worktreeId,
        headBranch: data.headBranch,
        defaultBranch: data.defaultBranch,
      });
    }
  }, [changesQuery.data, worktreeId]);
  const branchInfo =
    changesQuery.data ?? (knownBranches?.worktreeId === worktreeId ? knownBranches : undefined);

  const changeCount = countChangedPaths(changesQuery.data);

  // Single-click opens a preview (italic, reused) leaf; double-click pins it.
  const openFile = useCallback(
    (path: string, pinned: boolean) =>
      getWorktreeLeafActions(worktreeId)?.openFile(path, { preview: !pinned }),
    [worktreeId],
  );
  const openDiff = useCallback(
    (section: ChangeSection, entry: ChangeEntry, pinned: boolean) =>
      getWorktreeLeafActions(worktreeId)?.openDiff(entry.path, {
        preview: !pinned,
        section,
        oldPath: entry.oldPath,
      }),
    [worktreeId],
  );
  const openSectionDiffs = useCallback(
    (section: ChangeSection) => getWorktreeLeafActions(worktreeId)?.openSectionDiffs(section),
    [worktreeId],
  );

  // A file under an expanded commit in the Commits panel opens that file's
  // diff for the commit.
  const openCommitDiff = useCallback(
    (sha: string, path: string, pinned: boolean) =>
      getWorktreeLeafActions(worktreeId)?.openCommitDiff(sha, path, { preview: !pinned }),
    [worktreeId],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="right-sidepanel">
      <SidepanelHeader actions={headerActions}>
        <TabButton
          label={projectId ? "Context" : "Explorer"}
          tooltip={
            projectId ? "Project context: files every agent of the project shares" : undefined
          }
          icon={FolderOpen}
          active={shownTab === "explorer"}
          onClick={() => setActiveTab("explorer")}
          testid="right-sidepanel__tab--explorer"
        />
        {projectId ? (
          PROJECT_SIDE_TABS.map((t) => (
            <TabButton
              key={t.id}
              label={t.label}
              icon={PROJECT_TAB_ICONS[t.id]}
              active={shownTab === `project:${t.id}`}
              onClick={() => setActiveTab(`project:${t.id}`)}
              testid={`right-sidepanel__tab--project-${t.id}`}
            />
          ))
        ) : (
          <TabButton
            label="Changes"
            icon={GitCompare}
            badge={changeCount}
            active={activeTab === "changes"}
            onClick={() => setActiveTab("changes")}
            testid="right-sidepanel__tab--changes"
          />
        )}
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
        {projectId && projectTab ? (
          <div
            className="flex h-full flex-col overflow-hidden"
            data-testid={`right-sidepanel__project--${projectTab.id}`}
          >
            {/* Its sections poll the hub, so a collapsed panel unmounts it. */}
            {visible && projectTab.id === "repos" ? (
              <ProjectRepoTree
                projectId={projectId}
                worktreeId={worktreeId}
                worktreePath={worktreePath}
                selectedFile={currentFile}
                onOpenFile={openFile}
                onPathRenamed={(oldPath, newPath) =>
                  getWorktreeLeafActions(worktreeId)?.onPathMoved(oldPath, newPath)
                }
                onPathDeleted={(path) => getWorktreeLeafActions(worktreeId)?.onPathRemoved(path)}
              />
            ) : visible ? (
              <ProjectSideTab projectId={projectId} tab={projectTab.id} />
            ) : null}
          </div>
        ) : activePluginTab ? (
          <div
            className="flex h-full flex-col overflow-hidden"
            data-testid={`right-sidepanel__plugin--${activePluginTab.slug}`}
          >
            <PluginErrorBoundary pluginId={activePluginTab.pluginId}>
              <ClientPluginHostProvider value={clientPluginHost}>
                <activePluginTab.tab.component worktreeId={worktreeId} visible={visible} />
              </ClientPluginHostProvider>
            </PluginErrorBoundary>
          </div>
        ) : shownTab === "explorer" ? (
          <div className="flex h-full flex-col" data-testid="right-sidepanel__explorer">
            <ExplorerHeader folderName={folderName} browserRef={fileBrowserRef} />
            <div className="min-h-0 flex-1">
              <FileBrowser
                ref={fileBrowserRef}
                worktreeId={worktreeId}
                worktreePath={worktreePath}
                onOpenFile={(p) => openFile(p, false)}
                onOpenFilePinned={(p) => openFile(p, true)}
                selectedFile={currentFile}
                // Keep open editor tabs pointed at renamed / moved paths, and
                // close the tabs of deleted ones.
                onPathRenamed={(oldPath, newPath) =>
                  getWorktreeLeafActions(worktreeId)?.onPathMoved(oldPath, newPath)
                }
                onPathDeleted={(path) => getWorktreeLeafActions(worktreeId)?.onPathRemoved(path)}
                // A project's context tree leaves out its repo checkouts (the Repos tab shows
                // them) and old task folders, neither of which syncs.
                hiddenRootNames={projectId ? PROJECT_LOCAL_DIRS : undefined}
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
              worktreeId={worktreeId}
              headBranch={branchInfo?.headBranch}
              defaultBranch={branchInfo?.defaultBranch}
              compareBranch={compareBranch}
              onSelectBranch={setCompareBranch}
            />
            <div className="min-h-0 flex-1 overflow-auto">
              <ChangesSections
                worktreeId={worktreeId}
                changes={changesQuery.data}
                onOpen={openDiff}
                onViewAll={openSectionDiffs}
                editable
                worktreePath={worktreePath}
                activeFile={currentFile}
              />
            </div>
            <CommitsPanel worktreeId={worktreeId} visible={visible} onOpenFile={openCommitDiff} />
          </div>
        )}
      </div>
    </div>
  );
}
