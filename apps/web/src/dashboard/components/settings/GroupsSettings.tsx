import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@band-app/ui";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useGroupMutations, useGroups } from "../../hooks/use-groups";
import { useRepos } from "../../hooks/use-repos";
import { GROUP_COLOR_PRESETS } from "../../lib/group-colors";
import { moveGroupBy, moveGroupTo } from "../../lib/group-order";
import type { GroupDefinition } from "../../types";
import { GroupColorPopover } from "../GroupColorPicker";
import { DeleteGroupDialog } from "../GroupDialogs";
import { SettingsSection } from "./SettingsSection";

/** Why a name can't be saved, or null when it can. */
function nameProblem(name: string, others: readonly GroupDefinition[]): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "The name is empty.";
  if (others.some((g) => g.name.trim().toLowerCase() === trimmed.toLowerCase())) {
    return "A group with this name already exists.";
  }
  return null;
}

/**
 * The name as plain text until it is edited. Enter saves, Escape cancels, and a bad name marks the
 * field with an error icon and a tooltip instead of text under it.
 */
function NameField({
  initial,
  others,
  editing,
  onStart,
  onCommit,
  onCancel,
  testId,
}: {
  initial: string;
  others: readonly GroupDefinition[];
  editing: boolean;
  onStart: () => void;
  onCommit: (name: string) => void;
  onCancel: () => void;
  testId: string;
}) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  // Guards against a commit or cancel firing twice (Enter, then blur as the input unmounts).
  const done = useRef(false);
  useEffect(() => {
    if (editing) {
      setValue(initial);
      done.current = false;
      input.current?.focus();
      input.current?.select();
    }
  }, [editing, initial]);
  if (!editing) {
    return (
      <button
        type="button"
        data-testid={testId}
        onClick={onStart}
        className="min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left text-sm hover:bg-accent/50"
      >
        {initial}
      </button>
    );
  }
  const problem = value.trim() === initial ? null : nameProblem(value, others);
  const unchanged = value.trim() === initial;
  const finish = (fn: () => void) => {
    if (done.current) return;
    done.current = true;
    fn();
  };
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <Input
        ref={input}
        aria-label={`Name of group ${initial}`}
        aria-invalid={problem !== null}
        data-testid={`${testId}-input`}
        // Marks this field for the Settings dialog's `onEscapeKeyDown`, so Escape ends the edit
        // instead of closing the dialog. Radix's document-level Escape listener runs in the
        // capture phase, ahead of any handler on this input, so `stopPropagation` here would be
        // too late; the dialog is the one that has to hold off.
        data-settings-inline-edit
        value={value}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
        onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
          if (e.key === "Escape") {
            finish(onCancel);
          } else if (e.key === "Enter") {
            if (unchanged) finish(onCancel);
            else if (!problem) finish(() => onCommit(value.trim()));
          }
        }}
        onBlur={() => {
          if (!problem && !unchanged && value.trim()) finish(() => onCommit(value.trim()));
          else finish(onCancel);
        }}
        className="h-7 min-w-24 flex-1 text-sm"
      />
      {problem ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              role="img"
              aria-label={problem}
              data-testid="settings-groups__name-error"
              className="text-destructive"
            >
              <CircleAlert className="size-4" />
            </span>
          </TooltipTrigger>
          <TooltipContent>{problem}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}

