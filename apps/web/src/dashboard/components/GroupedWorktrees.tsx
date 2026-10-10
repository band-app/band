import { ChevronRight, Folder } from "lucide-react";
import type { CollapseState } from "../hooks/use-collapse-state";
import type { GroupBy, GroupedRow } from "../lib/sidebar-grouping";
import type { DeleteDialogInfo, SetupStatus, WorktreeBranchStatus, WorktreeStatus } from "../types";
import { RepoAvatar } from "./RepoAvatar";
import { WorktreeCard } from "./WorktreeCard";

const INDENT_PX = 14;

interface GroupedWorktreesProps {
  mode: Exclude<GroupBy, "repo">;
  rows: GroupedRow[];
  originCollapse: CollapseState;
  hostCollapse: CollapseState;
  statuses: Map<string, WorktreeStatus>;
  branchStatuses: Map<string, WorktreeBranchStatus>;
  setupStatuses: Map<string, SetupStatus>;
  focusedIndex: number;
  onShowDeleteDialog: (info: DeleteDialogInfo) => void;
  onTogglePinned: (repo: string, name: string, currentlyPinned: boolean) => void;
}

/** The Origin and Host views of the sidebar: one flat, ordered list of header and worktree rows. */
export function GroupedWorktrees({
  mode,
  rows,
  originCollapse,
  hostCollapse,
  statuses,
  branchStatuses,
  setupStatuses,
  focusedIndex,
  onShowDeleteDialog,
  onTogglePinned,
}: GroupedWorktreesProps) {
  let navIndex = 0;
  return (
    <div className="flex flex-col gap-0.5 px-2" data-testid={`repo-list__grouped--${mode}`}>
      {rows.map((row) => {
        if (row.kind === "host") {
          return (
            <button
              key={row.key}
              type="button"
              data-testid={`repo-list__host-header--${row.hostId}`}
              data-status={row.status}
              aria-expanded={!row.collapsed}
              onClick={() => hostCollapse.toggle(row.key)}
              className="mt-1 flex h-8 w-full items-center gap-2 rounded pl-1 pr-2 text-left transition-colors first:mt-0 hover:bg-accent/50"
            >
              <ChevronRight
                className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${
                  row.collapsed ? "" : "rotate-90"
                }`}
              />
              <span className="truncate text-[13px] font-semibold text-foreground/90">
                {row.name}
              </span>
              <span
                data-testid={`repo-list__host-state--${row.hostId}`}
                className={`ml-auto flex shrink-0 items-center gap-1 text-[11px] ${
                  row.status === "online" ? "text-muted-foreground" : "text-amber-500"
                }`}
              >
                <span
                  className={`size-1.5 rounded-full ${
                    row.status === "online" ? "bg-emerald-500" : "bg-amber-500"
                  }`}
                />
                {row.status}
              </span>
            </button>
          );
        }
        if (row.kind === "repo") {
          return (
            <button
              key={row.key}
              type="button"
              data-testid={`repo-list__host-repo-header--${row.hostId}--${row.repo.name}`}
              aria-expanded={!row.collapsed}
              onClick={() => hostCollapse.toggle(row.key)}
              className="flex h-7 w-full items-center gap-2 rounded pl-4 pr-2 text-left transition-colors hover:bg-accent/50"
            >
              <RepoAvatar
                avatar={row.repo.avatar}
                className="size-3.5"
                fallback={<Folder className="size-3.5 shrink-0 text-muted-foreground" />}
              />
              <span className="truncate text-[12px] font-semibold text-foreground/80">
                {row.repo.name}
              </span>
              <ChevronRight
                className={`ml-auto size-3 shrink-0 text-muted-foreground transition-transform ${
                  row.collapsed ? "" : "rotate-90"
                }`}
              />
            </button>
          );
        }
        const { entry } = row;
        const index = navIndex++;
        return (
          <div
            key={row.key}
            data-testid={`repo-list__grouped-row--${entry.worktreeId}`}
            data-depth={row.depth}
            className="flex min-w-0 flex-col"
            style={{ paddingLeft: row.depth * INDENT_PX + (mode === "host" ? 12 : 0) }}
          >
            <div className="flex min-w-0 items-center">
              {mode === "origin" &&
                (row.childCount > 0 ? (
                  <button
                    type="button"
                    aria-label={
                      row.collapsed ? "Expand started worktrees" : "Collapse started worktrees"
                    }
                    aria-expanded={!row.collapsed}
                    data-testid={`repo-list__origin-toggle--${entry.worktreeId}`}
                    onClick={() => originCollapse.toggle(entry.worktreeId)}
                    className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent/50"
                  >
                    <ChevronRight
                      className={`size-3.5 transition-transform ${row.collapsed ? "" : "rotate-90"}`}
                    />
                  </button>
                ) : (
                  <span className="size-5 shrink-0" />
                ))}
              <div className="min-w-0 flex-1">
                <WorktreeCard
                  worktree={entry.worktree}
                  repoName={entry.repo.name}
                  defaultBranch={entry.repo.defaultBranch}
                  repoKind={entry.repo.kind}
                  status={statuses.get(entry.worktreeId)}
                  branchStatus={branchStatuses.get(entry.worktreeId)}
                  setupStatus={setupStatuses.get(entry.worktreeId)}
                  isFocused={index === focusedIndex}
                  onShowDeleteDialog={onShowDeleteDialog}
                  showRepoName={mode === "origin"}
                  onTogglePinned={onTogglePinned}
                />
              </div>
              {entry.repo.meta && mode === "origin" && <MetaBadge repoName={entry.repo.name} />}
            </div>
            {row.parentRemoved && (
              <span
                data-testid={`repo-list__parent-removed--${entry.worktreeId}`}
                className="pl-8 text-[11px] text-muted-foreground"
              >
                parent removed
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function MetaBadge({ repoName }: { repoName: string }) {
  return (
    <span
      data-testid={`repo-list__meta-badge--${repoName}`}
      className="ml-1 shrink-0 rounded border border-border px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
    >
      meta
    </span>
  );
}
