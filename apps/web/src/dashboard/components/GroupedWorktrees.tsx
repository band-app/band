import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@band-app/ui";
import { ChevronRight, Circle, Folder, Palette, Pencil, Plus, Trash2 } from "lucide-react";
import { useCapabilities } from "../context";
import { type CollapseState, UNGROUPED_KEY } from "../hooks/use-collapse-state";
import { GROUP_COLOR_PRESETS } from "../lib/group-colors";
import {
  type GroupBy,
  type GroupedRow,
  type HostInfoLite,
  hostIdOf,
  hostLabel,
  type WorktreeRow,
} from "../lib/sidebar-grouping";
import { useDashboardStore } from "../stores/index";
import type {
  DeleteDialogInfo,
  GroupDefinition,
  SetupStatus,
  WorktreeBranchStatus,
  WorktreeStatus,
} from "../types";
import { RepoAvatar } from "./RepoAvatar";
import { DragRow, GroupDropTarget, HostDropTarget } from "./SidebarDnd";
import { WorktreeCard } from "./WorktreeCard";

const INDENT_PX = 14;

export interface RowCardProps {
  originCollapse: CollapseState;
  hosts: HostInfoLite[];
  statuses: Map<string, WorktreeStatus>;
  branchStatuses: Map<string, WorktreeBranchStatus>;
  setupStatuses: Map<string, SetupStatus>;
  focusedIndex: number;
  onShowDeleteDialog: (info: DeleteDialogInfo) => void;
  onTogglePinned: (repo: string, name: string, currentlyPinned: boolean) => void;
}

interface WorktreeRowViewProps extends RowCardProps {
  row: WorktreeRow;
  /** Position among the keyboard-navigable rows. */
  index: number;
  mode: GroupBy;
  /** False when the row can't be dragged: the children of a pin outside the Origin view. */
  draggable: boolean;
}

