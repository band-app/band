import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@band/ui";
import { getToolName } from "ai";
import { ChevronDownIcon, WrenchIcon } from "lucide-react";

import type { ToolGroupSegment } from "./group-parts";
import type { ToolPart } from "./tool";
import { ToolInput, ToolOutput } from "./tool";

const IN_PROGRESS_STATES = new Set<ToolPart["state"]>([
  "input-available",
  "input-streaming",
  "approval-requested",
  "approval-responded",
]);

const ERROR_STATES = new Set<ToolPart["state"]>(["output-error", "output-denied"]);

function formatToolTitle(name: string, input: ToolPart["input"]): string {
  if (!input || typeof input !== "object") return name;
  const record = input as Record<string, unknown>;
  const arg =
    record.command ??
    record.pattern ??
    record.query ??
    record.file_path ??
    record.url ??
    record.content;
  if (typeof arg === "string") {
    const summary = arg.length > 80 ? `${arg.slice(0, 80)}...` : arg;
    return `${name}(${summary})`;
  }
  return name;
}

function StatusDot({ state }: { state: ToolPart["state"] }) {
  if (ERROR_STATES.has(state)) {
    return <span className="size-2 shrink-0 rounded-full bg-red-500" />;
  }
  if (IN_PROGRESS_STATES.has(state)) {
    return <span className="size-2 shrink-0 animate-pulse rounded-full bg-orange-500" />;
  }
  return <span className="size-2 shrink-0 rounded-full bg-green-500" />;
}

export function ToolCallGroup({ segment }: { segment: ToolGroupSegment }) {
  const inProgress = segment.parts.filter((p) => IN_PROGRESS_STATES.has(p.part.state));
  const allDone = inProgress.length === 0;
  const errorCount = segment.parts.filter((p) => ERROR_STATES.has(p.part.state)).length;

  return (
    <Collapsible className="group/outer not-prose mb-4 w-full rounded border border-border/50">
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-4 p-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {allDone ? (
            <div className="flex items-center gap-2">
              <WrenchIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="font-medium text-sm text-muted-foreground">
                {segment.parts.length} tool{segment.parts.length !== 1 ? " calls" : " call"}{" "}
                completed
                {errorCount > 0 && ` (${errorCount} failed)`}
              </span>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <WrenchIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="font-medium text-sm text-muted-foreground">
                  {segment.parts.length} tool{segment.parts.length !== 1 ? " calls" : " call"}
                </span>
              </div>
              {inProgress.map((p) => {
                const title = formatToolTitle(getToolName(p.part), p.part.input);
                return (
                  <div key={p.part.toolCallId} className="flex items-center gap-2 pl-6">
                    <StatusDot state={p.part.state} />
                    <span className="truncate text-sm">{title}</span>
                  </div>
                );
              })}
            </>
          )}
        </div>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/outer:rotate-180" />
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="border-t border-border/50">
          {segment.parts.map((p) => (
            <ToolItem key={p.part.toolCallId} part={p.part} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolItem({ part }: { part: ToolPart }) {
  const title = formatToolTitle(getToolName(part), part.input);
  return (
    <Collapsible className="group/inner border-b border-border/50 last:border-b-0">
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-4 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot state={part.state} />
          <span className="truncate text-sm">{title}</span>
        </div>
        <ChevronDownIcon className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]/inner:rotate-180" />
      </CollapsibleTrigger>

      <CollapsibleContent className="space-y-4 px-4 pb-3 text-popover-foreground">
        <ToolInput input={part.input} />
        <ToolOutput output={part.output} errorText={part.errorText} />
      </CollapsibleContent>
    </Collapsible>
  );
}
