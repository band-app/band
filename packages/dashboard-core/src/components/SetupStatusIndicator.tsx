import { Tooltip, TooltipContent, TooltipTrigger } from "@band/ui";
import { CircleAlert, Loader } from "lucide-react";
import type { SetupStatus } from "../types";

interface Props {
  setup?: SetupStatus;
}

export function SetupStatusIndicator({ setup }: Props) {
  if (!setup) return null;

  if (setup.state === "running") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Loader className="size-3.5 shrink-0 text-blue-400 animate-spin" />
        </TooltipTrigger>
        <TooltipContent side="top">Setting up workspace...</TooltipContent>
      </Tooltip>
    );
  }

  if (setup.state === "failed") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <CircleAlert className="size-3.5 shrink-0 text-red-400" />
        </TooltipTrigger>
        <TooltipContent side="top">
          Setup failed{setup.error ? `: ${setup.error}` : ""}
        </TooltipContent>
      </Tooltip>
    );
  }

  return null;
}
