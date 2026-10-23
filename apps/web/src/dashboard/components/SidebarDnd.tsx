import { useDndContext, useDraggable, useDroppable } from "@dnd-kit/core";
import { createContext, type ReactNode, useCallback, useContext } from "react";
import type { DropZone } from "../lib/sidebar-drop";

/** What the sidebar's drag layer knows about a draggable or droppable row. */
export interface SidebarDragData {
  kind: "wt" | "pin" | "group" | "groupmove";
  worktreeId?: string;
  /** On a group header: the group, or null for Ungrouped. */
  groupId?: string | null;
  repoName?: string;
  hostId?: string;
  /** Space left of the card in its row (section lead plus nesting indent), which the drag preview keeps. */
  inset?: number;
}

export interface DropIndicator {
  overId: string | null;
  zone: DropZone | null;
}

export const DropIndicatorContext = createContext<DropIndicator>({ overId: null, zone: null });

/**
 * One draggable and droppable worktree row. The 8px mouse distance and the 250ms touch hold
 * come from the sensors on the `DndContext`, so a click or tap still opens the worktree.
 */
export function DragRow({
  dndId,
  data,
  disabled,
  className,
  style,
  testId,
  children,
}: {
  dndId: string;
  data: SidebarDragData;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  testId?: string;
  children: ReactNode;
}) {
  const drag = useDraggable({ id: dndId, data, disabled });
  const drop = useDroppable({ id: dndId, data });
  const { overId, zone } = useContext(DropIndicatorContext);
  const setRef = useCallback(
    (node: HTMLElement | null) => {
      drag.setNodeRef(node);
      drop.setNodeRef(node);
    },
    [drag.setNodeRef, drop.setNodeRef],
  );
  const shown = overId === dndId && !drag.isDragging ? zone : null;
  return (
    <div
      ref={setRef}
      data-testid={testId}
      data-dnd-id={dndId}
      data-drop-zone={shown ?? undefined}
      className={`relative [-webkit-touch-callout:none] ${drag.isDragging ? "opacity-40" : ""} ${
        shown === "into" ? "rounded-md bg-primary/15" : ""
      } ${className ?? ""}`}
      style={style}
      {...drag.listeners}
    >
      {shown === "before" && (
        <span className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 bg-primary" />
      )}
      {children}
      {shown === "after" && (
        <span className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-0.5 bg-primary" />
      )}
    </div>
  );
}

/**
 * A group header. Worktrees dropped on it move to that group, and the header itself drags above or
 * below another header to reorder the groups. `zone` is where the dragged header would land
 * relative to this one.
 */
export function GroupDropTarget({
  dndId,
  groupId,
  children,
}: {
  dndId: string;
  groupId: string | null;
  children: (props: {
    setNodeRef: (node: HTMLElement | null) => void;
    over: boolean;
    /** "into" for a worktree, "before" or "after" for a group header being reordered. */
    zone: DropZone | null;
    dragListeners: ReturnType<typeof useDraggable>["listeners"];
    dragging: boolean;
  }) => ReactNode;
}) {
  const drop = useDroppable({ id: dndId, data: { kind: "group", groupId } });
  const drag = useDraggable({
    id: `grouphdr:${groupId ?? "none"}`,
    data: { kind: "groupmove", groupId },
    disabled: groupId === null,
  });
  const { overId, zone } = useContext(DropIndicatorContext);
  const setNodeRef = useCallback(
    (node: HTMLElement | null) => {
      drop.setNodeRef(node);
      drag.setNodeRef(node);
    },
    [drop.setNodeRef, drag.setNodeRef],
  );
  const over = overId === dndId && !drag.isDragging;
  return (
    <>
      {children({
        setNodeRef,
        over,
        zone: over ? zone : null,
        dragListeners: drag.listeners,
        dragging: drag.isDragging,
      })}
    </>
  );
}

/**
 * The strip below the last group where a dragged worktree leaves its group and becomes a plain
 * top-level row. It keeps a fixed height so a drag never moves the rows, and it is not drawn while
 * top-level rows exist, because those take the drop themselves.
 */
export function TopLevelDropZone({ hidden }: { hidden: boolean }) {
  const { active } = useDndContext();
  const { setNodeRef } = useDroppable({
    id: "group:__top",
    data: { kind: "group", groupId: null },
  });
  const { overId } = useContext(DropIndicatorContext);
  const dragging = (active?.data.current as { kind?: string } | undefined)?.kind === "wt";
  if (hidden) return null;
  return (
    <div
      ref={setNodeRef}
      data-testid="repo-list__top-level-drop"
      data-drop-zone={overId === "group:__top" ? "into" : undefined}
      className={`mx-2 h-5 rounded border border-dashed text-center text-[11px] leading-[18px] text-muted-foreground ${
        dragging ? "" : "border-transparent"
      } ${overId === "group:__top" ? "bg-primary/20" : ""}`}
    >
      {dragging ? "Top level, no group" : null}
    </div>
  );
}
