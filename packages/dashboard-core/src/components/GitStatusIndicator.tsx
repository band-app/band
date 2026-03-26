import { Tooltip, TooltipContent, TooltipTrigger } from "@band-app/ui";
import type { GitStatus } from "../types";

interface Props {
  git: GitStatus;
}

export function GitStatusIndicator({ git }: Props) {
  const parts: { text: string; color: string; tooltip: string }[] = [];

  if (git.conflict) {
    parts.push({ text: "!", color: "text-red-600 dark:text-red-400", tooltip: "Merge conflict" });
  } else if (git.dirty) {
    parts.push({
      text: "M",
      color: "text-yellow-600 dark:text-yellow-400",
      tooltip: "Uncommitted changes",
    });
  }

  if (git.sync_state === "ahead") {
    parts.push({
      text: `\u2191${git.ahead}`,
      color: "text-blue-600 dark:text-blue-400",
      tooltip: `${git.ahead} commit${git.ahead > 1 ? "s" : ""} ahead`,
    });
  } else if (git.sync_state === "behind") {
    parts.push({
      text: `\u2193${git.behind}`,
      color: "text-yellow-600 dark:text-yellow-400",
      tooltip: `${git.behind} commit${git.behind > 1 ? "s" : ""} behind`,
    });
  } else if (git.sync_state === "diverged") {
    parts.push({
      text: `\u2191${git.ahead}\u2193${git.behind}`,
      color: "text-orange-600 dark:text-orange-400",
      tooltip: `Diverged: ${git.ahead} ahead, ${git.behind} behind`,
    });
  }

  if (parts.length === 0) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-0.5 font-mono text-[11px] leading-none shrink-0">
          {parts.map((p) => (
            <span key={p.text} className={p.color}>
              {p.text}
            </span>
          ))}
        </span>
      </TooltipTrigger>
      <TooltipContent>{parts.map((p) => p.tooltip).join(", ")}</TooltipContent>
    </Tooltip>
  );
}
