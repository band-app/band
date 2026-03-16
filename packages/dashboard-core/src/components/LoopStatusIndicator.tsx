import { Tooltip, TooltipContent, TooltipTrigger } from "@band/ui";
import { Pause, Repeat } from "lucide-react";
import type { LoopStatusInfo } from "../types";

interface Props {
  loop?: LoopStatusInfo;
}

export function LoopStatusIndicator({ loop }: Props) {
  if (!loop) return null;

  // Only show for active states
  if (loop.status !== "running" && loop.status !== "paused") return null;

  const iterationLabel = `${loop.currentIteration}/${loop.maxIterations}`;

  if (loop.status === "paused") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-1">
            <Pause className="size-3 shrink-0 text-amber-400" />
            <span className="text-[10px] font-medium text-amber-400">{iterationLabel}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">Loop paused at iteration {iterationLabel}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1">
          <Repeat
            className="size-3 shrink-0 text-blue-400 animate-spin"
            style={{ animationDuration: "3s" }}
          />
          <span className="text-[10px] font-medium text-blue-400">{iterationLabel}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">Loop running — iteration {iterationLabel}</TooltipContent>
    </Tooltip>
  );
}
