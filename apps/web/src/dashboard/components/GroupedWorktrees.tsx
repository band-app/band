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
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Circle,
  Palette,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useCapabilities } from "../context";
import type { CollapseState } from "../hooks/use-collapse-state";
import {
  type GroupedRow,
  type HostInfoLite,
  hostIdOf,
  hostLabel,
  type WorktreeEntry,
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
import { GroupColorPicker } from "./GroupColorPicker";
import { DragRow, GroupDropTarget, TopLevelDropZone } from "./SidebarDnd";
import { WorktreeCard } from "./WorktreeCard";

/** A child's status dot sits under its parent's name: the dot (8px) plus the card's gap (8px). */
const INDENT_PX = 16;
/**
 * Space left of a top-level card in its row. The card pads its dot 20px in, so 10 puts a grouped
 * row's dot under the group's name (header padding 12, dot 10, gap 8) and 6 puts a pin's dot under
 * "Pinned" inside the section's 8px padding. Rows with no group start at the edge, their dots 10px
 * further out than grouped ones.
 */
const LEAD_PX = { grouped: 10, pinned: 6, ungrouped: 0 } as const;

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

/** The sidebar's two layouts: worktrees under groups, or under their repos while no group exists. */
export type ListMode = "groups" | "repo";

type EntryCardProps = Pick<
  RowCardProps,
  | "hosts"
  | "statuses"
  | "branchStatuses"
  | "setupStatuses"
  | "onShowDeleteDialog"
  | "onTogglePinned"
> & {
  entry: WorktreeEntry;
  mode: ListMode;
  isFocused: boolean;
};

/** The card a worktree shows in the list. The drag preview renders the same one. */
export function WorktreeEntryCard({
  entry,
  mode,
  isFocused,
  hosts,
  statuses,
  branchStatuses,
  setupStatuses,
  onShowDeleteDialog,
  onTogglePinned,
}: EntryCardProps) {
  return (
    <WorktreeCard
      worktree={entry.worktree}
      repoName={entry.repo.name}
      defaultBranch={entry.repo.defaultBranch}
      repoKind={entry.repo.kind}
      status={statuses.get(entry.worktreeId)}
      branchStatus={branchStatuses.get(entry.worktreeId)}
      setupStatus={setupStatuses.get(entry.worktreeId)}
      isFocused={isFocused}
      onShowDeleteDialog={onShowDeleteDialog}
      showRepoName
      repoAvatar={entry.repo.avatar}
      hostTag={
        mode === "repo" || hostIdOf(entry.worktree) === "local"
          ? undefined
          : hostLabel(hostIdOf(entry.worktree), hosts)
      }
      allowedHostIds={entry.repo.allowedHostIds}
      chevronGutter
      onTogglePinned={onTogglePinned}
    />
  );
}

interface WorktreeRowViewProps extends RowCardProps {
  row: WorktreeRow;
  /** Position among the keyboard-navigable rows. */
  index: number;
  mode: ListMode;
}

/** One worktree row of the grouped list or of the Pinned section. */
export function WorktreeRowView({
  row,
  index,
  mode,
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
  const capabilities = useCapabilities();
  const openWorktree = useDashboardStore((s) => s.openWorktree);
  const selectParent = (worktreeId: string) => {
    const href = capabilities.getWorktreeHref?.(worktreeId);
    if (href && capabilities.navigate) capabilities.navigate(href);
    else openWorktree(worktreeId);
  };
  const testPrefix = row.pinned ? "repo-list__pinned-row" : "repo-list__grouped-row";
  const lead =
    LEAD_PX[row.pinned ? "pinned" : row.ungrouped ? "ungrouped" : "grouped"] +
    row.depth * INDENT_PX;
  return (
    <DragRow
      dndId={`${isPin ? "pin" : "wt"}:${entry.worktreeId}`}
      disabled={mode === "repo" && row.depth > 0}
      testId={`repo-list__drag-row--${entry.worktreeId}`}
      className={row.pinned ? undefined : "mr-2"}
      data={{
        kind: isPin ? "pin" : "wt",
        worktreeId: entry.worktreeId,
        repoName: entry.repo.name,
        hostId: hostIdOf(entry.worktree),
        inset: lead,
      }}
    >
      <div
        data-testid={`${testPrefix}--${entry.worktreeId}`}
        data-depth={row.depth}
        data-ungrouped={row.ungrouped || undefined}
        className="flex min-w-0 flex-col"
        style={{ paddingLeft: lead }}
      >
        <div className="relative min-w-0">
          <WorktreeEntryCard
            entry={entry}
            mode={mode}
            isFocused={index === focusedIndex}
            hosts={hosts}
            statuses={statuses}
            branchStatuses={branchStatuses}
            setupStatuses={setupStatuses}
            onShowDeleteDialog={onShowDeleteDialog}
            onTogglePinned={onTogglePinned}
          />
          {/* In the card's 20px left padding: a 12px icon 4px from the dot, the 20px hit area kept. */}
          {row.childCount > 0 && (
            <button
              type="button"
              aria-label={row.collapsed ? "Expand started worktrees" : "Collapse started worktrees"}
              aria-expanded={!row.collapsed}
              data-testid={`repo-list__origin-toggle--${entry.worktreeId}`}
              onClick={() => originCollapse.toggle(entry.worktreeId)}
              className="absolute left-0 top-1/2 z-10 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent/50"
            >
              <ChevronRight
                className={`size-3 transition-transform ${row.collapsed ? "" : "rotate-90"}`}
              />
            </button>
          )}
        </div>
        {row.fromParent && (
          <button
            type="button"
            data-testid={`repo-list__from-parent--${entry.worktreeId}`}
            title={`Open ${row.fromParent.name}`}
            onClick={() => selectParent(row.fromParent!.worktreeId)}
            className="ml-5 w-fit max-w-full truncate rounded px-1 text-left text-[11px] text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          >
            from {row.fromParent.name}
          </button>
        )}
        {row.parentRemoved && (
          <span
            data-testid={`repo-list__parent-removed--${entry.worktreeId}`}
            className="pl-5 text-[11px] text-muted-foreground"
          >
            parent removed
          </span>
        )}
      </div>
    </DragRow>
  );
}

/** What a group header's menu does. */
export interface GroupHeaderActions {
  onRename: (group: GroupDefinition) => void;
  onColor: (group: GroupDefinition, color: string) => void;
  onDelete: (group: GroupDefinition) => void;
  /** Moves the group one place up (-1) or down (1) in the order. */
  onMove: (group: GroupDefinition, delta: -1 | 1) => void;
  /** Starts a new worktree in the group (null for Ungrouped). */
  onAddWorktree: (groupId: string | null) => void;
}

/** A group header's context menu. */
function GroupHeaderMenu({
  header,
  group,
  actions,
  canMoveUp,
  canMoveDown,
}: {
  header: React.ReactNode;
  group: GroupDefinition;
  actions: GroupHeaderActions;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          data-testid="repo-list__group-action--rename"
          onClick={() => actions.onRename(group)}
        >
          <Pencil />
          Rename…
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="repo-list__group-action--move-up"
          disabled={!canMoveUp}
          onClick={() => actions.onMove(group, -1)}
        >
          <ArrowUp />
          Move up
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="repo-list__group-action--move-down"
          disabled={!canMoveDown}
          onClick={() => actions.onMove(group, 1)}
        >
          <ArrowDown />
          Move down
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger data-testid="repo-list__group-action--color">
            <Palette />
            Color
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <GroupColorPicker
              color={group.color}
              testId="repo-list__group-color"
              Swatch={ContextMenuItem}
              custom={false}
              onChange={(color) => actions.onColor(group, color)}
            />
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem
          data-testid="repo-list__group-action--delete"
          onClick={() => actions.onDelete(group)}
        >
          <Trash2 />
          Delete…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface GroupedWorktreesProps extends RowCardProps {
  rows: GroupedRow[];
  groupCollapse: CollapseState;
  groupActions: GroupHeaderActions;
  /** Every group id in order, so a menu knows which moves it can offer. */
  groupOrder: string[];
  /** Index of the first row of this list among the keyboard-navigable rows. */
  navStart: number;
}

/** The sidebar's group list: one flat, ordered list of group header and worktree rows. */
export function GroupedWorktrees({
  rows,
  groupCollapse,
  groupActions,
  groupOrder,
  navStart,
  ...cardProps
}: GroupedWorktreesProps) {
  let navIndex = navStart;
  return (
    <div className="flex flex-col gap-0.5" data-testid="repo-list__grouped--groups">
      {rows.map((row) => {
        if (row.kind === "group") {
          const toggleKey = row.groupId ?? "";
          const group: GroupDefinition | null =
            row.groupId && row.color ? { id: row.groupId, name: row.name, color: row.color } : null;
          const header = (
            <div key={row.key} className="group/header mt-1 flex items-center pr-2">
              <GroupDropTarget dndId={row.key} groupId={row.groupId}>
                {({ setNodeRef, over, zone, dragListeners, dragging }) => (
                  <button
                    ref={setNodeRef}
                    type="button"
                    data-testid={`repo-list__group-header--${toggleKey}`}
                    data-drop-zone={over ? (zone ?? "into") : undefined}
                    aria-expanded={!row.collapsed}
                    onClick={() => groupCollapse.toggle(toggleKey)}
                    {...dragListeners}
                    className={`relative flex h-9 min-w-0 flex-1 items-center gap-2 pl-3 pr-2 text-left transition-colors hover:bg-accent/50 ${
                      over && zone === "into" ? "bg-primary/20" : ""
                    } ${dragging ? "opacity-40" : ""}`}
                  >
                    {over && zone === "before" && (
                      <span className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-primary" />
                    )}
                    {over && zone === "after" && (
                      <span className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-primary" />
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
                    <span
                      data-testid={`repo-list__group-name--${toggleKey}`}
                      className="truncate text-[13px] font-semibold text-foreground/90"
                    >
                      {row.name}
                    </span>
                    <span
                      data-testid={`repo-list__group-count--${toggleKey}`}
                      className="ml-auto shrink-0 text-[11px] text-muted-foreground"
                    >
                      {row.count}
                    </span>
                    <ChevronRight
                      className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${
                        row.collapsed ? "" : "rotate-90"
                      }`}
                    />
                  </button>
                )}
              </GroupDropTarget>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`New worktree in ${row.name}`}
                data-testid={`repo-list__group-add--${toggleKey}`}
                onClick={() => groupActions.onAddWorktree(row.groupId)}
              >
                <Plus />
              </Button>
            </div>
          );
          if (!group) return header;
          return (
            <GroupHeaderMenu
              key={row.key}
              header={header}
              group={group}
              actions={groupActions}
              canMoveUp={groupOrder.indexOf(group.id) > 0}
              canMoveDown={groupOrder.indexOf(group.id) < groupOrder.length - 1}
            />
          );
        }
        const index = navIndex++;
        return (
          <WorktreeRowView key={row.key} row={row} index={index} mode="groups" {...cardProps} />
        );
      })}
      <TopLevelDropZone hidden={rows.some((r) => r.kind === "worktree" && r.ungrouped)} />
    </div>
  );
}