/** One worktree row of the Origin or Host view, or of the Pinned section in any view. */
export function WorktreeRowView({
  row,
  index,
  mode,
  draggable,
  originCollapse,
  hosts,
  statuses,
  branchStatuses,
  setupStatuses,
  focusedIndex,
  onShowDeleteDialog,
  onTogglePinned,
}: WorktreeRowViewProps) {
  const { entry } = row;
  const isPin = row.pinned === true && row.depth === 0;
  const showToggle = mode === "origin" || mode === "groups" || row.pinned === true;
  const capabilities = useCapabilities();
  const openWorktree = useDashboardStore((s) => s.openWorktree);
  const selectParent = (worktreeId: string) => {
    const href = capabilities.getWorktreeHref?.(worktreeId);
    if (href && capabilities.navigate) capabilities.navigate(href);
    else openWorktree(worktreeId);
  };
  const showRepoName = mode !== "host" || row.pinned === true;
  const testPrefix = row.pinned ? "repo-list__pinned-row" : "repo-list__grouped-row";
  return (
    <DragRow
      dndId={`${isPin ? "pin" : "wt"}:${entry.worktreeId}`}
      data={{
        kind: isPin ? "pin" : "wt",
        worktreeId: entry.worktreeId,
        repoName: entry.repo.name,
        hostId: hostIdOf(entry.worktree),
      }}
      disabled={!draggable}
    >
      <div
        data-testid={`${testPrefix}--${entry.worktreeId}`}
        data-depth={row.depth}
        className="flex min-w-0 flex-col"
        style={{
          paddingLeft: row.depth * INDENT_PX + (mode === "host" && !row.pinned ? 12 : 0),
        }}
      >
        <div className="flex min-w-0 items-center">
          {showToggle &&
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
              showRepoName={showRepoName}
              repoAvatar={entry.repo.avatar}
              hostTag={
                mode === "repo" || (mode === "groups" && hostIdOf(entry.worktree) === "local")
                  ? undefined
                  : hostLabel(hostIdOf(entry.worktree), hosts)
              }
              allowedHostIds={entry.repo.allowedHostIds}
              onTogglePinned={onTogglePinned}
            />
          </div>
        </div>
        {row.fromParent && (
          <button
            type="button"
            data-testid={`repo-list__from-parent--${entry.worktreeId}`}
            title={`Open ${row.fromParent.name}`}
            onClick={() => selectParent(row.fromParent!.worktreeId)}
            className="ml-8 w-fit max-w-full truncate rounded px-1 text-left text-[11px] text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          >
            from {row.fromParent.name}
          </button>
        )}
        {row.parentRemoved && (
          <span
            data-testid={`repo-list__parent-removed--${entry.worktreeId}`}
            className="pl-8 text-[11px] text-muted-foreground"
          >
            parent removed
          </span>
        )}
      </div>
    </DragRow>
  );
}

/** What a group header's menu does. Absent in the other views. */
export interface GroupHeaderActions {
  onRename: (group: GroupDefinition) => void;
  onColor: (group: GroupDefinition, color: string) => void;
  onDelete: (group: GroupDefinition) => void;
  /** Starts a new worktree in the group (null for Ungrouped). */
  onAddWorktree: (groupId: string | null) => void;
}

interface GroupedWorktreesProps extends RowCardProps {
  mode: Exclude<GroupBy, "repo">;
  rows: GroupedRow[];
  hostCollapse: CollapseState;
  /** Groups view: the groups' collapsed state and menu actions. */
  groupCollapse?: CollapseState;
  groupActions?: GroupHeaderActions;
  /** Index of the first row of this list among the keyboard-navigable rows. */
  navStart: number;
}

/** The Origin and Host views of the sidebar: one flat, ordered list of header and worktree rows. */
export function GroupedWorktrees({
  mode,
  rows,
  hostCollapse,
  groupCollapse,
  groupActions,
  navStart,
  ...cardProps
}: GroupedWorktreesProps) {
  let navIndex = navStart;
  return (
    <div className="flex flex-col gap-0.5 px-2" data-testid={`repo-list__grouped--${mode}`}>
      {rows.map((row) => {
        if (row.kind === "group") {
          const toggleKey = row.groupId ?? UNGROUPED_KEY;
          const group: GroupDefinition | null =
            row.groupId && row.color ? { id: row.groupId, name: row.name, color: row.color } : null;
          const header = (
            <div key={row.key} className="group/header mt-1 flex items-center first:mt-0">
              <GroupDropTarget dndId={row.key} groupId={row.groupId}>
                {({ setNodeRef, over }) => (
                  <button
                    ref={setNodeRef}
                    type="button"
                    data-testid={`repo-list__group-header--${toggleKey}`}
                    data-drop-zone={over ? "into" : undefined}
                    aria-expanded={!row.collapsed}
                    onClick={() => {
                      if (!row.filtered) groupCollapse?.toggle(toggleKey);
                    }}
                    className={`flex h-8 min-w-0 flex-1 items-center gap-2 rounded pl-1 pr-2 text-left transition-colors hover:bg-accent/50 ${
                      over ? "bg-primary/20" : ""
                    }`}
                  >
                    {row.filtered ? (
                      <span className="size-3.5 shrink-0" />
                    ) : (
                      <ChevronRight
                        className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${
                          row.collapsed ? "" : "rotate-90"
                        }`}
                      />
                    )}
                    {row.color ? (
                      <span
                        data-testid={`repo-list__group-dot--${toggleKey}`}
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: row.color }}
                      />
                    ) : (
                      <Circle className="size-2.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate text-[13px] font-semibold text-foreground/90">
                      {row.name}
                    </span>
                    <span
                      data-testid={`repo-list__group-count--${toggleKey}`}
                      className="ml-auto shrink-0 text-[11px] text-muted-foreground"
                    >
                      {row.count}
                    </span>
                  </button>
                )}
              </GroupDropTarget>
              {groupActions && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`New worktree in ${row.name}`}
                  data-testid={`repo-list__group-add--${toggleKey}`}
                  onClick={() => groupActions.onAddWorktree(row.groupId)}
                >
                  <Plus />
                </Button>
              )}
            </div>
          );
          if (!group || !groupActions) return header;
          return (
            <ContextMenu key={row.key}>
              <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem
                  data-testid="repo-list__group-action--rename"
                  onClick={() => groupActions.onRename(group)}
                >
                  <Pencil />
                  Rename…
                </ContextMenuItem>
                <ContextMenuSub>
                  <ContextMenuSubTrigger data-testid="repo-list__group-action--color">
                    <Palette />
                    Color
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent>
                    {GROUP_COLOR_PRESETS.map((preset) => (
                      <ContextMenuItem
                        key={preset.value}
                        data-testid={`repo-list__group-color--${preset.name.toLowerCase()}`}
                        onClick={() => groupActions.onColor(group, preset.value)}
                      >
                        <span
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: preset.value }}
                        />
                        {preset.name}
                      </ContextMenuItem>
                    ))}
                  </ContextMenuSubContent>
                </ContextMenuSub>
                <ContextMenuItem
                  data-testid="repo-list__group-action--delete"
                  onClick={() => groupActions.onDelete(group)}
                >
                  <Trash2 />
                  Delete…
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        }
        if (row.kind === "host") {
          return (
            <HostDropTarget key={row.key} dndId={`host:${row.hostId}`} hostId={row.hostId}>
              {({ setNodeRef, over }) => (
                <button
                  ref={setNodeRef}
                  type="button"
                  data-testid={`repo-list__host-header--${row.hostId}`}
                  data-status={row.status}
                  data-drop-zone={over ? "into" : undefined}
                  aria-expanded={!row.collapsed}
                  onClick={() => hostCollapse.toggle(row.key)}
                  className={`mt-1 flex h-8 w-full items-center gap-2 rounded pl-1 pr-2 text-left transition-colors first:mt-0 hover:bg-accent/50 ${
                    over ? "bg-primary/20" : ""
                  }`}
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
                      row.status === "online" ? "text-muted-foreground" : "text-warning"
                    }`}
                  >
                    <span
                      className={`size-1.5 rounded-full ${
                        row.status === "online" ? "bg-success" : "bg-warning"
                      }`}
                    />
                    {row.status}
                  </span>
                </button>
              )}
            </HostDropTarget>
          );
        }
        if (row.kind === "repo") {
          return (
            <HostDropTarget key={row.key} dndId={`hostrepo:${row.key}`} hostId={row.hostId}>
              {({ setNodeRef, over }) => (
                <button
                  ref={setNodeRef}
                  type="button"
                  data-testid={`repo-list__host-repo-header--${row.hostId}--${row.repo.name}`}
                  data-drop-zone={over ? "into" : undefined}
                  aria-expanded={!row.collapsed}
                  onClick={() => hostCollapse.toggle(row.key)}
                  className={`flex h-7 w-full items-center gap-2 rounded pl-4 pr-2 text-left transition-colors hover:bg-accent/50 ${
                    over ? "bg-primary/20" : ""
                  }`}
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
              )}
            </HostDropTarget>
          );
        }
        const index = navIndex++;
        return (
          <WorktreeRowView
            key={row.key}
            row={row}
            index={index}
            mode={mode}
            draggable
            {...cardProps}
          />
        );
      })}
    </div>
  );
}
