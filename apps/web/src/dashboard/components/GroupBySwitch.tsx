import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@band-app/ui";
import { Check, ChevronDown, Layers } from "lucide-react";
import { GROUP_BY_OPTIONS, useGroupBy } from "../lib/sidebar-grouping";

/** The Repos header's Group by dropdown: Repo, Origin or Host. Remembered per device. */
export function GroupBySwitch() {
  const [groupBy, setGroupBy] = useGroupBy();
  const current = GROUP_BY_OPTIONS.find((option) => option.value === groupBy);
  return (
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
