import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@band-app/ui";
import { useQuery } from "@tanstack/react-query";
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChangesFileTree,
  FileBrowser,
  type FileBrowserHandle,
  type FileStatus,
  useAdapter,
  useDiffTarget,
  useWorkspacePath,
} from "@/dashboard";
import { useDiffSummary } from "../hooks/useDiffSummary";
import { parseWorkspaceFromPath } from "../lib/parse-workspace";
import { DRAG_STYLE, NO_DRAG_STYLE } from "./DesktopTitleBar";
import { usePerWorkspaceState } from "./per-workspace-state-store";
import { getWorkspaceLeafActions } from "./WorkspaceCenterDockview";

// Uncommitted sentinel for the diff-target <Select> (a Select needs a
// non-empty string value; `diffMode` "uncommitted" maps to this).
const UNCOMMITTED_VALUE = "__uncommitted__";

// Integration/staging branches floated to the top of the diff-target picker,
// right after Uncommitted: they're the branches a user most often diffs
// against. Matched case-insensitively; array order is the pin priority.
const STAGING_BRANCH_PRIORITY = [
  "develop",
  "dev",
  "development",
  "stage",
  "staging",
  "integration",
  "release",
  "qa",
  "uat",
];

// ---------------------------------------------------------------------------
// Active-tab persistence (Explorer | Changes rendered as tabs, one at a time)
// ---------------------------------------------------------------------------

type RightTab = "explorer" | "changes";
const TAB_KEY = "band:right-sidepanel-tab";

function loadActiveTab(): RightTab {
  try {
    return localStorage.getItem(TAB_KEY) === "changes" ? "changes" : "explorer";
  } catch {
    return "explorer";
  }
}

function saveActiveTab(tab: RightTab): void {
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {}
}

