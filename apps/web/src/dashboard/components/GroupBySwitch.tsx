import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@band-app/ui";
import { Check, ChevronDown, Layers, Plus } from "lucide-react";
import { useState } from "react";
import { useGroupMutations } from "../hooks/use-groups";
import { GROUP_BY_OPTIONS, useGroupBy } from "../lib/sidebar-grouping";
import { GroupNameDialog } from "./GroupDialogs";

/**
 * The Repos header's Group by dropdown: Groups, Repo, Origin or Host. Remembered per device. Its
 * "New group" item is how the first group is made from the sidebar.
 */
export function GroupBySwitch() {
  const [groupBy, setGroupBy] = useGroupBy();
  const [naming, setNaming] = useState(false);
  const { create } = useGroupMutations();
  const current = GROUP_BY_OPTIONS.find((option) => option.value === groupBy);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Group by: ${current?.label ?? groupBy}`}
            data-testid="repos-panel__group-by"
            className="h-5 shrink-0 gap-0.5 px-1 text-[11px] text-foreground/75"
          >
            <Layers className="size-3.5 shrink-0" />
            <span className="truncate">{current?.label}</span>
            <ChevronDown className="size-3 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {GROUP_BY_OPTIONS.map((option) => (
            <DropdownMenuItem
              key={option.value}
              data-testid={`repos-panel__group-by--${option.value}`}
              onClick={() => setGroupBy(option.value)}
            >
              <span>{option.label}</span>
              {groupBy === option.value && <Check className="ml-auto size-3 shrink-0" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem data-testid="repos-panel__new-group" onClick={() => setNaming(true)}>
            <Plus />
            <span>New group…</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <GroupNameDialog
        open={naming}
        onOpenChange={setNaming}
        title="New group"
        submitLabel="Create"
        onSubmit={(name) => create.mutate({ name })}
      />
    </>
  );
}
