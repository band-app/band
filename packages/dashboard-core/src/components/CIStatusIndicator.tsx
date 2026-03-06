import { CircleAlert, CircleCheck, GitMerge, Loader } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@band/ui";
import { useCapabilities } from "../context";
import type { CIStatus } from "../types";

interface Props {
  ci: CIStatus;
}

export function CIStatusIndicator({ ci }: Props) {
  const capabilities = useCapabilities();

  const handleOpenUrl = (url: string | undefined, e: React.MouseEvent) => {
    if (!url) return;
    e.stopPropagation();
    capabilities.openUrl?.(url);
  };

  const clickable = !!ci.url && !!capabilities.openUrl;
  const cursorClass = clickable ? "cursor-pointer" : "";

  if (ci.state === "merged") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <GitMerge
            className={`size-3 shrink-0 text-violet-400 ${cursorClass}`}
            onClick={(e) => handleOpenUrl(ci.url, e)}
          />
        </TooltipTrigger>
        <TooltipContent>Merged</TooltipContent>
      </Tooltip>
    );
  }

  if (ci.state === "success") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <CircleCheck
            className={`size-3 shrink-0 text-green-400 ${cursorClass}`}
            onClick={(e) => handleOpenUrl(ci.url, e)}
          />
        </TooltipTrigger>
        <TooltipContent>CI passed</TooltipContent>
      </Tooltip>
    );
  }

  if (ci.state === "failure") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <CircleAlert
            className={`size-3 shrink-0 text-red-400 ${cursorClass}`}
            onClick={(e) => handleOpenUrl(ci.url, e)}
          />
        </TooltipTrigger>
        <TooltipContent>CI failed</TooltipContent>
      </Tooltip>
    );
  }

  if (ci.state === "running" || ci.state === "pending") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Loader
            className={`size-3 shrink-0 text-yellow-400 animate-spin ${cursorClass}`}
            onClick={(e) => handleOpenUrl(ci.url, e)}
          />
        </TooltipTrigger>
        <TooltipContent>{ci.state === "running" ? "CI running" : "CI pending"}</TooltipContent>
      </Tooltip>
    );
  }

  return null;
}
