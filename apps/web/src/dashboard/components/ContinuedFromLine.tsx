import { type ContinuedFrom, formatAge } from "@band-app/shared/continuation";
import { Tooltip, TooltipContent, TooltipTrigger } from "@band-app/ui";
import { History } from "lucide-react";

import { useHostNames } from "../hooks/use-host-names";

/** "Continued from <host> · auto · checkpoint 4 min old": the record a continuation leaves on the new copy. */
export function continuedFromText(from: ContinuedFrom, hostName: string): string {
  return `Continued from ${hostName} · ${from.reason} · checkpoint ${formatAge(from.at - from.checkpointAt)} old`;
}

/** The record as an icon: the text is its accessible name and its tooltip. */
export function ContinuedFromIcon({ from, testId }: { from: ContinuedFrom; testId: string }) {
  const hostName = useHostNames();
  const text = continuedFromText(from, hostName(from.fromHostId));
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <span
          data-testid={testId}
          data-reason={from.reason}
          data-from-host={from.fromHostId}
          role="img"
          aria-label={text}
          className="flex shrink-0 items-center ml-auto pl-2 text-muted-foreground"
        >
          <History className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">{text}</TooltipContent>
    </Tooltip>
  );
}
