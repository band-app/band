import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { FolderOpen, GitCompare } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import {
  ChangesFileTree,
  FileBrowser,
  type FileStatus,
  useDiffTarget,
  useWorkspacePath,
} from "@/dashboard";
import { parseWorkspaceFromPath } from "../lib/parse-workspace";
import { trpc } from "../lib/trpc-client";
import { getWorkspaceLeafActions } from "./WorkspaceCenterDockview";

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

  const workspacePath = useWorkspacePath(workspaceId);
  const { diffMode, compareBranch } = useDiffTarget(workspaceId);

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
            />
          </div>
        ) : (
          <div className="h-full" data-testid="right-sidepanel__changes">
            {changeCount === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">No changes</p>
            ) : (
              <ChangesFileTree
                fileStatuses={fileStatuses}
                onSelectFile={(p) => openDiff(p, false)}
                onSelectFilePinned={(p) => openDiff(p, true)}
                workspacePath={workspacePath}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
