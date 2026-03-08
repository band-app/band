import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@band/ui";
import { ChevronDownIcon } from "lucide-react";

import { MessageResponse } from "./message";
import { ToolInput, ToolOutput } from "./tool";

const MARKDOWN_OUTPUT_TOOLS = new Set(["ExitPlanMode"]);

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

export function ToolCall({ item }: { item: ToolCallItem }) {
  const title = formatToolTitle(item.toolName, item.input);

  const hasMarkdownOutput =
    MARKDOWN_OUTPUT_TOOLS.has(item.toolName) &&
    typeof item.output === "string" &&
    item.output.trim();

  return (
    <>
      <Collapsible className="group not-prose mb-4 w-full rounded border border-border/50">
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-4 p-3">
          <div className="flex min-w-0 items-center gap-2">
            <StatusDot isError={item.isError} isInProgress={item.isInProgress} />
            <span className="truncate font-medium text-sm">{title}</span>
          </div>
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>

        <CollapsibleContent className="space-y-4 border-t border-border/50 px-4 py-3 text-popover-foreground">
          <ToolInput input={item.input} />
          <ToolOutput output={item.output} errorText={item.errorText} />
        </CollapsibleContent>
      </Collapsible>
      {hasMarkdownOutput && <MessageResponse>{item.output as string}</MessageResponse>}
    </>
  );
}
