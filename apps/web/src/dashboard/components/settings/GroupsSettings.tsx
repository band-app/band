import { Button, Input } from "@band-app/ui";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { useState } from "react";
import { useGroupMutations, useGroups } from "../../hooks/use-groups";
import { GROUP_COLOR_PRESETS } from "../../lib/group-colors";
import type { GroupDefinition } from "../../types";
import { DeleteGroupDialog, GroupNameDialog } from "../GroupDialogs";

/** The name field commits on Enter or blur, so a half-typed name is never saved. */
function GroupRow({
  group,
  index,
  count,
  onRename,
  onColor,
  onMove,
  onDelete,
}: {
  group: GroupDefinition;
  index: number;
  count: number;
  onRename: (name: string) => void;
  onColor: (color: string) => void;
  onMove: (direction: -1 | 1) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(group.name);
  const commit = () => {
    const trimmed = name.trim();
    if (!trimmed) setName(group.name);
    else if (trimmed !== group.name) onRename(trimmed);
  };
  return (
    <div
      data-slot="settings-row"
      data-testid="settings-groups__row"
      data-group-id={group.id}
      className="flex flex-wrap items-center gap-2 px-4 py-2.5"
    >
      <span
        data-testid="settings-groups__dot"
        className="size-3 shrink-0 rounded-full"
        style={{ backgroundColor: group.color }}
      />
      <Input
        aria-label={`Name of group ${group.name}`}
        data-testid="settings-groups__name"
        value={name}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="h-8 min-w-32 flex-1 text-sm"
      />
      <div className="flex items-center gap-1" role="group" aria-label={`Color of ${group.name}`}>
        {GROUP_COLOR_PRESETS.map((preset) => (
          <button
            key={preset.value}
            type="button"
            aria-label={preset.name}
            aria-pressed={group.color.toLowerCase() === preset.value}
            data-testid={`settings-groups__color--${preset.name.toLowerCase()}`}
            onClick={() => onColor(preset.value)}
            className={`size-5 rounded-full border-2 ${
              group.color.toLowerCase() === preset.value ? "border-primary" : "border-transparent"
            }`}
            style={{ backgroundColor: preset.value }}
          />
        ))}
        <input
          type="color"
          aria-label={`Custom color of ${group.name}`}
          data-testid="settings-groups__color-custom"
          value={group.color}
          onChange={(e) => onColor(e.target.value)}
          className="size-5 cursor-pointer rounded border-0 bg-transparent p-0"
        />
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Move ${group.name} up`}
        data-testid="settings-groups__move-up"
        disabled={index === 0}
        onClick={() => onMove(-1)}
      >
        <ArrowUp className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Move ${group.name} down`}
        data-testid="settings-groups__move-down"
        disabled={index === count - 1}
        onClick={() => onMove(1)}
      >
        <ArrowDown className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Delete group ${group.name}`}
        data-testid="settings-groups__delete"
        className="shrink-0 text-foreground hover:text-foreground"
        onClick={onDelete}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}

/**
 * Settings > Groups: the worktree groups the sidebar lists. Each change is saved at once. A
 * worktree is in one group, and deleting a group leaves its worktrees ungrouped.
 */
export function GroupsSettings() {
  const groups = useGroups();
  const { create, update, remove, reorder } = useGroupMutations();
  const [naming, setNaming] = useState(false);
  const [deleting, setDeleting] = useState<GroupDefinition | null>(null);

  const move = (index: number, direction: -1 | 1) => {
    const ids = groups.map((g) => g.id);
    const target = index + direction;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    reorder.mutate({ ids });
  };

  return (
    <div data-testid="settings-groups" className="overflow-hidden rounded-xl border border-border">
      {groups.length === 0 ? (
        <p
          data-slot="settings-row"
          data-testid="settings-groups__empty"
          className="px-4 py-3 text-sm text-muted-foreground"
        >
          No groups yet. Add one to sort worktrees in the sidebar.
        </p>
      ) : (
        groups.map((group, index) => (
          <GroupRow
            key={`${group.id}:${group.name}`}
            group={group}
            index={index}
            count={groups.length}
            onRename={(name) => update.mutate({ id: group.id, name })}
            onColor={(color) => update.mutate({ id: group.id, color })}
            onMove={(direction) => move(index, direction)}
            onDelete={() => setDeleting(group)}
          />
        ))
      )}
      <div data-slot="settings-row" className="flex items-center px-4 py-2.5">
        <Button
          variant="outline"
          size="sm"
          data-testid="settings-groups__add"
          onClick={() => setNaming(true)}
        >
          <Plus className="size-3" />
          Add group
        </Button>
      </div>
      <GroupNameDialog
        open={naming}
        onOpenChange={setNaming}
        title="New group"
        submitLabel="Create"
        onSubmit={(name) => create.mutate({ name })}
      />
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
    </div>
  );
}
