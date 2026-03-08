import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@band/ui";
import { ChevronDownIcon, WrenchIcon } from "lucide-react";

import { ToolInput, ToolOutput } from "./tool";

export interface ToolCallItem {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output: unknown;
  errorText?: string;
  isError: boolean;
  isInProgress: boolean;
}

export function formatToolTitle(name: string, input: unknown): string {
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

function StatusDot({ isError, isInProgress }: { isError: boolean; isInProgress: boolean }) {
  if (isError) {
    return <span className="size-2 shrink-0 rounded-full bg-red-500" />;
  }
  if (isInProgress) {
    return <span className="size-2 shrink-0 animate-pulse rounded-full bg-orange-500" />;
  }
  return <span className="size-2 shrink-0 rounded-full bg-green-500" />;
}

export function ToolCallGroup({ items }: { items: ToolCallItem[] }) {
  const inProgress = items.filter((item) => item.isInProgress);
  const allDone = inProgress.length === 0;
  const errorCount = items.filter((item) => item.isError).length;

  return (
    <Collapsible className="group/outer not-prose mb-4 w-full rounded border border-border/50">
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-4 p-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {allDone ? (
            <div className="flex items-center gap-2">
              <WrenchIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="font-medium text-sm text-muted-foreground">
                {items.length} tool{items.length !== 1 ? " calls" : " call"} completed
                {errorCount > 0 && ` (${errorCount} failed)`}
              </span>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <WrenchIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="font-medium text-sm text-muted-foreground">
                  {items.length} tool{items.length !== 1 ? " calls" : " call"}
                </span>
              </div>
              {inProgress.map((item) => {
                const title = formatToolTitle(item.toolName, item.input);
                return (
                  <div key={item.toolCallId} className="flex items-center gap-2 pl-6">
                    <StatusDot isError={item.isError} isInProgress={item.isInProgress} />
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
          {items.map((item) => (
            <ToolItem key={item.toolCallId} item={item} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolItem({ item }: { item: ToolCallItem }) {
  const title = formatToolTitle(item.toolName, item.input);
  return (
    <Collapsible className="group/inner border-b border-border/50 last:border-b-0">
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-4 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot isError={item.isError} isInProgress={item.isInProgress} />
          <span className="truncate text-sm">{title}</span>
        </div>
        <ChevronDownIcon className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]/inner:rotate-180" />
      </CollapsibleTrigger>

      <CollapsibleContent className="space-y-4 px-4 pb-3 text-popover-foreground">
        <ToolInput input={item.input} />
        <ToolOutput output={item.output} errorText={item.errorText} />
      </CollapsibleContent>
    </Collapsible>
  );
}
