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
import { FolderOpen, GitCompare } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChangesFileTree,
  FileBrowser,
  type FileStatus,
  useAdapter,
  useDiffTarget,
  useWorkspacePath,
} from "@/dashboard";
import { parseWorkspaceFromPath } from "../lib/parse-workspace";
import { trpc } from "../lib/trpc-client";
import { usePerWorkspaceState } from "./per-workspace-state-store";
import { getWorkspaceLeafActions } from "./WorkspaceCenterDockview";

// Uncommitted sentinel for the diff-target <Select> (a Select needs a
// non-empty string value; `diffMode` "uncommitted" maps to this).
const UNCOMMITTED_VALUE = "__uncommitted__";

// Integration/staging branches floated to the top of the diff-target picker,
// mirroring DiffView's `STAGING_BRANCH_PRIORITY`. Matched case-insensitively;
// array order is the pin priority.
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
      className={`flex h-full w-[120px] items-center justify-center gap-1.5 border-b-2 px-2 text-xs font-medium transition-colors ${
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
// Right sidepanel root
// ---------------------------------------------------------------------------

export function RightSidepanel({ visible = true }: { visible?: boolean }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const workspaceId = parseWorkspaceFromPath(pathname);

  if (!workspaceId) {
    return (
      <div
        className="flex h-full items-center justify-center px-6 text-center"
        data-testid="right-sidepanel"
      >
        <div className="flex flex-col items-center gap-2">
          <FolderOpen className="size-6 text-muted-foreground/30" />
          <p className="text-xs text-muted-foreground">No workspace selected</p>
        </div>
      </div>
    );
  }

  // Keyed by workspaceId so the panel's per-workspace tree state resets cleanly
  // on a workspace switch instead of leaking across workspaces.
  return <RightSidepanelInner key={workspaceId} workspaceId={workspaceId} visible={visible} />;
}

function RightSidepanelInner({ workspaceId, visible }: { workspaceId: string; visible: boolean }) {
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
    queryFn: () => adapter.listWorkspaceBranches?.(workspaceId) ?? { branches: [] as string[] },
    enabled: visible && !!adapter.listWorkspaceBranches,
  });

  // Fetch the changes summary for both the Changes tab badge and the tree.
  // Poll only while the panel is visible — react-resizable-panels keeps this
  // subtree mounted when collapsed, and each poll shells out to `git`.
  const summaryQuery = useQuery({
    queryKey: ["rightSidepanelChanges", workspaceId, diffMode, compareBranch],
    queryFn: () =>
      trpc.workspace.getDiffSummary.query({
        workspaceId,
        diffMode,
        compareBranch: compareBranch ?? undefined,
      }),
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

  // Order branches like DiffView's target picker: staging-style branches first
  // (priority order), then the rest alphabetically.
  const { topSectionBranches, otherBranches } = useMemo(() => {
    const branchList = branchesQuery.data?.branches ?? [];
    const staging = STAGING_BRANCH_PRIORITY.map((name) =>
      branchList.find((b) => b.toLowerCase() === name),
    ).filter((b): b is string => b != null);
    const others = branchList
      .filter((b) => !staging.includes(b))
      .sort((a, b) => a.localeCompare(b));
    return { topSectionBranches: staging, otherBranches: others };
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
      <div role="tablist" className="flex h-9 shrink-0 border-b border-border">
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
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {activeTab === "explorer" ? (
          <div className="h-full" data-testid="right-sidepanel__explorer">
            <FileBrowser
              workspaceId={workspaceId}
              workspacePath={workspacePath}
              onOpenFile={(p) => openFile(p, false)}
              onOpenFilePinned={(p) => openFile(p, true)}
              selectedFile={currentFile}
              // Match the ChangesFileTree row size (text-[13px] / h-28) so the
              // Explorer and Changes trees read identically in the sidepanel.
              compact
            />
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
