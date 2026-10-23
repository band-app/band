import { Tooltip, TooltipContent, TooltipTrigger } from "@band-app/ui";
import { Star } from "lucide-react";

/** Marks a repo's root worktree. Sits after the title and never truncates. */
export function RootStar({ testId = "worktree-card__root-star" }: { testId?: string }) {
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label="Repository root"
          data-testid={testId}
          className="inline-flex shrink-0 items-center text-muted-foreground"
        >
          <Star className="size-3" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" data-testid="worktree-card__root-star-tooltip">
        Repository root
      </TooltipContent>
    </Tooltip>
  );
}