function GroupRow({
  group,
  groups,
  index,
  onRename,
  onColor,
  onMove,
  onDelete,
}: {
  group: GroupDefinition;
  groups: readonly GroupDefinition[];
  index: number;
  onRename: (name: string) => void;
  onColor: (color: string) => void;
  onMove: (delta: -1 | 1) => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: group.id,
  });
  const [editing, setEditing] = useState(false);
  return (
    <div
      ref={setNodeRef}
      data-slot="settings-row"
      data-testid="settings-groups__row"
      data-group-id={group.id}
      tabIndex={0}
      onKeyDown={(e) => {
        if (!e.altKey || editing) return;
        if (e.key === "ArrowUp") {
          e.preventDefault();
          onMove(-1);
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          onMove(1);
        }
      }}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`flex items-center gap-2 bg-background px-3 py-2 outline-none focus-visible:ring-1 focus-visible:ring-ring ${
        isDragging ? "relative z-10 opacity-70 shadow-lg" : ""
      }`}
    >
      <button
        type="button"
        aria-label={`Drag ${group.name} to reorder`}
        data-testid="settings-groups__handle"
        className="flex size-6 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-accent/50"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4" />
      </button>
      <GroupColorPopover
        color={group.color}
        onChange={onColor}
        label={`Colour of ${group.name}`}
        testId="settings-groups__color"
        dotTestId="settings-groups__dot"
      />
      <NameField
        initial={group.name}
        others={groups.filter((g) => g.id !== group.id)}
        editing={editing}
        onStart={() => setEditing(true)}
        onCommit={(name) => {
          setEditing(false);
          onRename(name);
        }}
        onCancel={() => setEditing(false)}
        testId="settings-groups__name"
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Actions for ${group.name}`}
            data-testid="settings-groups__menu"
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
          <DropdownMenuItem data-testid="settings-groups__rename" onClick={() => setEditing(true)}>
            <Pencil />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="settings-groups__move-up"
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            <ArrowUp />
            Move up
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="settings-groups__move-down"
            disabled={index === groups.length - 1}
            onClick={() => onMove(1)}
          >
            <ArrowDown />
            Move down
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem data-testid="settings-groups__delete" onClick={onDelete}>
            <Trash2 />
            Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** The row for a group being created: a name field and the first preset no group uses. */
function NewGroupRow({
  color,
  groups,
  onCreate,
  onCancel,
}: {
  color: string;
  groups: readonly GroupDefinition[];
  onCreate: (name: string) => void;
  onCancel: () => void;
}) {
  return (
    <div
      data-slot="settings-row"
      data-testid="settings-groups__new-row"
      className="flex items-center gap-2 px-3 py-2"
    >
      <span className="size-6 shrink-0" />
      <span className="flex size-6 shrink-0 items-center justify-center">
        <span className="size-3 rounded-full" style={{ backgroundColor: color }} />
      </span>
      <NameField
        initial=""
        others={groups}
        editing
        onStart={() => {}}
        onCommit={onCreate}
        onCancel={onCancel}
        testId="settings-groups__new-name"
      />
    </div>
  );
}

/**
 * Settings > Groups: the worktree groups the sidebar lists, in the sidebar's order. Each change is
 * saved at once. A worktree is in one group, and deleting a group leaves its worktrees ungrouped.
 */
export function GroupsSettings() {
  const groups = useGroups();
  const { repos } = useRepos();
  const { create, update, remove, reorder } = useGroupMutations();
  const [drafting, setDrafting] = useState(false);
  const [deleting, setDeleting] = useState<GroupDefinition | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = groups.map((g) => g.id);

  const worktreeCount = (id: string) =>
    repos.reduce((n, r) => n + r.worktrees.filter((w) => w.groupId === id).length, 0);
  const unusedColor =
    GROUP_COLOR_PRESETS.find((p) => !groups.some((g) => g.color.toLowerCase() === p.value))
      ?.value ?? GROUP_COLOR_PRESETS[0].value;

  const onDragEnd = (event: DragEndEvent) => {
    if (!event.over) return;
    const next = moveGroupTo(ids, String(event.active.id), String(event.over.id));
    if (next) reorder.mutate({ ids: next });
  };
  const move = (id: string, delta: -1 | 1) => {
    const next = moveGroupBy(ids, id, delta);
    if (next) reorder.mutate({ ids: next });
  };

  return (
    <SettingsSection
      title="Groups"
      description="Sort worktrees in the sidebar. A worktree is in one group."
      action={
        <Button
          variant="outline"
          size="sm"
          data-testid="settings-groups__add"
          onClick={() => setDrafting(true)}
        >
          <Plus className="size-3" />
          New group
        </Button>
      }
    >
      <div data-testid="settings-groups">
        {groups.length === 0 && !drafting ? (
          <p
            data-slot="settings-row"
            data-testid="settings-groups__empty"
            className="px-4 py-3 text-sm text-muted-foreground"
          >
            No groups yet
          </p>
        ) : null}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            {groups.map((group, index) => (
              <GroupRow
                key={group.id}
                group={group}
                groups={groups}
                index={index}
                onRename={(name) => update.mutate({ id: group.id, name })}
                onColor={(color) => update.mutate({ id: group.id, color })}
                onMove={(delta) => move(group.id, delta)}
                onDelete={() => {
                  if (worktreeCount(group.id) === 0) remove.mutate({ id: group.id });
                  else setDeleting(group);
                }}
              />
            ))}
          </SortableContext>
        </DndContext>
        {drafting ? (
          <NewGroupRow
            color={unusedColor}
            groups={groups}
            onCreate={(name) => {
              setDrafting(false);
              create.mutate({ name, color: unusedColor });
            }}
            onCancel={() => setDrafting(false)}
          />
        ) : null}
      </div>
      <DeleteGroupDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        groupName={deleting?.name ?? ""}
        onConfirm={() => {
          if (deleting) remove.mutate({ id: deleting.id });
        }}
      />
    </SettingsSection>
  );
}
