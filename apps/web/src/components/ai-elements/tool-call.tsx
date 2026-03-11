import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@band/ui";
import { ChevronDownIcon } from "lucide-react";

import { AskUserQuestion } from "./ask-user-question";
import { MessageResponse } from "./message";
import { ToolInput, ToolOutput } from "./tool";

function extractMarkdown(item: ToolCallItem): string | null {
  if (item.toolName === "ExitPlanMode") {
    const input = item.input as Record<string, unknown> | null | undefined;
    if (input && typeof input.plan === "string" && input.plan.trim()) {
      return input.plan;
    }
  }
  return null;
}

export interface ToolCallItem {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output: unknown;
  errorText?: string;
  isError: boolean;
  isInProgress: boolean;
  approvalId?: string;
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
  if (item.toolName === "AskUserQuestion" && item.approvalId && item.isInProgress) {
    const input = item.input as
      | {
          questions?: Array<{
            question: string;
            header?: string;
            options: Array<{ label: string; description?: string }>;
            multiSelect?: boolean;
          }>;
        }
      | undefined;
    const questions = input?.questions ?? [];
    return (
      <div className="not-prose mb-4">
        <AskUserQuestion questions={questions} approvalId={item.approvalId} />
      </div>
    );
  }

  const title = formatToolTitle(item.toolName, item.input);

  const markdown = extractMarkdown(item);

  return (
    <>
      <Collapsible className="group not-prose w-full rounded border border-border/50">
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-4 p-3">
          <div className="flex min-w-0 items-center gap-2">
            <StatusDot isError={item.isError} isInProgress={item.isInProgress} />
            <span className="truncate font-medium text-base">{title}</span>
          </div>
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>

        <CollapsibleContent className="space-y-4 border-t border-border/50 px-4 py-3 text-popover-foreground">
          <ToolInput input={item.input} />
          <ToolOutput output={item.output} errorText={item.errorText} />
        </CollapsibleContent>
      </Collapsible>
      {markdown && <MessageResponse>{markdown}</MessageResponse>}
    </>
  );
}