/** Stable empty fileStatuses reference so a "no changes" render doesn't churn. */
const EMPTY_STATUSES: Record<string, FileStatus> = {};

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
  icon: React.FC<{ className?: string }>;
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
      data-testid={testid}
      style={NO_DRAG_STYLE}
      className={`flex h-full min-w-0 max-w-[120px] flex-1 items-center justify-center gap-1.5 border-b-2 px-2 text-xs font-medium transition-colors ${
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
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
        <div role="tablist" className="flex min-w-0 flex-1">
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
  useEffect(() => {
    saveActiveTab(activeTab);
  }, [activeTab]);

  // ⇧⌘E / ⇧⌘G (and the title-bar switcher) select a specific tab. The shell
  // dispatches `band:right-sidepanel-set-tab` alongside `band:show-right-panel`.
  useEffect(() => {
    const handler = (e: Event) => {
      const tab = (e as CustomEvent<{ tab?: RightTab }>).detail?.tab;
      if (tab === "explorer" || tab === "changes") setActiveTab(tab);
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
  const { diffMode, compareBranch, setDiffMode, setCompareBranch } = useDiffTarget(workspaceId);
  const adapter = useAdapter();

  // The active file/diff leaf publishes its path here (see
  // WorkspaceCenterDockview's `useActiveFileTracking`); use it to highlight the
  // open file in the Explorer tree and the open diff in the Changes tree.
  const { currentFile } = usePerWorkspaceState(workspaceId);

  // Branch list for the diff-target selector (Changes tab). Fetched once per
  // workspace while the panel is visible; the summary query below is already
  // keyed on diffMode/compareBranch, so switching the target refetches it.
  const branchesQuery = useQuery({
    queryKey: ["rightSidepanelBranches", workspaceId],
    queryFn: async (): Promise<{ branches: string[]; defaultBranch?: string }> =>
      (await adapter.listWorkspaceBranches?.(workspaceId)) ?? { branches: [] },
    enabled: visible && !!adapter.listWorkspaceBranches,
  });

  // Fetch the changes summary for both the Changes tab badge and the tree.
  // Poll only while the panel is visible — react-resizable-panels keeps this
  // subtree mounted when collapsed, and each poll shells out to `git`.
  const summaryQuery = useDiffSummary(workspaceId, {
    enabled: visible,
    refetchInterval: visible ? 15_000 : false,
  });

  // The server types `fileStatuses` values as plain `string`; the tree wants
  // the `FileStatus` union. Same runtime values — cast at this single seam.
  const fileStatuses = (summaryQuery.data?.fileStatuses ?? EMPTY_STATUSES) as Record<
    string,
    FileStatus
  >;
  const changeCount = Object.keys(fileStatuses).length;

  // Pinned above the separator: staging-style branches (priority order), then
  // the project's default branch. Everything else follows alphabetically.
  // Pinning the most common compare targets keeps them one click below
  // Uncommitted (#599). `listBranches` drops the default branch when it IS the
  // HEAD branch (no comparing against yourself), hence the `includes` guard.
  const { topSectionBranches, otherBranches } = useMemo(() => {
    const branchList = branchesQuery.data?.branches ?? [];
    const defaultBranch = branchesQuery.data?.defaultBranch;
    const pinned = STAGING_BRANCH_PRIORITY.map((name) =>
      branchList.find((b) => b.toLowerCase() === name),
    ).filter((b): b is string => b != null);
    if (defaultBranch && branchList.includes(defaultBranch) && !pinned.includes(defaultBranch)) {
      pinned.push(defaultBranch);
    }
    const others = branchList.filter((b) => !pinned.includes(b)).sort((a, b) => a.localeCompare(b));
    return { topSectionBranches: pinned, otherBranches: others };
  }, [branchesQuery.data]);

  const diffSelectValue =
    diffMode === "branch" && compareBranch ? compareBranch : UNCOMMITTED_VALUE;

  const handleDiffSelectChange = useCallback(
    (value: string) => {
      if (value === UNCOMMITTED_VALUE) {
        setDiffMode("uncommitted");
      } else {
        setDiffMode("branch");
        setCompareBranch(value);
      }
    },
    [setDiffMode, setCompareBranch],
  );

  // Single-click opens a preview (italic, reused) leaf; double-click pins it.
  const openFile = useCallback(
    (path: string, pinned: boolean) =>
      getWorkspaceLeafActions(workspaceId)?.openFile(path, { preview: !pinned }),
    [workspaceId],
  );
  const openDiff = useCallback(
    (path: string, pinned: boolean) =>
      getWorkspaceLeafActions(workspaceId)?.openDiff(path, { preview: !pinned }),
    [workspaceId],
  );

  // "Reset changes" in the Changes tree right-click menu — revert each path to
  // its diff-target baseline, then refresh the summary. Undefined when the
  // adapter can't revert (hides the menu item).
  const onRevertPaths = adapter.revertFile
    ? async (paths: string[]) => {
        const revert = adapter.revertFile;
        if (!revert) return;
        await Promise.allSettled(
          paths.map((p) =>
            revert.call(adapter, workspaceId, p, diffMode, compareBranch ?? undefined),
          ),
        );
        summaryQuery.refetch();
      }
    : undefined;

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="right-sidepanel">
      <SidepanelHeader actions={headerActions}>
        <TabButton
          label="Explorer"
          icon={FolderOpen}
          active={activeTab === "explorer"}
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
      </SidepanelHeader>

      <div className="min-h-0 flex-1 overflow-auto">
        {activeTab === "explorer" ? (
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
            {/* Diff-target selector: Uncommitted plus each branch. Changing it
                updates the shared diff target; the summary query above is keyed
                on diffMode/compareBranch, so it refetches automatically. */}
            <div className="shrink-0 border-b border-border px-2 py-1.5">
              <Select value={diffSelectValue} onValueChange={handleDiffSelectChange}>
                <SelectTrigger
                  data-testid="right-sidepanel__diff-target-select"
                  className="h-6 w-full gap-1 rounded-md border-0 bg-transparent px-1.5 text-xs font-medium text-foreground shadow-none hover:bg-accent [&>[data-slot=select-value]]:block [&>[data-slot=select-value]]:truncate"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    value={UNCOMMITTED_VALUE}
                    data-testid="right-sidepanel__diff-target-option-uncommitted"
                  >
                    Uncommitted
                  </SelectItem>
                  {topSectionBranches.map((branch) => (
                    <SelectItem key={branch} value={branch}>
                      {branch}
                    </SelectItem>
                  ))}
                  {topSectionBranches.length > 0 && otherBranches.length > 0 && <SelectSeparator />}
                  {otherBranches.map((branch) => (
                    <SelectItem key={branch} value={branch}>
                      {branch}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {changeCount === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">No changes</p>
              ) : (
                <ChangesFileTree
                  fileStatuses={fileStatuses}
                  onSelectFile={(p) => openDiff(p, false)}
                  onSelectFilePinned={(p) => openDiff(p, true)}
                  onRevertPaths={onRevertPaths}
                  workspacePath={workspacePath}
                  activeFile={currentFile}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
