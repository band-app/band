import { Tooltip, TooltipContent, TooltipTrigger } from "@band/ui";
import { Loader } from "lucide-react";
import type { TaskRunnerStatus } from "../types";

interface Props {
  taskStatus?: TaskRunnerStatus;
}

export function TaskRunningIndicator({ taskStatus }: Props) {
  if (!taskStatus || taskStatus.state !== "running") return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Loader className="size-3.5 shrink-0 text-purple-400 animate-spin" />
      </TooltipTrigger>
      <TooltipContent side="top">Task running...</TooltipContent>
    </Tooltip>
  );
}
