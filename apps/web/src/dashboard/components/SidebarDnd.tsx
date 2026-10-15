import { useDraggable, useDroppable } from "@dnd-kit/core";
import { createContext, type ReactNode, useCallback, useContext } from "react";
import type { DropZone } from "../lib/sidebar-drop";

/** What the sidebar's drag layer knows about a draggable or droppable row. */
export interface SidebarDragData {
  kind: "wt" | "pin" | "host";
  worktreeId?: string;
  repoName?: string;
  hostId?: string;
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

/** A header that worktrees can be dropped on, to move them to its host. */
export function HostDropTarget({
  dndId,
  hostId,
  children,
}: {
  dndId: string;
  hostId: string;
  children: (props: { setNodeRef: (node: HTMLElement | null) => void; over: boolean }) => ReactNode;
}) {
  const { setNodeRef } = useDroppable({ id: dndId, data: { kind: "host", hostId } });
  const { overId } = useContext(DropIndicatorContext);
  return <>{children({ setNodeRef, over: overId === dndId })}</>;
}
