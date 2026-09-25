import { Collapsible, CollapsibleContent, CollapsibleTrigger, cn } from "@band-app/ui";
import { ChevronDownIcon } from "lucide-react";
import { useMemo } from "react";
import type { ToolEntry } from "../chat/transcript";
import { diffLines } from "./diff-lines";
import { MessageResponse } from "./message";
import { ToolInput, ToolOutput } from "./tool";

type Status = "error" | "in-progress" | "complete";

function statusOf(entry: ToolEntry): Status {
  if (entry.status === "failed") return "error";
  if (entry.status === "pending" || entry.status === "in_progress") return "in-progress";
  return "complete";
}

function StatusDot({ status }: { status: Status }) {
  return (
    <span
      data-testid="tool-call__status-dot"
      data-status={status}
      className={cn(
        "size-2 shrink-0 rounded-full",
        status === "error" && "bg-red-500",
        status === "in-progress" && "animate-pulse bg-orange-500",
        status === "complete" && "bg-green-500",
      )}
    />
  );
}

/** Relative to the workspace when the path is inside it. */
function shortPath(path: string, cwd: string | undefined): string {
  return cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

function Diff({
  path,
  oldText,
  newText,
  cwd,
}: {
  path: string;
  oldText?: string | null;
  newText: string;
  cwd?: string;
}) {
  const lines = useMemo(() => diffLines(oldText, newText), [oldText, newText]);
  return (
    <div
      data-testid="tool-call__diff"
      className="overflow-hidden rounded-md border border-border/30"
    >
      <div className="border-b border-border/30 bg-muted/40 px-2 py-1 font-mono text-xs text-muted-foreground">
        {shortPath(path, cwd)}
        {!oldText && <span className="ml-2 text-green-600 dark:text-green-400">new file</span>}
      </div>
      <pre className="max-h-80 overflow-auto text-xs leading-5">
        {lines.map((line, i) =>
          line.kind === "gap" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no identity beyond position
            <div key={i} className="px-2 text-muted-foreground/60">
              ⋯ {line.skipped} unchanged {line.skipped === 1 ? "line" : "lines"}
            </div>
          ) : (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no identity beyond position
              key={i}
              className={cn(
                "whitespace-pre px-2",
                line.kind === "add" && "bg-green-500/15",
                line.kind === "del" && "bg-red-500/15",
              )}
            >
              <span className="select-none text-muted-foreground/60">
                {line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}
              </span>
              {line.text}
            </div>
          ),
        )}
      </pre>
    </div>
  );
}

/**
 * One ACP tool call: title and status, and on expand what the agent
 * reported: file diffs, text output, the raw input and output.
 */
export function ToolCall({ entry, cwd }: { entry: ToolEntry; cwd?: string }) {
  const status = statusOf(entry);
  const diffs = entry.content.filter((c) => c.type === "diff");
  const texts = entry.content.flatMap((c) =>
    c.type === "content" && c.content.type === "text" ? [c.content.text] : [],
  );
  const paths = [...new Set([...diffs.map((d) => d.path), ...entry.locations.map((l) => l.path)])];
  // Plans and thinking come back as prose; command output is raw text.
  const prose = entry.toolKind === "switch_mode" || entry.toolKind === "think";
  const hasBody =
    diffs.length > 0 ||
    texts.length > 0 ||
    entry.rawInput !== undefined ||
    entry.rawOutput !== undefined;

  return (
    <Collapsible
      data-testid="tool-call__container"
      data-status={status}
      className="group not-prose w-full rounded border border-border/30 bg-muted/20"
    >
      <CollapsibleTrigger
        className="flex w-full items-center justify-between gap-4 px-2 py-1.5"
        disabled={!hasBody}
      >
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot status={status} />
          <span className="truncate font-medium text-xs text-muted-foreground">{entry.title}</span>
          {paths.length > 0 && !entry.title.includes(shortPath(paths[0], cwd)) && (
            <span className="truncate text-xs text-muted-foreground/70">
              {paths.map((p) => shortPath(p, cwd)).join(", ")}
            </span>
          )}
        </div>
        {hasBody && (
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        )}
      </CollapsibleTrigger>

      <CollapsibleContent className="space-y-3 border-t border-border/30 px-3 py-2 text-popover-foreground">
        {diffs.map((d) => (
          <Diff key={d.path} path={d.path} oldText={d.oldText} newText={d.newText} cwd={cwd} />
        ))}
        {texts.map((text, i) =>
          prose ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: content blocks have no id
            <MessageResponse key={i}>{text}</MessageResponse>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: content blocks have no id
            <ToolOutput key={i} output={text.slice(0, 20_000)} errorText={undefined} />
          ),
        )}
        {diffs.length === 0 && texts.length === 0 && entry.rawInput !== undefined && (
          <ToolInput input={entry.rawInput} />
        )}
        {diffs.length === 0 && texts.length === 0 && entry.rawOutput !== undefined && (
          <ToolOutput output={entry.rawOutput} errorText={undefined} />
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
