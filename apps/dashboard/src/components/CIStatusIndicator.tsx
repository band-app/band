import { CIStatus } from "@/stores/dashboard-store";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CircleCheck, CircleAlert, Loader } from "lucide-react";

interface Props {
  ci: CIStatus;
}

export function CIStatusIndicator({ ci }: Props) {
  if (ci.state === "success") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <CircleCheck className="size-3 shrink-0 text-green-400" />
        </TooltipTrigger>
        <TooltipContent>CI passed</TooltipContent>
      </Tooltip>
    );
  }

  if (ci.state === "failure") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <CircleAlert className="size-3 shrink-0 text-red-400" />
        </TooltipTrigger>
        <TooltipContent>CI failed</TooltipContent>
      </Tooltip>
    );
  }

  if (ci.state === "running" || ci.state === "pending") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Loader className="size-3 shrink-0 text-yellow-400 animate-spin" />
        </TooltipTrigger>
        <TooltipContent>{ci.state === "running" ? "CI running" : "CI pending"}</TooltipContent>
      </Tooltip>
    );
  }

  return null;
}
